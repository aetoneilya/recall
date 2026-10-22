// Hierarchical tags: prefix matching wherever a tag is matched (searches,
// the review filter, practice, the bot), bulk rename / delete / add in a
// deck (REST and the retag CLI), and the English deck's prod mapping.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dueCounts } from '../src/bot.ts'
import { createFact, searchFacts } from '../src/facts.ts'
import { practiceDeck } from '../src/practice.ts'
import { parseRetagMap, retagByName } from '../src/retag.ts'
import { createDeck, createWord, getDeck, HttpError, searchWords, updateDeck } from '../src/repo.ts'
import { buildQueue, reviewOptions } from '../src/study.ts'
import { retagDeck } from '../src/tags.ts'
import { addWord, callTool, deck, listen, makeCtx, rate, send, TZ, type TestCtx } from './helpers.ts'

const MAP = new URL('../scripts/retag-english-2026-10.json', import.meta.url)

function addFact(ctx: TestCtx, deckId: string, front: string, tags: string[], importRef: string | null = null, userId = ctx.user.id) {
  return createFact(ctx.db, userId, { deckId, fact: { front, back: `${front} — answer`, tags }, status: 'active', createdBy: importRef ? 'import' : 'user', importRef }, ctx.now())
}
const tagsOf = (ctx: TestCtx, table: 'words' | 'facts', id: string) =>
  JSON.parse((ctx.db.prepare(`SELECT tags FROM ${table} WHERE id = ?`).get(id) as { tags: string }).tags) as string[]
const fronts = (items: { kind: string; fact?: { front: string }; word?: { term: string } }[]) => items.map((i) => i.fact?.front ?? i.word?.term)

describe('prefix matching', () => {
  it('finds a tag and the tags under it, at the "/" boundary, with LIKE characters escaped', () => {
    const ctx = makeCtx()
    const en = deck(ctx)
    addWord(ctx, 'bone', { tags: ['Books/wuthering heights'] })
    addWord(ctx, 'house', { tags: ['Books'] })
    addWord(ctx, 'frown', { tags: ['Bookshelf'] })
    addWord(ctx, 'cry', { tags: ['50%_off/x'] })
    addWord(ctx, 'stop', { tags: ['50%_offer'] })
    const terms = (tag: string) => searchWords(ctx.db, ctx.user.id, { tag }, ctx.now()).words.map((w) => w.term).sort()
    expect(terms('Books')).toEqual(['bone', 'house'])
    expect(terms('Books/wuthering heights')).toEqual(['bone'])
    expect(terms('50%_off')).toEqual(['cry'])
    addFact(ctx, en.id, 'Tense rule', ['Grammar/Tenses'])
    addFact(ctx, en.id, 'Not grammar', ['Grammarly'])
    expect(searchFacts(ctx.db, ctx.user.id, { tag: 'Grammar' }, ctx.now()).facts.map((f) => f.front)).toEqual(['Tense rule'])
  })

  it('filters the queue, deck counts, practice and the bot by prefix; review options add ancestors', () => {
    const ctx = makeCtx()
    const en = deck(ctx)
    addWord(ctx, 'bone', { tags: ['Books/wuthering heights'] })
    const t = addFact(ctx, en.id, 'Tense rule', ['Grammar/Tenses'])
    addFact(ctx, en.id, 'Modal rule', ['Grammar/Modals/Must'])
    addFact(ctx, en.id, 'Not grammar', ['Grammarly'])
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { tags: ['Grammar'] } })
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id })
    expect(fronts(q.items).sort()).toEqual(['Modal rule', 'Tense rule'])
    expect(q.decks.map((d) => d.counts.new)).toEqual([2])
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now()).due).toBe(2)
    const o = reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), en.id, { tags: ['Grammar/Modals'] })
    expect(o.counts.new).toBe(1)
    expect(o.tags).toEqual([{ value: 'Grammar', n: 1 }, { value: 'Grammar/Modals', n: 1 }, { value: 'Grammar/Modals/Must', n: 1 }])
    expect(reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), en.id, null).tags).toEqual([
      { value: 'Grammar', n: 2 }, { value: 'Books', n: 1 }, { value: 'Books/wuthering heights', n: 1 }, { value: 'Grammar/Modals', n: 1 },
      { value: 'Grammar/Modals/Must', n: 1 }, { value: 'Grammar/Tenses', n: 1 }, { value: 'Grammarly', n: 1 },
    ])
    // Two tags AND; the words-only facets hide when the types leave no words.
    const both = reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), en.id, { tags: ['Grammar', 'Books'] })
    expect([both.counts.new, both.tags]).toEqual([0, [{ value: 'Books', n: 0 }, { value: 'Grammar', n: 0 }]])
    expect(reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), en.id, { types: ['fact'] }).pos).toEqual([])
    rate(ctx, t.cardId, 1, ctx.now())
    expect(fronts(practiceDeck(ctx.db, ctx.user.id, en.id, TZ, ctx.now()))).toEqual(['Tense rule'])
  })
})

describe('renaming, deleting and adding tags in a deck', () => {
  function setup() {
    const ctx = makeCtx()
    const en = deck(ctx)
    const w = addWord(ctx, 'bone', { tags: ['Tenses', 'vocab'] })
    const a = addFact(ctx, en.id, 'Rule A', ['Grammar', 'Tenses', 'Tenses/Past']).fact
    const b = addFact(ctx, en.id, 'Rule B', ['Grammar/Tenses', 'Tenses']).fact
    const c = addFact(ctx, en.id, 'Card C', ['Grammar theory', 'Modals']).fact
    const other = createDeck(ctx.db, ctx.user.id, { name: 'Other' }, ctx.now())
    const elsewhere = addFact(ctx, other.id, 'Elsewhere', ['Tenses']).fact
    return { ctx, en, w, a, b, c, elsewhere }
  }

  it('renames a tag with its descendants, dedupes, bumps only what changed and follows the review filter', () => {
    const { ctx, en, w, a, b, c, elsewhere } = setup()
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { tags: ['Tenses/Past', 'Modals'], types: ['rule'] } })
    ctx.clock.t = new Date(ctx.now().getTime() + 60_000)
    const r = retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'rename', from: 'Tenses', to: 'Grammar/Tenses' }, {}, ctx.now())
    expect(r).toEqual({ deck: { id: en.id, name: 'English' }, cards: 3, words: 1, facts: 2 })
    expect(tagsOf(ctx, 'words', w.id)).toEqual(['Grammar/Tenses', 'vocab'])
    expect(tagsOf(ctx, 'facts', a.id)).toEqual(['Grammar', 'Grammar/Tenses', 'Grammar/Tenses/Past'])
    // Already had the target: the first occurrence stays.
    expect(tagsOf(ctx, 'facts', b.id)).toEqual(['Grammar/Tenses'])
    expect(tagsOf(ctx, 'facts', c.id)).toEqual(['Grammar theory', 'Modals'])
    expect(tagsOf(ctx, 'facts', elsewhere.id)).toEqual(['Tenses'])
    const at = (id: string) => (ctx.db.prepare('SELECT updated_at FROM facts WHERE id = ?').get(id) as { updated_at: string }).updated_at
    expect(at(a.id)).toBe(ctx.now().toISOString())
    expect(at(c.id)).not.toBe(ctx.now().toISOString())
    expect(getDeck(ctx.db, ctx.user.id, en.id)!.reviewFilter).toEqual({ types: ['rule'], tags: ['Grammar/Tenses/Past', 'Modals'] })
    // onlyWith, checked before the rename.
    expect(retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'rename', from: 'Modals', to: 'Grammar/Modals' }, { onlyWith: 'Grammar' }, ctx.now()).cards).toBe(0)
    expect(retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'rename', from: 'Modals', to: 'Grammar/Modals' }, { onlyWith: 'Grammar theory' }, ctx.now()).facts).toBe(1)
    expect(tagsOf(ctx, 'facts', c.id)).toEqual(['Grammar theory', 'Grammar/Modals'])
  })

  it('deletes a tag with its descendants (or exactly), adds one, refuses bad input and other users\' decks', () => {
    const { ctx, en, w, a, b, c } = setup()
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { tags: ['Grammar'] } })
    expect(retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'delete', tag: 'Grammar', exact: true }).facts).toBe(1)
    expect(tagsOf(ctx, 'facts', a.id)).toEqual(['Tenses', 'Tenses/Past'])
    expect(tagsOf(ctx, 'facts', b.id)).toEqual(['Grammar/Tenses', 'Tenses'])
    // An exact delete leaves the filter: its "Grammar" still takes what is under it.
    expect(getDeck(ctx.db, ctx.user.id, en.id)!.reviewFilter).toEqual({ tags: ['Grammar'] })
    expect(retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'delete', tag: 'Tenses' }, { onlyWith: 'Grammar' })).toMatchObject({ words: 0, facts: 1 })
    expect(tagsOf(ctx, 'facts', b.id)).toEqual(['Grammar/Tenses'])
    expect(retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'delete', tag: 'Grammar' })).toMatchObject({ facts: 1 })
    expect(tagsOf(ctx, 'facts', b.id)).toEqual([])
    expect(getDeck(ctx.db, ctx.user.id, en.id)!.reviewFilter).toBeNull()
    expect(retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'add', tag: ' Leon / words ' }, { onlyWith: 'vocab' })).toMatchObject({ words: 1, facts: 0 })
    expect(tagsOf(ctx, 'words', w.id)).toEqual(['Tenses', 'vocab', 'Leon/words'])
    expect(tagsOf(ctx, 'facts', c.id)).toEqual(['Grammar theory', 'Modals'])

    const status = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return e instanceof HttpError ? e.status : e
      }
      return 200
    }
    expect(status(() => retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'rename', from: 'A', to: ' A ' }))).toBe(400)
    expect(status(() => retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'rename', from: ' ', to: 'B' }))).toBe(400)
    expect(status(() => retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'delete', tag: '  ' }))).toBe(400)
    expect(status(() => retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'add', tag: ' / ' }))).toBe(400)
    expect(status(() => retagDeck(ctx.db, 'us_nobody', en.id, { kind: 'delete', tag: 'vocab' }))).toBe(404)
  })

  it('renames a tag stored before "/" meant a path, by its exact text', () => {
    const ctx = makeCtx()
    const en = deck(ctx)
    ctx.db.prepare('UPDATE words SET tags = ? WHERE id = ?').run('["leon notes (спикинг) — phrases / collocations"]', addWord(ctx, 'bone').id)
    const r = retagDeck(ctx.db, ctx.user.id, en.id, { kind: 'rename', from: 'leon notes (спикинг) — phrases / collocations', to: 'Leon/phrases & collocations' })
    expect(r.words).toBe(1)
    expect(searchWords(ctx.db, ctx.user.id, { tag: 'Leon' }, ctx.now()).words[0]!.tags).toEqual(['Leon/phrases & collocations'])
  })
})

describe('tag routes', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  const api = async (p: string, body: unknown) => {
    const r = await send(`${url}/api${p}`, 'POST', body)
    return { status: r.status, body: (await r.json()) as any }
  }

  beforeAll(async () => {
    ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001', MCP_TOKEN: 'static-mcp-token' })
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(async () => close())

  it('renames, deletes and adds; searches by prefix over REST and MCP', async () => {
    const en = deck(ctx)
    addWord(ctx, 'bone', { tags: ['wuthering heights'] })
    addFact(ctx, en.id, 'Rule', ['Grammar', 'Tenses'])
    expect(await api(`/decks/${en.id}/tags/rename`, { from: 'wuthering heights', to: 'Books/wuthering heights' }))
      .toEqual({ status: 200, body: { deck: { id: en.id, name: 'English' }, cards: 1, words: 1, facts: 0 } })
    expect((await api(`/decks/${en.id}/tags/rename`, { from: 'Tenses', to: 'Grammar/Tenses', onlyWith: 'Grammar' })).body).toMatchObject({ cards: 1, facts: 1 })
    expect((await api(`/decks/${en.id}/tags/add`, { tag: 'Grammar/My rules', onlyWith: 'Grammar' })).body).toMatchObject({ facts: 1 })
    expect((await api(`/decks/${en.id}/tags/delete`, { tag: 'Grammar/My rules' })).body).toMatchObject({ cards: 1 })
    expect((await api(`/decks/${en.id}/tags/rename`, { from: 'x', to: 'x' })).status).toBe(400)
    expect((await api(`/decks/${en.id}/tags/rename`, { from: '', to: 'x' })).status).toBe(400)
    expect((await api(`/decks/${en.id}/tags/delete`, { tag: 'x', extra: 1 })).status).toBe(400)
    expect((await api('/decks/dk_nope/tags/delete', { tag: 'x' })).status).toBe(404)

    const words = await (await fetch(`${url}/api/words?tag=Books`)).json() as any
    expect(words.words.map((w: any) => w.tags)).toEqual([['Books/wuthering heights']])
    const facts = await (await fetch(`${url}/api/facts?tag=Grammar`)).json() as any
    expect(facts.facts.map((f: any) => f.tags)).toEqual([['Grammar', 'Grammar/Tenses']])
    expect((await callTool(url, 'static-mcp-token', 'search_words', { tag: 'Books' })).total).toBe(1)
    expect((await callTool(url, 'static-mcp-token', 'search_facts', { tag: 'Grammar/Tenses' })).total).toBe(1)
    expect((await callTool(url, 'static-mcp-token', 'search_facts', { tag: 'Gram' })).total).toBe(0)
    // Several tags: every one must hold.
    const total = async (q: string) => ((await (await fetch(`${url}/api/facts?${q}`)).json()) as any).total
    expect([await total('tag=Grammar&tag=Grammar/Tenses'), await total('tag=Grammar&tag=Books')]).toEqual([1, 0])
    expect((await callTool(url, 'static-mcp-token', 'search_facts', { tag: 'Grammar', tags: ['Grammar/Tenses'] })).total).toBe(1)
    expect((await callTool(url, 'static-mcp-token', 'search_words', { tags: ['Books', 'Grammar'] })).total).toBe(0)
  })
})

describe('the English deck mapping (retag CLI)', () => {
  const HB = 'pack:grammar-handbook:'
  // The English deck as it is on prod before the mapping.
  function prodLike() {
    const ctx = makeCtx()
    const en = deck(ctx)
    const id = (r: { fact: { id: string } }) => r.fact.id
    const f = {
      own1: id(addFact(ctx, en.id, 'Third person -s', ['Grammar', 'Agreement'], 'rules:third-person-s')),
      own2: id(addFact(ctx, en.id, 'since vs for', ['Grammar', 'Prepositions'], 'rules:since-for')),
      own3: id(addFact(ctx, en.id, 'Adjective order', ['Grammar', 'Adjectives', 'claude'])),
      own4: id(addFact(ctx, en.id, 'Present perfect vs past', ['Grammar', 'Verbs & tenses'], 'rules:pp-past')),
      hb1: id(addFact(ctx, en.id, 'Present simple', ['Grammar', 'Tenses'], `${HB}present-simple`)),
      hb2: id(addFact(ctx, en.id, 'Prepositions of time', ['Grammar', 'Prepositions'], `${HB}prep-time`)),
      hb3: id(addFact(ctx, en.id, 'Comparatives', ['Grammar', 'Adjectives & adverbs'], `${HB}comparatives`)),
      th1: id(addFact(ctx, en.id, 'When the present simple?', ['Grammar theory', 'Tenses'], `${HB}present-simple:card:0`)),
      th2: id(addFact(ctx, en.id, 'at, on or in for a day?', ['Grammar theory', 'Prepositions'], `${HB}prep-time:card:0`)),
      iv: id(addFact(ctx, en.id, '**to begin**\nначинать', ['Irregular verbs'], 'pack:irregular-verbs:begin')),
    }
    const word = (term: string, tags: string[]) => createWord(ctx.db, ctx.user.id, {
      deckId: en.id, word: { term, pos: 'noun', translations: [`${term} ru`], tags }, status: 'active', createdBy: 'import',
    }, ctx.now(), ctx.lexicon).id
    const w = {
      king: word('bone', ['the king in the yellow pt.1', 'vocab']),
      wh: word('house', ['wuthering heights', 'vocab']),
      leon: word('cry', ['leon notes (спикинг) — words', 'vocab']),
      fashion: word('frown', ['leon notes (спикинг) — fashion', 'vocab']),
      claude: word('auction', ['claude']),
      // A group-looking tag on a word without Grammar: stays.
      prep: word('stop', ['Prepositions']),
      phrases: word('make', ['vocab']),
    }
    // Stored before "/" meant a path: the old cleaning kept " / ".
    ctx.db.prepare('UPDATE words SET tags = ? WHERE id = ?').run('["leon notes (спикинг) — phrases / collocations","vocab"]', w.phrases)
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { tags: ['Grammar', 'Grammar theory'] } })
    return { ctx, en, f, w }
  }
  const map = () => parseRetagMap(JSON.parse(readFileSync(MAP, 'utf8')))
  const snapshot = (ctx: TestCtx) => ctx.db.prepare('SELECT id, tags, updated_at FROM facts UNION ALL SELECT id, tags, updated_at FROM words UNION ALL SELECT id, review_filter, created_at FROM decks ORDER BY 1').all()

  it('moves grammar under Grammar/, books under Books/, Leon under Leon/, drops vocab; dry runs and reruns change nothing', () => {
    const { ctx, en, f, w } = prodLike()
    const m = map()
    expect(m.deck).toBe('English')
    const before = snapshot(ctx)
    const dry = retagByName(ctx.db, ctx.user.id, 'English', m.steps, { dryRun: true, now: ctx.now() })
    expect(snapshot(ctx)).toEqual(before)
    ctx.clock.t = new Date(ctx.now().getTime() + 60_000)
    const s = retagByName(ctx.db, ctx.user.id, 'English', m.steps, { now: ctx.now() })
    expect(s).toEqual(dry)
    expect(s.steps[0]).toEqual({ step: { add: 'Grammar/My rules', onlyWith: 'Grammar', source: 'own' }, cards: 4, words: 0, facts: 4 })

    const tags = (o: Record<string, string>, table: 'words' | 'facts') => Object.fromEntries(Object.entries(o).map(([k, id]) => [k, tagsOf(ctx, table, id)]))
    expect(tags(f, 'facts')).toEqual({
      own1: ['Grammar/Agreement', 'Grammar/My rules'],
      own2: ['Grammar/Prepositions', 'Grammar/My rules'],
      own3: ['Grammar/Adjectives', 'claude', 'Grammar/My rules'],
      own4: ['Grammar/Verbs & tenses', 'Grammar/My rules'],
      hb1: ['Grammar/Tenses'],
      hb2: ['Grammar/Prepositions'],
      hb3: ['Grammar/Adjectives & adverbs'],
      th1: ['Grammar/Tenses'],
      th2: ['Grammar/Prepositions'],
      iv: ['Irregular verbs'],
    })
    expect(tags(w, 'words')).toEqual({
      king: ['Books/the king in the yellow pt.1'],
      wh: ['Books/wuthering heights'],
      leon: ['Leon/words'],
      fashion: ['Leon/fashion'],
      claude: ['claude'],
      prep: ['Prepositions'],
      phrases: ['Leon/phrases & collocations'],
    })
    // The filter on Grammar + Grammar theory is now Grammar: rules and theory alike.
    expect(getDeck(ctx.db, ctx.user.id, en.id)!.reviewFilter).toEqual({ tags: ['Grammar'] })
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id, limit: 50 }).items).length).toBe(9)

    const after = snapshot(ctx)
    ctx.clock.t = new Date(ctx.now().getTime() + 60_000)
    const again = retagByName(ctx.db, ctx.user.id, 'English', m.steps, { now: ctx.now() })
    expect(again.steps.every((x) => x.cards === 0)).toBe(true)
    expect(snapshot(ctx)).toEqual(after)
  })

  it('refuses a malformed mapping and an unknown deck, writing nothing', () => {
    const { ctx } = prodLike()
    expect(() => parseRetagMap({ steps: [] })).toThrow(/steps/)
    expect(() => parseRetagMap({ steps: [{ from: 'a', to: 'b', onlywith: 'c' }] })).toThrow(/unknown keys onlywith/)
    expect(() => parseRetagMap({ steps: [{ from: 'a', to: 'b', exact: true }] })).toThrow(/exact/)
    expect(() => parseRetagMap({ steps: [{ delete: 'a', add: 'b' }] })).toThrow(/one of/)
    expect(() => parseRetagMap({ steps: [{ add: 'a', source: 'mine' }] })).toThrow(/source/)
    expect(() => parseRetagMap({ deck: 'English', steps: [{ to: 'b' }], colour: 1 })).toThrow(/unknown keys/)
    const before = snapshot(ctx)
    expect(() => retagByName(ctx.db, ctx.user.id, 'Nope', map().steps)).toThrow(/no deck "Nope"/)
    // A failing step rolls back the ones before it.
    expect(() => retagByName(ctx.db, ctx.user.id, 'English', [{ delete: 'vocab' }, { from: 'x', to: 'x' }])).toThrow(HttpError)
    expect(snapshot(ctx)).toEqual(before)
  })
})
