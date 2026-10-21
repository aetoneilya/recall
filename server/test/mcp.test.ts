import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bearer, callTool, listen, MCP_HEADERS, makeCtx, type TestCtx } from './helpers.ts'

const TOKEN = 'static-mcp-token'

describe('MCP tools', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  const call = (name: string, args: object = {}) => callTool(url, TOKEN, name, args)

  beforeAll(async () => {
    ctx = makeCtx({ MCP_TOKEN: TOKEN, OWNER_TELEGRAM_ID: '1001' })
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(async () => close())

  it('offers word tools only', async () => {
    const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: bearer(TOKEN) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const names = ((await r.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['add_words', 'get_leeches', 'get_word', 'list_decks', 'review_stats', 'search_words', 'set_word_status', 'update_word', 'vocabulary_profile'])
  })

  it('adds words to the inbox, reports duplicates, edits and approves', async () => {
    const added = await call('add_words', {
      words: [
        { term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], cefr: 'B2', source: 'Wuthering Heights' },
        { term: 'bid', pos: 'noun', translations: ['ставка'] },
      ],
    })
    expect(added.deck.name).toBe('English')
    expect(added.created.map((c: { term: string; status: string }) => [c.term, c.status])).toEqual([['to frown', 'inbox'], ['bid', 'inbox']])
    const frownId = added.created[0].id

    const again = await call('add_words', { words: [{ term: 'frown', pos: 'verb', translations: ['хмуриться', 'морщиться'] }] })
    expect(again.created).toEqual([])
    expect(again.duplicates).toEqual([{ index: 0, existingId: frownId, existingStatus: 'inbox', term: 'to frown', pos: 'verb', differs: { newTranslations: ['морщиться'], term: { existing: 'to frown', proposed: 'frown' } } }])
    expect((await call('add_words', { words: [{ term: 'x', pos: 'noun', translations: [] }] })).error).toMatch(/translations/)

    const updated = await call('update_word', { id: frownId, translations: ['хмуриться', 'морщиться'], note: null })
    expect(updated).toMatchObject({ term: 'to frown', translations: ['хмуриться', 'морщиться'], status: 'inbox' })
    const word = await call('get_word', { id: frownId })
    expect(word.faces.reverse.front).toMatchObject({ example: 'She ___ at him.', translations: ['хмуриться', 'морщиться'] })
    expect(word.cards.forward).toMatchObject({ state: 'new', enabled: true })

    const approved = await call('set_word_status', { ids: [frownId, 'wd_nope'], action: 'approve' })
    expect(approved.results).toEqual([{ id: frownId, ok: true }, { id: 'wd_nope', ok: false, error: 'word wd_nope not found' }])
    expect((await call('search_words', { status: 'active' })).words.map((w: { term: string }) => w.term)).toEqual(['to frown'])
    expect((await call('list_decks'))[0].counts).toMatchObject({ total: 2, active: 1, inbox: 1 })
  })

  it('summarises the vocabulary profile', async () => {
    const p = await call('vocabulary_profile', {})
    expect(p).toMatchObject({
      deck: { name: 'English', targetLang: 'en' },
      words: { total: 2, active: 1, inbox: 1 },
      vocabularySize: { basis: 'app', inListLemmas: 0, knownInApp: 0, fromLastTest: null },
      partsOfSpeech: { verb: 1 },
      cefrLevels: { B2: 1 },
      inbox: 1,
    })
    expect(p.coverage[2]).toEqual({ ranks: '2001-5000', wordsInApp: 1, knownInApp: 0, testShareKnown: null })
  })
})
