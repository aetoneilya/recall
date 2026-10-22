// Adding words by messaging the bot: one word → added at once, a card with buttons,
// duplicates, context sentences, batches, picking words from a paragraph or
// a photo, draft ownership and expiry, the daily limit. Telegram and Claude
// are fakes.
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { describe, expect, it } from 'vitest'
import { HELP_TEXT } from '../src/bot.ts'
import { parseItem, parseMessage } from '../src/bot-words.ts'
import type { AutofillClient } from '../src/autofill.ts'
import { getWord, searchWords } from '../src/repo.ts'
import { ensureUser } from '../src/users.ts'
import { fakeBot } from './fake-telegram.ts'
import { addWord, cardsOf, makeCtx, rate, type TestCtx } from './helpers.ts'

const ME = 1001
const FRIEND = 2002

type Sense = { term: string; pos: string; translations: string[]; ipa: string | null; examples: { text: string; translation: string | null }[]; note: string | null; cefr: string | null }
const sense = (term: string, over: Partial<Sense> = {}): Sense => ({
  term, pos: 'noun', translations: [`${term} ru`], ipa: null, examples: [{ text: `Example with ${term}.`, translation: `Пример: ${term}.` }], note: null, cefr: 'B2', ...over,
})

const SENSES: Record<string, { draft: Sense; alternatives: Sense[] }> = {
  frown: {
    draft: sense('to frown', { pos: 'verb', translations: ['хмуриться', 'насупиться'], ipa: 'fraʊn', examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], cefr: 'B2' }),
    alternatives: [sense('frown', { pos: 'noun', translations: ['хмурый взгляд'], ipa: 'fraʊn' })],
  },
}

function reply(body: unknown): BetaMessage {
  return {
    id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    content: [{ type: 'text', text: JSON.stringify(body), citations: null }], usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as BetaMessage
}

// Autofill answers from SENSES (or a plain noun); extraction answers `candidates`.
function claude(candidates: object[] = []) {
  const calls: MessageCreateParamsNonStreaming[] = []
  const extra: Record<string, string[]> = {}
  const client: AutofillClient = {
    beta: {
      messages: {
        create: async (body) => {
          calls.push(body)
          if (String(body.system).includes('lexicographer')) {
            const term = String(body.messages[0]!.content).match(/^Term: (.*)$/m)![1]!.toLowerCase()
            const known = SENSES[term.replace(/ed$/, '')] ?? { draft: sense(term), alternatives: [] }
            const draft = extra[term] ? { ...known.draft, translations: [...known.draft.translations, ...extra[term]!] } : known.draft
            return reply({ draft, alternatives: known.alternatives })
          }
          return reply({ candidates })
        },
      },
    },
  }
  return { client, calls, extra }
}

function setup(env: Record<string, string> = {}, candidates: object[] = []) {
  const ai = claude(candidates)
  const ctx = makeCtx({ BOT_TOKEN: '123456:TEST-fake-bot-token', OWNER_TELEGRAM_ID: String(ME), ALLOW_USER_IDS: String(FRIEND), ...env }, '2026-10-21T09:00:00Z', ai.client)
  const files = new Map<string, Uint8Array>()
  return { ctx, ai, files, tg: fakeBot(ctx, files) }
}

const words = (ctx: TestCtx, userId = ctx.user.id) => searchWords(ctx.db, userId, { sort: 'alpha', limit: 100 }, ctx.now()).words

describe('reading a message', () => {
  it('tells words, words with context, lists, prose and links apart', () => {
    expect(parseMessage('frown')).toEqual({ kind: 'word', item: { term: 'frown', context: null, hint: null } })
    expect(parseMessage('  a far cry from  ')).toMatchObject({ kind: 'word', item: { term: 'a far cry from' } })
    expect(parseMessage('break a leg!')).toMatchObject({ kind: 'word', item: { term: 'break a leg' } })
    expect(parseItem('tenacious — She was tenacious in her pursuit of the truth.')).toEqual({ term: 'tenacious', context: 'She was tenacious in her pursuit of the truth.', hint: null })
    expect(parseItem('bank - берег реки')).toEqual({ term: 'bank', context: null, hint: 'берег реки' })
    expect(parseItem('He remained *aloof* from the others.')).toEqual({ term: 'aloof', context: 'He remained aloof from the others.', hint: null })
    expect(parseItem('They called it a "red herring" in the end.')).toEqual({ term: 'red herring', context: 'They called it a red herring in the end.', hint: null })
    expect(parseMessage('frown\n- bone\n3. to give up')).toEqual({ kind: 'batch', total: 3, items: [
      { term: 'frown', context: null, hint: null }, { term: 'bone', context: null, hint: null }, { term: 'to give up', context: null, hint: null }] })
    const many = parseMessage(Array.from({ length: 25 }, (_, i) => `word${i}`).join('\n'))
    expect(many).toMatchObject({ kind: 'batch', total: 25 })
    expect((many as { items: unknown[] }).items).toHaveLength(20)
    expect(parseMessage('It was the best of times, it was the worst of times, it was the age of wisdom.')).toMatchObject({ kind: 'text' })
    expect(parseMessage('frown\nShe walked into the room. Nobody looked up.')).toMatchObject({ kind: 'text' })
    expect(parseMessage('https://example.com/article')).toEqual({ kind: 'link' })
    expect(parseMessage('хмуриться')).toMatchObject({ kind: 'text' })
  })
})

describe('adding a word by message', () => {
  it('adds it to the deck at once and shows a card with ✏️ ✖ ↔', async () => {
    const { ctx, ai, tg } = setup()
    const text = await tg.message(ME, 'frown')
    expect(text).toBe('✅ <b>to frown</b> /fraʊn/ · verb · B2\nхмуриться, насупиться\n<i>She frowned at him.</i>\nОна нахмурилась.')
    const [w] = words(ctx)
    expect(w).toMatchObject({ term: 'to frown', pos: 'verb', status: 'active', createdBy: 'user', ipa: 'fraʊn', freqRank: 2500 })
    expect(ai.calls).toHaveLength(1)
    const shown = tg.buttons()
    expect(shown.map(([l]) => l)).toEqual(['✏️ Edit', '✖', '↔ Other meaning'])
    expect(shown[0]![1]).toBe(`http://localhost:9/#/words/${w!.id}`)
    for (const [, data] of shown.filter(([l]) => l !== '✏️ Edit')) expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(tg.calls.some((c) => c.method === 'sendChatAction')).toBe(true)

    // ↔ switches the word to the next meaning and back.
    const card = tg.last()!
    expect((await tg.press(ME, tg.data('↔ Other meaning'))).edited).toBe('✅ <b>frown</b> /fraʊn/ · noun · B2\nхмурый взгляд\n<i>Example with frown.</i>\nПример: frown.')
    expect(getWord(ctx.db, ctx.user.id, w!.id)).toMatchObject({ term: 'frown', pos: 'noun', translations: ['хмурый взгляд'], status: 'active' })
    expect((await tg.press(ME, tg.data('↔ Other meaning'))).edited).toBe(card.text)
    expect(getWord(ctx.db, ctx.user.id, w!.id)).toMatchObject({ term: 'to frown', pos: 'verb' })
  })

  it('✖ deletes the new word, or drops it once reviewed', async () => {
    const { ctx, tg } = setup()
    await tg.message(ME, 'bone')
    const id = words(ctx)[0]!.id
    expect(tg.buttons().map(([l]) => l)).toEqual(['✏️ Edit', '✖'])
    const no = tg.data('✖')
    expect((await tg.press(ME, no)).edited).toBe('✖ Removed: bone')
    expect(getWord(ctx.db, ctx.user.id, id)).toBeNull()
    expect(tg.buttons()).toEqual([])
    // The draft is gone with it.
    expect(await tg.press(ME, no)).toMatchObject({ edited: undefined, popup: 'This message has expired — send the word again' })

    // Reviewed in the meantime: kept as dropped, with its history.
    await tg.message(ME, 'wary')
    const wary = words(ctx)[0]!
    rate(ctx, cardsOf(ctx, wary.id)[0]!.id, 3, ctx.now())
    expect((await tg.press(ME, tg.data('✖'))).edited).toBe('✖ Removed: wary')
    expect(getWord(ctx.db, ctx.user.id, wary.id)!.status).toBe('rejected')
  })

  it('reports a duplicate with its state and offers the new translations', async () => {
    const { ctx, ai, tg } = setup()
    const existing = addWord(ctx, 'to frown', { pos: 'verb', translations: ['хмуриться'] })
    expect(await tg.message(ME, 'frowned')).toBe('Already in your deck: <b>to frown</b> — хмуриться · new\nAlso: насупиться')
    expect(tg.buttons().map(([l]) => l)).toEqual(['➕ Add translations'])
    expect((await tg.press(ME, tg.data('➕ Add translations'))).edited).toBe('➕ Added to <b>to frown</b>: насупиться')
    expect(getWord(ctx.db, ctx.user.id, existing.id)!.translations).toEqual(['хмуриться', 'насупиться'])
    expect(words(ctx)).toHaveLength(1)

    // Nothing new: no buttons.
    ai.extra.frown = []
    expect(await tg.message(ME, 'frown')).toBe('Already in your deck: <b>to frown</b> — хмуриться, насупиться · new')
    expect(tg.buttons()).toEqual([])
  })

  it('uses the sentence it came with as the first example', async () => {
    const { ctx, ai, tg } = setup()
    await tg.message(ME, 'tenacious — She was tenacious in her pursuit of the truth.')
    expect(String(ai.calls[0]!.messages[0]!.content)).toBe('Term: tenacious\nContext: She was tenacious in her pursuit of the truth.')
    expect(words(ctx)[0]!.examples).toEqual([
      { text: 'She was tenacious in her pursuit of the truth.', translation: null },
      { text: 'Example with tenacious.', translation: 'Пример: tenacious.' },
    ])
    await tg.message(ME, 'He remained *aloof* from the others.')
    expect(words(ctx).find((w) => w.term === 'aloof')!.examples[0]).toEqual({ text: 'He remained aloof from the others.', translation: null })
    expect(tg.last()!.text).toContain('<i>He remained aloof from the others.</i>')
  })

  it('without autofill, or over the daily limit, sends to the app instead', async () => {
    const off = setup()
    off.ctx.autofill = null
    expect(await off.tg.message(ME, 'serendipity')).toBe("Couldn't fill in <b>serendipity</b>: autofill is off on this server. Add it in the app:")
    expect(off.tg.buttons()).toEqual([['✏️ Add in the app', 'http://localhost:9/#/words/new?term=serendipity']])
    expect(words(off.ctx)).toEqual([])

    const { ctx, ai, tg } = setup({ AUTOFILL_DAILY_LIMIT: '2' })
    await tg.message(ME, 'one')
    await tg.message(ME, 'two')
    expect(await tg.message(ME, 'red herring')).toBe("Couldn't fill in <b>red herring</b>: daily autofill limit reached. Add it in the app:")
    expect(tg.buttons()).toEqual([['✏️ Add in the app', 'http://localhost:9/#/words/new?term=red%20herring']])
    expect(ai.calls).toHaveLength(2)
    expect(words(ctx).map((w) => w.term)).toEqual(['one', 'two'])
    // A batch stops asking once the limit is hit.
    await tg.message(ME, 'three\nfour')
    expect(tg.last()!.text).toBe('Nothing new added.\nNot added: three (daily autofill limit reached); four (daily autofill limit reached) — add in the app')
    // Picking from a paragraph is one call on the same budget.
    await tg.message(ME, 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.')
    expect(tg.last()!.text).toBe("Couldn't look for words: daily autofill limit reached.")
    expect(ai.calls).toHaveLength(2)
  })
})

describe('several words at once', () => {
  it('adds each line with one progress message, then ✖ per word', async () => {
    const { ctx, tg } = setup()
    addWord(ctx, 'house', { translations: ['дом'] })
    await tg.message(ME, 'frown\nbone\nhouse\nwary')
    const progress = tg.calls.filter((c) => c.method === 'editMessageText').map((c) => c.payload.text)
    expect(progress.slice(0, 3)).toEqual(['⏳ Adding 4 words… 1/4', '⏳ Adding 4 words… 2/4', '⏳ Adding 4 words… 3/4'])
    expect(tg.calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text)).toEqual(['⏳ Adding 4 words…'])
    expect(tg.last()!.text).toBe([
      '✅ Added 3 words:', '1. <b>to frown</b> — хмуриться', '2. <b>bone</b> — bone ru', '3. <b>wary</b> — wary ru',
      'Already in your deck: house — дом (new)'].join('\n'))
    expect(words(ctx).map((w) => [w.term, w.status]).sort()).toEqual([['bone', 'active'], ['house', 'active'], ['to frown', 'active'], ['wary', 'active']])
    expect(tg.buttons().map(([l]) => l)).toEqual(['✏️ Open in app', '✖ to frown', '✖ bone', '✖ wary'])
    expect(tg.data('✏️ Open in app')).toBe('http://localhost:9/#/words')

    await tg.press(ME, tg.data('✖ bone'))
    expect(tg.last()!.text).toContain('<s>2. <b>bone</b> — bone ru</s>')
    expect(tg.buttons().map(([l]) => l)).toEqual(['✏️ Open in app', '✖ to frown', '✖ wary'])
    expect(words(ctx).map((w) => w.term).sort()).toEqual(['house', 'to frown', 'wary'])
    await tg.press(ME, tg.data('✖ to frown'))
    await tg.press(ME, tg.data('✖ wary'))
    expect(words(ctx).map((w) => w.term)).toEqual(['house'])
    expect(tg.buttons()).toEqual([])
  })
})

describe('picking words from a paragraph or a photo', () => {
  const PARAGRAPH = 'The old man was tenacious. He remained aloof from the house, and his frown never changed. It was a red herring.'
  const CANDIDATES = [
    { term: 'tenacious', pos: 'adjective', sentence: 'The old man was tenacious.', gloss: 'упорный' },
    { term: 'aloof', pos: 'adjective', sentence: 'He remained aloof from the house, and his frown never changed.', gloss: 'отчуждённый' },
    // Already in the deck, and a very frequent word: both dropped.
    { term: 'to frown', pos: 'verb', sentence: 'his frown never changed', gloss: 'хмуриться' },
    { term: 'house', pos: 'noun', sentence: 'from the house', gloss: 'дом' },
    { term: 'red herring', pos: 'idiom', sentence: 'It was a red herring.', gloss: 'ложный след' },
  ]

  it('lists the likely new words as toggles and adds the selected ones with their sentence', async () => {
    const { ctx, ai, tg } = setup({}, CANDIDATES)
    addWord(ctx, 'frown', { pos: 'verb' })
    await tg.message(ME, PARAGRAPH)
    const call = ai.calls[0]!
    expect(call.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } })
    expect(call.model).toBe('claude-opus-5-5')
    expect(call.system).toMatch(/most frequent English lemmas/)
    expect(String(call.messages[0]!.content)).toContain(PARAGRAPH)
    expect(String(call.messages[0]!.content)).toContain('Already in the learner\'s deck (skip): frown')
    expect(tg.calls.filter((c) => c.method === 'sendMessage')[0]!.payload.text).toBe('🔍 Looking for words…')
    expect(tg.last()!.text).toBe([
      'Found 3 words worth learning — tap to pick, then ➕ Add selected:',
      '1. <b>tenacious</b> — упорный', '2. <b>aloof</b> — отчуждённый', '3. <b>red herring</b> — ложный след'].join('\n'))
    expect(tg.buttons().map(([l]) => l)).toEqual(['tenacious', 'aloof', 'red herring', '➕ Add selected'])

    expect(await tg.press(ME, tg.data('➕ Add selected'))).toMatchObject({ popup: 'Select some words first' })
    await tg.press(ME, tg.data('tenacious'))
    await tg.press(ME, tg.data('red herring'))
    await tg.press(ME, tg.data('aloof'))
    await tg.press(ME, tg.data('✓ aloof'))
    expect(tg.buttons().map(([l]) => l)).toEqual(['✓ tenacious', 'aloof', '✓ red herring', '➕ Add selected (2)'])
    await tg.press(ME, tg.data('➕ Add selected (2)'))
    expect(tg.last()!.text).toBe('✅ Added 2 words:\n1. <b>tenacious</b> — tenacious ru\n2. <b>red herring</b> — red herring ru')
    const added = words(ctx).filter((w) => w.term !== 'frown')
    expect(added.map((w) => [w.term, w.examples[0]!.text])).toEqual([['red herring', 'It was a red herring.'], ['tenacious', 'The old man was tenacious.']])
    // One extraction call, then one autofill per selected word, with the gloss as a hint.
    expect(ai.calls).toHaveLength(3)
    expect(String(ai.calls[1]!.messages[0]!.content)).toBe('Term: tenacious\nHint: упорный\nContext: The old man was tenacious.')
  })

  it('reads a photo: the largest size, downloaded through getFile, sent as an image block', async () => {
    const { ai, files, tg } = setup({}, CANDIDATES.slice(0, 1))
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    files.set('photos/big.jpg', jpeg)
    await tg.photo(ME, [{ fileId: 'small', width: 90, size: 1000 }, { fileId: 'big', width: 1280, size: 7 }], 'p. 12')
    expect(tg.calls.find((c) => c.method === 'getFile')!.payload.file_id).toBe('big')
    const content = ai.calls[0]!.messages[0]!.content as any[]
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } })
    expect(content[1].text).toMatch(/^Caption: p\. 12\n/)
    expect(ai.calls[0]!.system).toMatch(/in the image/)
    expect(tg.last()!.text).toBe('Found 1 word worth learning — tap to pick, then ➕ Add selected:\n1. <b>tenacious</b> — упорный')

    // Image files too; other documents are ignored.
    files.set('photos/shot.jpg', jpeg)
    await tg.document(ME, { fileId: 'shot', mime: 'image/png', size: 7 })
    expect((ai.calls[1]!.messages[0]!.content as any[])[0].source.media_type).toBe('image/png')
    const n = tg.calls.length
    await tg.document(ME, { fileId: 'doc', mime: 'application/pdf', size: 7 })
    expect(tg.calls.length).toBe(n)

    // Nothing found.
    const none = setup({}, [])
    none.files.set('photos/x.jpg', jpeg)
    expect(await none.tg.photo(ME, [{ fileId: 'x', width: 100, size: 7 }])).toBe('No new words found here — they look familiar or are already in your deck.')
  })
})

describe('bot drafts', () => {
  it('belong to the user who got them and expire after 7 days', async () => {
    const { ctx, tg } = setup()
    const friend = ensureUser(ctx.db, ctx.cfg, FRIEND, ctx.now())
    await tg.message(ME, 'bone')
    const id = words(ctx)[0]!.id
    const ok = tg.data('✖')
    const alt = 'w:alt:' + ok.split(':')[2]

    // Someone else pressing (or forging) the button: as if it didn't exist.
    expect(await tg.press(FRIEND, ok, undefined, ME)).toMatchObject({ edited: undefined, popup: 'This message has expired — send the word again' })
    expect(await tg.press(FRIEND, 'w:no:bd_0000000000')).toMatchObject({ popup: 'This message has expired — send the word again' })
    expect(getWord(ctx.db, ctx.user.id, id)).not.toBeNull()
    expect(words(ctx, friend.id)).toEqual([])
    expect(await tg.press(ME, alt)).toMatchObject({ popup: 'No other meaning to switch to' })

    ctx.clock.t = new Date(ctx.clock.t.getTime() + 7 * 86400_000 + 1)
    expect(await tg.press(ME, ok)).toMatchObject({ edited: undefined, popup: 'This message has expired — send the word again' })
    expect(getWord(ctx.db, ctx.user.id, id)).not.toBeNull()
    // Expired drafts are cleaned up as new ones are made.
    await tg.message(ME, 'wary')
    expect((ctx.db.prepare('SELECT count(*) AS n FROM bot_drafts').get() as { n: number }).n).toBe(1)
  })

  it('are per user: two users adding the same word get their own words and buttons', async () => {
    const { ctx, tg } = setup()
    const friend = ensureUser(ctx.db, ctx.cfg, FRIEND, ctx.now())
    await tg.message(ME, 'bone')
    const mine = tg.data('✖')
    await tg.message(FRIEND, 'bone')
    const theirs = tg.data('✖')
    expect(words(ctx, friend.id)).toHaveLength(1)
    await tg.press(FRIEND, mine, undefined, ME)
    await tg.press(FRIEND, theirs)
    expect(words(ctx)).toHaveLength(1)
    expect(words(ctx, friend.id)).toEqual([])
  })
})

describe('commands', () => {
  it('/help explains how to add words; /stats sums up the dashboard', async () => {
    const { ctx, tg } = setup()
    expect(await tg.message(ME, '/help')).toBe(HELP_TEXT)
    addWord(ctx, 'frown')
    addWord(ctx, 'bone', { status: 'rejected' })
    expect(await tg.message(ME, '/stats')).toBe('📊 Vocabulary ≈ 0 words\nKnown words: 0 · mastered 0\nStreak: 0 days\nDue today: 1')
    expect(tg.buttons()).toEqual([['Open dashboard', 'http://localhost:9/#/dashboard']])
    expect(await tg.message(ME, '/nonsense')).toBe('Unknown command. /help shows what I can do.')
    expect(await tg.message(7, 'frown')).toMatch(/private bot/)
  })
})
