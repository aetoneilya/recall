import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autofill, FALLBACK_BETA, type AutofillClient } from '../src/autofill.ts'
import { defaultDeck } from '../src/repo.ts'
import { addWord, listen, makeCtx, send, type TestCtx } from './helpers.ts'

const sense = (over: object = {}) => ({
  term: 'to frown', pos: 'verb', translations: ['хмуриться', 'насупиться'], ipa: '/fraʊn/',
  examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], note: 'frown at smb', cefr: 'B2', ...over,
})

function message(body: unknown, over: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body), citations: null }],
    usage: { input_tokens: 300, output_tokens: 120 },
    ...over,
  } as unknown as BetaMessage
}

// Records requests and answers with whatever `reply` returns (or throws).
function fake(reply: (body: MessageCreateParamsNonStreaming) => BetaMessage | Promise<BetaMessage>) {
  const calls: MessageCreateParamsNonStreaming[] = []
  const client: AutofillClient = { beta: { messages: { create: async (body) => (calls.push(body), reply(body)) } } }
  return { client, calls }
}

const run = (ctx: TestCtx, term = 'frowned', hint?: string) => autofill(ctx, ctx.user, defaultDeck(ctx.db, ctx.user.id, ctx.now()), { term, hint })

describe('autofill', () => {
  it('returns one validated contextual topic per sense, ready to save as word tags', async () => {
    const { client } = fake(() => message({ draft: sense({ tags: ['Topic/Feelings', 'claude', 'Topic/Work'] }),
      alternatives: [sense({ pos: 'noun', tags: ['Some book', 'Topic/Invalid'] })] }))
    const ctx = makeCtx({}, undefined, client)
    const r = await run(ctx)
    expect(r.draft.tags).toEqual(['Topic/Feelings'])
    expect(r.alternatives[0]!.tags).toBeUndefined()
    const saved = addWord(ctx, r.draft.term, r.draft)
    expect(saved.tags).toEqual(['Topic/Feelings'])
  })

  it('asks Claude with structured outputs, low effort and the server-side fallback, and normalises the draft', async () => {
    const { client, calls } = fake(() => message({ draft: sense(), alternatives: [sense({ term: 'frown', pos: 'noun', translations: ['хмурый взгляд'], cefr: 'Z9' }), sense()] }))
    const ctx = makeCtx({}, undefined, client)
    const existing = addWord(ctx, 'frown', { pos: 'verb' })
    const r = await run(ctx, 'frowned', 'the facial expression')
    const body = calls[0]!
    expect(body).toMatchObject({
      model: 'claude-opus-5-5', betas: [FALLBACK_BETA], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: 'Term: frowned\nHint: the facial expression' }],
    })
    expect(body.system).toMatch(/General American/)
    expect(body.max_tokens).toBeGreaterThanOrEqual(4000)
    expect(r.draft).toEqual({ term: 'to frown', pos: 'verb', translations: ['хмуриться', 'насупиться'], ipa: 'fraʊn', examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], note: 'frown at smb', cefr: 'B2' })
    // Alternatives: other senses only, invalid CEFR dropped.
    expect(r.alternatives).toEqual([{ term: 'frown', pos: 'noun', translations: ['хмурый взгляд'], ipa: 'fraʊn', examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], note: 'frown at smb', cefr: null }])
    expect(r.freqRank).toBe(2500)
    expect(r.duplicate?.id).toBe(existing.id)
    expect(ctx.db.prepare('SELECT calls, input_tokens, output_tokens FROM autofill_usage').get()).toEqual({ calls: 1, input_tokens: 300, output_tokens: 120 })
  })

  it('reports refusals, cut-off and malformed answers, timeouts and the daily limit', async () => {
    let next: () => BetaMessage = () => message({ draft: sense(), alternatives: [] })
    const { client } = fake(() => next())
    const ctx = makeCtx({ AUTOFILL_DAILY_LIMIT: '5' }, undefined, client)
    next = () => message('', { stop_reason: 'refusal', stop_details: { category: 'general_harms', explanation: null } as never })
    await expect(run(ctx)).rejects.toMatchObject({ status: 422, body: { category: 'general_harms' } })
    next = () => message('{"draft":', { stop_reason: 'max_tokens' })
    await expect(run(ctx)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/cut off/) })
    next = () => message('not json')
    await expect(run(ctx)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/malformed/) })
    next = () => {
      throw new Anthropic.APIConnectionTimeoutError()
    }
    await expect(run(ctx)).rejects.toMatchObject({ status: 504 })
    next = () => message({ draft: sense(), alternatives: [] })
    await expect(run(ctx)).resolves.toMatchObject({ draft: { term: 'to frown' } })
    // Five attempts today, failures included.
    await expect(run(ctx)).rejects.toMatchObject({ status: 429, body: { limit: 5 } })
    // A new study day resets the budget.
    ctx.clock.t = new Date('2026-10-22T09:00:00Z')
    await expect(run(ctx)).resolves.toBeTruthy()
  })
})

describe('words REST API', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  const api = async (method: string, p: string, body?: unknown) => {
    const r = body === undefined && method === 'GET' ? await fetch(`${url}/api${p}`) : await send(`${url}/api${p}`, method, body ?? {})
    return { status: r.status, body: (await r.json()) as any }
  }

  beforeAll(async () => {
    const { client } = fake(() => message({ draft: sense(), alternatives: [] }))
    ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' }, '2026-10-21T09:00:00Z', client)
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(async () => close())

  it('creates the English deck on first use and manages decks', async () => {
    const decks = (await api('GET', '/decks')).body.decks
    expect(decks).toMatchObject([{ name: 'English', targetLang: 'en', nativeLang: 'ru', forwardEnabled: true, reverseEnabled: true, reverseAfterDays: null,
      counts: { total: 0, active: 0, dropped: 0, learning: 0, known: 0, due: 0, new: 0 } }])
    expect((await api('POST', '/decks', { targetLang: 'en', nativeLang: 'ru' })).status).toBe(409)
    const de = await api('POST', '/decks', { targetLang: 'de', nativeLang: 'ru' })
    expect(de).toMatchObject({ status: 201, body: { deck: { name: 'German', targetLang: 'de' } } })
    const patched = await api('PATCH', `/decks/${decks[0].id}`, { reverseAfterDays: 7, newPerDay: 10 })
    expect(patched.body.deck).toMatchObject({ reverseAfterDays: 7, newPerDay: 10 })
    expect((await api('PATCH', `/decks/${decks[0].id}`, { reverseAfterDays: null })).body.deck.reverseAfterDays).toBeNull()
    expect((await api('PATCH', `/decks/${decks[0].id}`, { bogus: 1 })).status).toBe(400)
  })

  it('adds, reads, edits, dedupes (409 with the existing word) and deletes words', async () => {
    const created = await api('POST', '/words', { term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: '/fraʊn/', examples: [{ text: 'She frowned.' }] })
    expect(created.status).toBe(201)
    const w = created.body.word
    expect(w).toMatchObject({ term: 'to frown', status: 'active', createdBy: 'user', freqRank: 2500, deckName: 'English', ipa: 'fraʊn',
      cards: { forward: { state: 'new', enabled: true, retrievability: null }, reverse: { state: 'new' } } })

    const dup = await api('POST', '/words', { term: 'Frown', pos: 'verb', translations: ['морщиться'] })
    expect(dup.status).toBe(409)
    expect(dup.body.existing).toMatchObject({ id: w.id, term: 'to frown' })
    expect(dup.body.error).toMatch(/already/)
    expect((await api('POST', '/words', { term: 'x', pos: 'verb', translations: [] })).status).toBe(400)
    expect((await api('POST', '/words', { term: 'x', pos: 'thing', translations: ['a'] })).status).toBe(400)

    const patched = await api('PATCH', `/words/${w.id}`, { translations: ['хмуриться', 'морщиться'], cefr: 'B2' })
    expect(patched.body.word).toMatchObject({ translations: ['хмуриться', 'морщиться'], cefr: 'B2', term: 'to frown' })
    const detail = await api('GET', `/words/${w.id}`)
    expect(detail.body).toMatchObject({ word: { id: w.id, cards: { forward: { id: expect.any(String) } } }, logs: [] })

    const list = await api('GET', '/words?q=frown&sort=alpha&limit=5')
    expect(list.body).toMatchObject({ total: 1, words: [{ id: w.id }] })
    expect((await api('GET', '/words?sort=nonsense')).status).toBe(400)

    const susp = await api('POST', `/words/${w.id}/suspend`)
    expect(susp.body.word.cards).toMatchObject({ forward: { suspended: true }, reverse: { suspended: true } })
    const card = await api('POST', `/cards/${w.cards.forward.id}/unsuspend`)
    expect(card.body.card).toMatchObject({ id: w.cards.forward.id, suspended: false, summary: { direction: 'forward' } })

    expect((await api('DELETE', `/words/${w.id}`)).body).toEqual({ ok: true })
    expect((await api('GET', `/words/${w.id}`)).status).toBe(404)
  })

  it('drops and restores words, serves the queue, the dashboard and autofill', async () => {
    const a = ctx.db.prepare("SELECT id FROM decks WHERE target_lang = 'en'").get() as { id: string }
    addWord(ctx, 'bid', { deckId: a.id, at: new Date('2026-10-21T08:00:00Z') })
    const other = addWord(ctx, 'tenant', { deckId: a.id })
    expect((await api('POST', `/words/${other.id}/drop`)).body.word.status).toBe('rejected')
    expect((await api('GET', '/words?status=rejected')).body.words.map((x: { term: string }) => x.term)).toEqual(['tenant'])
    expect((await api('POST', `/words/${other.id}/restore`)).body.word.status).toBe('active')
    expect((await api('POST', `/words/${other.id}/drop`)).body.word.status).toBe('rejected')
    expect((await api('GET', '/inbox')).status).toBe(404)
    const q = await api('GET', '/queue')
    expect(q.body.items[0]).toMatchObject({ word: { term: 'bid' }, card: { direction: 'forward' }, deckName: 'English' })
    expect(q.body.items.some((i: any) => i.word?.term === 'tenant')).toBe(false)
    expect(q.body.inbox).toBeUndefined()

    const dash = await api('GET', '/dashboard')
    expect(dash.status).toBe(200)
    expect(dash.body).toMatchObject({ deck: { name: 'English' }, counts: { words: { active: 1, rejected: 1 } }, growth: expect.any(Array) })
    expect(dash.body.vocabulary.available).toEqual({ frequencies: true, test: true, scale: true })

    const fill = await api('POST', '/words/autofill', { term: 'frowned' })
    expect(fill).toMatchObject({ status: 200, body: { draft: { term: 'to frown', ipa: 'fraʊn' }, freqRank: 2500, duplicate: null } })
  })

  it('runs a vocabulary test over HTTP', async () => {
    const t = await api('POST', '/vocab-test', {})
    expect(t.status).toBe(201)
    expect(t.body.items.length).toBeGreaterThan(20)
    const r = await api('POST', `/vocab-test/${t.body.testId}/answers`, { answers: t.body.items.map((i: { id: string }) => ({ id: i.id, known: false })) })
    expect(r.body).toMatchObject({ estimate: 0, falseAlarmRate: 0, reliability: 'ok', valid: true })
    expect((await api('GET', '/vocab-tests')).body.tests).toMatchObject([{ id: t.body.testId, result: { estimate: 0 } }])
  })
})

describe('autofill off', () => {
  it('is 503 without ANTHROPIC_API_KEY', async () => {
    const ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' })
    ctx.autofill = undefined
    const s = await listen(ctx)
    const r = await send(`${s.url}/api/words/autofill`, 'POST', { term: 'frown' })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'autofill is not configured' })
    await s.close()
  })
})
