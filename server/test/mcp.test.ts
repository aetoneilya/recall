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
    expect(names).toEqual(['add_exercises', 'add_facts', 'add_pack', 'add_words', 'create_topic', 'get_leeches', 'get_word', 'list_decks', 'list_exercises', 'list_packs', 'review_stats', 'search_facts', 'search_words',
      'set_fact_status', 'set_word_status', 'update_fact', 'update_word', 'vocabulary_profile'])
  })

  it('adds words to the inbox, reports duplicates, edits and approves', async () => {
    const added = await call('add_words', {
      words: [
        { term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась.' }], cefr: 'B2', tags: ['Wuthering Heights'] },
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

  it('creates topics and proposes, dedupes, edits, moves and approves facts', async () => {
    const t = await call('create_topic', { name: 'Concurrency' })
    expect(t).toMatchObject({ kind: 'topic', name: 'Concurrency', inReview: true, newPerDay: 5 })
    expect((await call('create_topic', { name: 'concurrency' })).error).toMatch(/already exists/)

    expect((await call('add_facts', { deck: 'Databases', facts: [{ front: 'What is MVCC?', back: 'Multi-version concurrency control.' }] })).error).toMatch(/createDeck: true/)
    expect((await call('add_facts', { deck: 'English', facts: [{ front: 'Q?', back: 'A' }] })).error).toMatch(/language deck/)
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
    expect(added.created.map((c: any) => [c.front, c.status])).toEqual([['What is a deadlock?', 'inbox'], ['What is a livelock?', 'inbox']])
    const deadlock = added.created[0].id
    expect(added.duplicates).toEqual([{ index: 2, existingId: deadlock, existingStatus: 'inbox', front: 'What is a deadlock?', differs: { back: { existing: 'Threads wait for each other **forever**.', proposed: 'A cycle of waits.' } } }])
    expect(added.errors).toEqual([{ index: 3, front: ' ', error: 'front is empty' }])

    const db = await call('add_facts', { deck: 'Databases', createDeck: true, autoApprove: true, facts: [{ front: 'What is MVCC?', back: 'Readers see a snapshot.' }] })
    expect(db).toMatchObject({ deck: { name: 'Databases', created: true }, created: [{ status: 'active' }] })

    const found = await call('search_facts', { query: 'forever' })
    expect(found).toMatchObject({ total: 1, facts: [{ id: deadlock, deck: 'Concurrency', status: 'inbox', tags: ['locks'], card: { state: 'new', suspended: false } }] })
    expect((await call('search_facts', { deck: 'English' })).error).toMatch(/language deck/)

    const edited = await call('update_fact', { id: deadlock, back: 'A cycle of threads, each waiting for the next.', tags: [] })
    expect(edited).toMatchObject({ front: 'What is a deadlock?', back: 'A cycle of threads, each waiting for the next.', tags: [], status: 'inbox' })
    expect((await call('update_fact', { id: added.created[1].id, front: 'What is a deadlock' })).error).toMatch(/already in this deck/)
    expect(await call('update_fact', { id: added.created[1].id, deck: 'Databases' })).toMatchObject({ deck: 'Databases' })

    const approved = await call('set_fact_status', { ids: [deadlock, 'ft_nope'], action: 'approve' })
    expect(approved.results).toEqual([{ id: deadlock, ok: true }, { id: 'ft_nope', ok: false, error: 'fact ft_nope not found' }])
    expect((await call('set_fact_status', { ids: [deadlock], action: 'suspend' })).results).toEqual([{ id: deadlock, ok: true }])
    expect((await call('search_facts', { deck: 'Concurrency' })).facts[0]).toMatchObject({ status: 'active', card: { suspended: true } })
    expect((await call('set_fact_status', { ids: [deadlock], action: 'delete' })).results).toEqual([{ id: deadlock, ok: true }])
    const decks = await call('list_decks')
    expect(decks.map((d: any) => [d.name, d.kind, d.counts.total])).toEqual([['English', 'language', 2], ['Concurrency', 'topic', 0], ['Databases', 'topic', 2]])
  })
})
