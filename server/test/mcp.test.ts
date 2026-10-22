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

  it('offers word and fact tools', async () => {
    const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: bearer(TOKEN) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const names = ((await r.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort()
    expect(names).toEqual(['add_exercises', 'add_facts', 'add_pack', 'add_words', 'create_deck', 'create_topic', 'get_leeches', 'get_word', 'list_decks', 'list_exercises', 'list_packs', 'review_stats', 'search_facts', 'search_words',
      'set_fact_status', 'set_word_status', 'update_fact', 'update_word', 'vocabulary_profile'])
  })

  it('adds words (active, tagged claude), reports duplicates, edits and drops', async () => {
    const added = await call('add_words', {
      words: [
        { term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], cefr: 'B2', tags: ['Wuthering Heights'] },
        { term: 'bid', pos: 'noun', translations: ['ставка'] },
      ],
      // Gone with the inbox: ignored.
      autoApprove: false,
    })
    expect(added.deck.name).toBe('English')
    expect(added.created.map((c: { term: string; status: string }) => [c.term, c.status])).toEqual([['to frown', 'active'], ['bid', 'active']])
    const frownId = added.created[0].id

    const again = await call('add_words', { words: [{ term: 'frown', pos: 'verb', translations: ['хмуриться', 'морщиться'] }] })
    expect(again.created).toEqual([])
    expect(again.duplicates).toEqual([{ index: 0, existingId: frownId, existingStatus: 'active', term: 'to frown', pos: 'verb', differs: { newTranslations: ['морщиться'], term: { existing: 'to frown', proposed: 'frown' } } }])
    expect((await call('add_words', { words: [{ term: 'x', pos: 'noun', translations: [] }] })).error).toMatch(/translations/)

    const updated = await call('update_word', { id: frownId, translations: ['хмуриться', 'морщиться'], note: null })
    expect(updated).toMatchObject({ term: 'to frown', translations: ['хмуриться', 'морщиться'], tags: ['claude', 'Wuthering Heights'], status: 'active' })
    const word = await call('get_word', { id: frownId })
    expect(word.faces.reverse.front).toMatchObject({ example: 'She ___ at him.', translations: ['хмуриться', 'морщиться'] })
    expect(word.cards.forward).toMatchObject({ state: 'new', enabled: true })

    const bidId = added.created[1].id
    const dropped = await call('set_word_status', { ids: [bidId, 'wd_nope'], action: 'drop' })
    expect(dropped.results).toEqual([{ id: bidId, ok: true }, { id: 'wd_nope', ok: false, error: 'word wd_nope not found' }])
    // A dropped word is still a duplicate: not proposed again.
    expect((await call('add_words', { words: [{ term: 'bid', pos: 'noun', translations: ['ставка'] }] })).duplicates).toMatchObject([{ existingId: bidId, existingStatus: 'rejected' }])
    expect((await call('search_words', { status: 'active' })).words.map((w: { term: string }) => w.term)).toEqual(['to frown'])
    expect((await call('list_decks'))[0].counts).toMatchObject({ total: 2, active: 1, dropped: 1 })
    expect((await call('set_word_status', { ids: [bidId], action: 'restore' })).results).toEqual([{ id: bidId, ok: true }])
    expect((await call('search_words', { status: 'active' })).total).toBe(2)
    await call('set_word_status', { ids: [bidId], action: 'drop' })
  })

  it('summarises the vocabulary profile', async () => {
    const p = await call('vocabulary_profile', {})
    expect(p).toMatchObject({
      deck: { name: 'English', targetLang: 'en' },
      words: { total: 2, active: 1, rejected: 1 },
      vocabularySize: { basis: 'app', inListLemmas: 0, knownInApp: 0, fromLastTest: null },
      partsOfSpeech: { verb: 1 },
      cefrLevels: { B2: 1 },
    })
    expect(p.coverage[2]).toEqual({ ranks: '2001-5000', wordsInApp: 1, knownInApp: 0, testShareKnown: null })
  })

  it('creates decks and adds, dedupes, edits, moves and drops facts', async () => {
    const t = await call('create_topic', { name: 'Concurrency' })
    expect(t).toMatchObject({ name: 'Concurrency', targetLang: null, newPerDay: 5 })
    expect((await call('create_topic', { name: 'concurrency' })).error).toMatch(/already exists/)

    expect((await call('add_facts', { deck: 'Databases', facts: [{ front: 'What is MVCC?', back: 'Multi-version concurrency control.' }] })).error).toMatch(/createDeck: true/)
    const added = await call('add_facts', {
      deck: 'Concurrency',
      facts: [
        { front: 'What is a deadlock?', back: 'Threads wait for each other **forever**.', tags: ['locks'] },
        { front: 'What is a livelock?', back: 'Busy, but no progress.' },
        { front: 'what is a DEADLOCK', back: 'A cycle of waits.' },
        { front: ' ', back: 'x' },
      ],
    })
    expect(added.deck).toMatchObject({ name: 'Concurrency', created: false })
    expect(added.created.map((c: any) => [c.front, c.status])).toEqual([['What is a deadlock?', 'active'], ['What is a livelock?', 'active']])
    const deadlock = added.created[0].id
    expect(added.duplicates).toEqual([{ index: 2, existingId: deadlock, existingStatus: 'active', front: 'What is a deadlock?', differs: { back: { existing: 'Threads wait for each other **forever**.', proposed: 'A cycle of waits.' } } }])
    expect(added.errors).toEqual([{ index: 3, front: ' ', error: 'front is empty' }])

    const db = await call('add_facts', { deck: 'Databases', createDeck: true, facts: [{ front: 'What is MVCC?', back: 'Readers see a snapshot.' }] })
    expect(db).toMatchObject({ deck: { name: 'Databases', created: true }, created: [{ status: 'active' }] })

    const found = await call('search_facts', { query: 'forever' })
    expect(found).toMatchObject({ total: 1, facts: [{ id: deadlock, deck: 'Concurrency', status: 'active', tags: ['claude', 'locks'], card: { state: 'new', suspended: false } }] })

    const edited = await call('update_fact', { id: deadlock, back: 'A cycle of threads, each waiting for the next.', tags: [] })
    expect(edited).toMatchObject({ front: 'What is a deadlock?', back: 'A cycle of threads, each waiting for the next.', tags: [], status: 'active' })
    expect((await call('update_fact', { id: added.created[1].id, front: 'What is a deadlock' })).error).toMatch(/already in this deck/)
    expect(await call('update_fact', { id: added.created[1].id, deck: 'Databases' })).toMatchObject({ deck: 'Databases' })

    const dropped = await call('set_fact_status', { ids: [deadlock, 'ft_nope'], action: 'drop' })
    expect(dropped.results).toEqual([{ id: deadlock, ok: true }, { id: 'ft_nope', ok: false, error: 'fact ft_nope not found' }])
    expect((await call('search_facts', { status: 'rejected' })).facts.map((f: any) => f.id)).toEqual([deadlock])
    expect((await call('set_fact_status', { ids: [deadlock], action: 'restore' })).results).toEqual([{ id: deadlock, ok: true }])
    expect((await call('set_fact_status', { ids: [deadlock], action: 'suspend' })).results).toEqual([{ id: deadlock, ok: true }])
    expect((await call('search_facts', { deck: 'Concurrency' })).facts[0]).toMatchObject({ status: 'active', card: { suspended: true } })
    expect((await call('set_fact_status', { ids: [deadlock], action: 'delete' })).results).toEqual([{ id: deadlock, ok: true }])
    const decks = await call('list_decks')
    expect(decks.map((d: any) => [d.name, d.targetLang, d.counts.total])).toEqual([['English', 'en', 2], ['Concurrency', null, 0], ['Databases', null, 2]])
  })
})
