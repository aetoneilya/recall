import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CEFR_LEVELS, PARTS_OF_SPEECH, wordFace, type Cefr, type PartOfSpeech } from '@recall/core'
import type { Request, Response } from 'express'
import { z } from 'zod'
import type { AppContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import { addPack, listPacks } from './packs.ts'
import { addExercises, listExercises } from './exercises.ts'
import { addFacts, deleteFact, factItem, searchFacts, setFactSuspended, updateFact, type FactItem } from './facts.ts'
import { tx } from './db.ts'
import { lexiconOf } from './lexicon.ts'
import {
  addWords, createDeck, defaultDeck, deleteWord, HttpError, mustHaveLanguages, resolveDeck, searchWords, setWordStatus, setWordSuspended, syncFreqRanks, tagList,
  updateWord, withCards, type WordListItem, type WordRow,
} from './repo.ts'
import { decksWithCounts, leeches, stats, wordLogs } from './study.ts'
import { userDayOptions, type User } from './users.ts'

const INSTRUCTIONS = `Mnemosyne is the user's personal vocabulary trainer (spaced repetition, FSRS). The user is a Russian speaker learning English; each language they learn is one deck ("English": English terms, Russian translations).

Decks are big containers ("English", "Programming") holding cards of any type: words (only in a deck with languages), question/answer facts, and grammar rules (facts with an exercise pool). Subjects inside a deck — Java Core, Databases, Grammar — are tags, not decks. A tag with "/" is a path ("Grammar/Tenses", "Books/wuthering heights"): searching or filtering by a tag also finds the tags under it. The fact tools (create_deck, search_facts, add_facts, update_fact, set_fact_status) work on any deck. A fact has a question (front) and an answer (back), both Markdown; one card each; the user reviews one deck at a time. Good facts: one idea per card; a question with one clear answer (not "tell me about X"); a short answer — a few sentences or a short list, **bold** for the key point, \`code\` for identifiers, a fenced block only for a few lines of code. Facts you add are studied at once, like words.

Each word has two cards: forward (English → Russian, recognition) and reverse (Russian → English, production; its prompt shows the translations and the first example with the term blanked out as "___"). A deck can turn a direction off or delay reverse cards until the forward card is stable.

You can look up words, propose new ones, fix existing ones, and read progress (review_stats, get_leeches, vocabulary_profile) to suggest what to learn next. Everything you add (words and facts) is studied at once and tagged "claude"; the user drops what they don't want (status rejected), and a dropped card is never shown again — the duplicate check sees it, so don't propose it again. Add what the user asked for, not more. A word is unique per deck by its normalised term (lowercase, "to " dropped) plus part of speech: adding an existing one returns its id and what your proposal would add instead of creating a copy — use update_word to merge in a new translation or example.

Good words: term in base form ("to frown", "a chicken-and-egg situation", "to give up"), the right part of speech, 1–4 natural Russian translations with the most common first, General American IPA without slashes, 1–2 short natural example sentences that contain the term (inflected forms are fine) with Russian translations, a CEFR guess, and a short usage note in Russian when it helps (register, collocations, false friends).`

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

// Domain errors become tool errors Claude can read instead of protocol errors.
function guard<A>(fn: (args: A) => unknown): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return json(await fn(args))
    } catch (e) {
      const message = e instanceof HttpError || e instanceof Error ? e.message : String(e)
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  }
}

const tuple = <T extends string>(xs: readonly T[]) => xs as unknown as [T, ...T[]]
const pos = z.enum(tuple<PartOfSpeech>(PARTS_OF_SPEECH))
const cefr = z.enum(tuple<Cefr>(CEFR_LEVELS))
const status = z.enum(['active', 'rejected'])
const direction = z.enum(['forward', 'reverse'])

const fields = {
  term: z.string().min(1).max(200).describe('English base form as a learner would look it up: "to frown", "frown" (noun), "to give up", "a far cry from".'),
  pos: pos.describe('Part of speech. Multi-word expressions: phrasal_verb, idiom or phrase. Part of the uniqueness key.'),
  translations: z.array(z.string().min(1)).min(1).max(10).describe('Russian translations, most common first.'),
  ipa: z.string().optional().describe('General American IPA without slashes, e.g. "fraʊn".'),
  examples: z.array(z.object({
    text: z.string().min(1).describe('English sentence containing the term (any inflection).'),
    translation: z.string().optional().describe('Its Russian translation.'),
  })).max(5).optional().describe('1–2 short natural examples; the first one is shown on the cards.'),
  note: z.string().max(2000).optional().describe('Short usage note in Russian: register, collocations, pitfalls.'),
  cefr: cefr.optional().describe('CEFR level estimate.'),
  tags: z.array(z.string()).max(30).optional().describe('Free-form short tags, e.g. a topic or the book or article the word came from.'),
}

const FACT_RULES = 'Front: one question with one clear answer, standalone (no "as above"). Back: the answer in Markdown — a few sentences or a short "-" / "1." list; **bold** the key point, `code` for identifiers, ``` fenced blocks only for short code. One idea per card: split a big topic into several facts rather than one long answer.'

const factFields = {
  front: z.string().min(1).max(2000).describe('The question, Markdown. Unique per deck (case, spacing and the final "?" ignored).'),
  back: z.string().min(1).max(20000).describe('The answer, Markdown.'),
  tags: z.array(z.string()).max(30).optional().describe('Short tags, e.g. the note or source it came from.'),
}

const factBrief = (f: FactItem) => ({
  id: f.id,
  deck: f.deckName,
  deckId: f.deckId,
  front: f.front,
  back: f.back,
  tags: f.tags,
  status: f.status,
  createdBy: f.createdBy,
  createdAt: f.createdAt,
  card: f.card && { state: f.card.state, suspended: f.card.suspended, due: f.card.due, stabilityDays: f.card.stability, lapses: f.card.lapses, retrievability: f.card.retrievability },
})

const brief = (w: WordListItem) => ({
  id: w.id,
  deck: w.deckName,
  term: w.term,
  pos: w.pos,
  translations: w.translations,
  ipa: w.ipa,
  examples: w.examples,
  note: w.note,
  cefr: w.cefr,
  freqRank: w.freqRank,
  tags: w.tags,
  status: w.status,
  createdBy: w.createdBy,
  createdAt: w.createdAt,
  cards: Object.fromEntries((['forward', 'reverse'] as const).map((d) => {
    const c = w.cards[d]
    return [d, c && { state: c.state, enabled: c.enabled, suspended: c.suspended, due: c.due, stabilityDays: c.stability, lapses: c.lapses, retrievability: c.retrievability }]
  })),
})

// One server per request, bound to the authenticated user: every tool sees
// only that user's collection.
export function buildMcpServer(ctx: AppContext, user: User): McpServer {
  const { db, cfg } = ctx
  const uid = user.id
  const opts = userDayOptions(cfg, user)
  const server = new McpServer({ name: 'mnemosyne', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const lex = () => {
    const l = lexiconOf(ctx)
    syncFreqRanks(db, l)
    return l
  }
  const deckOf = (ref: string | undefined) => {
    if (!ref) return defaultDeck(db, uid, ctx.now())
    const d = resolveDeck(db, uid, ref)
    if (!d) throw new HttpError(404, `no deck "${ref}"; call list_decks to see the existing ones`)
    return d
  }
  const item = (id: string) => {
    const row = db.prepare('SELECT * FROM words WHERE id = ? AND user_id = ?').get(id, uid) as WordRow | undefined
    if (!row) throw new HttpError(404, `word ${id} not found`)
    return withCards(db, uid, [row], ctx.now())[0]!
  }

  server.registerTool('list_decks', {
    title: 'List decks',
    description: 'Lists the user\'s decks with settings and counts. A deck holds cards of any type; targetLang / nativeLang (both or neither) say whether it takes words (the word tools work only on such decks; one per language). tags: the tags used in the deck with counts (subjects such as "Concurrency" are tags). reviewFilter: what the user\'s review session of the deck takes (null = everything). Counts — words and facts: total, active (being studied), dropped (rejected by the user, never shown), known (a card in review with recall probability ≥ 90% now). Cards today: learning, due (learning + review), new (available today after the daily limit newPerDay). Word cards only: forwardEnabled / reverseEnabled: which directions are studied; reverseAfterDays: reverse cards start only once the forward card is that stable (null = immediately).',
    annotations: { readOnlyHint: true },
  }, guard(() => {
    defaultDeck(db, uid, ctx.now())
    return decksWithCounts(db, uid, opts, ctx.now())
  }))

  server.registerTool('search_words', {
    title: 'Search words',
    description: 'Finds words by substring (over the term, translations, examples, note and tags; case-insensitive for Latin letters only), deck, status, part of speech or CEFR level, newest first. Each result has both cards\' state (new / learning / review / relearning), due date, stability in days, lapses and current recall probability. Use it before adding words to catch near-duplicates the exact check would miss (e.g. a different part of speech), and to find words to fix.',
    inputSchema: {
      query: z.string().optional().describe('Substring to look for.'),
      deck: z.string().optional().describe('Deck name, id or language code ("en"); default all decks.'),
      status: status.optional().describe('active = being studied; rejected = dropped by the user, never shown.'),
      pos: pos.optional(),
      cefr: cefr.optional(),
      tag: z.string().optional().describe('Only words with this tag or one under it ("Books" finds "Books/wuthering heights").'),
      tags: z.array(z.string()).max(10).optional().describe('Only words carrying every one of these tags (each or one under it), with tag.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guard((a) => {
    lex()
    const r = searchWords(db, uid, { deck: a.deck, q: a.query, status: a.status, pos: a.pos, cefr: a.cefr, tag: [...tagList(a.tag), ...(a.tags ?? [])], limit: a.limit ?? 20, offset: a.offset }, ctx.now())
    return { total: r.total, words: r.words.map(brief) }
  }))

  server.registerTool('get_word', {
    title: 'Get word',
    description: 'Returns one word with both cards (rendered front/back, state, due, stability, lapses, recall probability) and its most recent ratings (1 Again, 2 Hard, 3 Good, 4 Easy) per card.',
    inputSchema: { id: z.string().describe('Word id, e.g. wd_abc123.') },
    annotations: { readOnlyHint: true },
  }, guard(({ id }) => {
    const w = item(id)
    const logs = wordLogs(db, uid, id, 20)
    return {
      ...brief(w),
      faces: { forward: wordFace(w, 'forward'), reverse: wordFace(w, 'reverse') },
      recentReviews: logs.map((l) => ({ direction: l.cardId === w.cards.forward?.id ? 'forward' : 'reverse', rating: l.rating, reviewedAt: l.reviewedAt })),
    }
  }))

  server.registerTool('add_words', {
    title: 'Add words',
    description: 'Adds up to 100 words to a deck (default: the user\'s English deck). They are studied at once (within the deck\'s daily limit of new cards) and get the tag "claude". Every word gets a forward and a reverse card. A word whose normalised term + part of speech already exists in the deck (any status, including rejected = dropped by the user) is not added: it is reported under duplicates with the existing id, its status and `differs` — what your proposal has that the existing word lacks (newTranslations, newExamples, a different ipa / note / cefr / term spelling); merge those with update_word if they are worth it. Invalid words are reported under errors. Freshly created words report their frequency rank (1 = most common lemma; null = not in the 30k list or multi-word with a rare part).',
    inputSchema: {
      deck: z.string().optional().describe('Deck name, id or language code; default the English deck.'),
      words: z.array(z.object(fields)).min(1).max(100),
    },
  }, guard((a) => addWords(db, uid, { deck: a.deck, words: a.words, createdBy: 'claude' }, ctx.now(), lex())))

  server.registerTool('update_word', {
    title: 'Update word',
    description: 'Edits a word; only the fields you pass change (arrays replace the whole list: to add a translation, pass the existing ones plus the new one). Pass null to clear ipa, note or cefr. Both cards keep their schedule and review history whatever you change. Changing term or pos to one that already exists in the deck fails with a duplicate error. The word keeps its status.',
    inputSchema: {
      id: z.string(),
      term: fields.term.optional(),
      pos: pos.optional(),
      translations: fields.translations.optional(),
      ipa: z.string().nullable().optional(),
      examples: fields.examples,
      note: z.string().max(2000).nullable().optional(),
      cefr: cefr.nullable().optional(),
      tags: fields.tags,
    },
  }, guard((a) => {
    const { id, ...patch } = a
    updateWord(db, uid, id, patch, ctx.now(), lex())
    return brief(item(id))
  }))

  server.registerTool('set_word_status', {
    title: 'Set word status',
    description: 'Applies one action to several words: drop (→ rejected: never shown again, kept so the same word is recognised as a duplicate), restore (a dropped word → active again), suspend / unsuspend (both cards stop or resume being scheduled, history kept), delete (removes the word, its cards and their review history permanently — prefer drop or suspend unless the user asked to delete).',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(200).describe('Word ids.'),
      action: z.enum(['drop', 'restore', 'delete', 'suspend', 'unsuspend']),
    },
  }, guard(({ ids, action }) => {
    const now = ctx.now()
    const results: { id: string; ok: boolean; error?: string }[] = []
    tx(db, () => {
      for (const id of ids) {
        try {
          if (action === 'delete') deleteWord(db, uid, id)
          else if (action === 'drop' || action === 'restore') setWordStatus(db, uid, id, action === 'drop' ? 'rejected' : 'active', now)
          else setWordSuspended(db, uid, id, action === 'suspend')
          results.push({ id, ok: true })
        } catch (e) {
          results.push({ id, ok: false, error: (e as Error).message })
        }
      }
    })
    return { action, results }
  }))

  const createDeckTool = guard(({ name, targetLang, nativeLang }: { name: string; targetLang?: string; nativeLang?: string }) =>
    createDeck(db, uid, { name, targetLang: targetLang ?? null, nativeLang: nativeLang ?? null }, ctx.now()))
  const createDeckSchema = {
    name: z.string().min(1).max(100).describe('Deck name, e.g. "Programming". Subjects inside a deck are tags, not decks.'),
    targetLang: z.string().optional().describe('Only for a deck that takes words: the language being learnt (ISO 639-1); give nativeLang too.'),
    nativeLang: z.string().optional(),
  }
  server.registerTool('create_deck', {
    title: 'Create deck',
    description: 'Creates an empty deck: a big container for cards of any type (5 new cards a day without languages). Prefer adding cards to an existing deck with a tag for the subject; create a deck only when the user wants a separate one. Names are unique among the user\'s decks — call list_decks first.',
    inputSchema: createDeckSchema,
  }, createDeckTool)
  server.registerTool('create_topic', {
    title: 'Create deck (old name)',
    description: 'Same as create_deck; kept for older prompts.',
    inputSchema: createDeckSchema,
  }, createDeckTool)

  server.registerTool('search_facts', {
    title: 'Search facts',
    description: 'Finds facts by substring over question, answer and tags (case-insensitive for Latin letters only), deck, tag or status, oldest first. Each result has its card state (new / learning / review / relearning), due date, stability in days, lapses and recall probability. Use it before add_facts to avoid near-duplicates the exact question check would miss.',
    inputSchema: {
      query: z.string().optional().describe('Substring to look for.'),
      deck: z.string().optional().describe('Deck name or id; default all.'),
      tag: z.string().optional().describe('Only facts with this tag or one under it, e.g. "Concurrency"; "Grammar" also finds "Grammar/Tenses".'),
      tags: z.array(z.string()).max(10).optional().describe('Only facts carrying every one of these tags (each or one under it), with tag.'),
      status: status.optional().describe('active = being studied; rejected = dropped by the user, never shown.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guard((a) => {
    if (a.deck) deckOf(a.deck)
    const r = searchFacts(db, uid, { deck: a.deck, q: a.query, tag: [...tagList(a.tag), ...(a.tags ?? [])], status: a.status, limit: a.limit ?? 20, offset: a.offset }, ctx.now())
    return { total: r.total, facts: r.facts.map(factBrief) }
  }))

  server.registerTool('add_facts', {
    title: 'Add facts',
    description: `Proposes up to 100 question/answer flashcards for a deck, e.g. generated from the user's notes; give the subject as a tag (tags, e.g. ["Kafka"]) rather than a new deck. They are studied at once (within the deck's daily limit of new cards) and get the tag "claude". A fact whose question already exists in the deck (any status, including rejected = dropped by the user) is not added: it is reported under duplicates with the existing id, its status and what differs (back, newTags) — use update_fact to merge. Invalid facts are reported under errors. ${FACT_RULES}`,
    inputSchema: {
      deck: z.string().min(1).describe('Deck name or id, e.g. "Programming".'),
      tags: z.array(z.string()).max(10).optional().describe('Tags for every fact, e.g. the subject: ["Kafka"]. Each fact can add its own.'),
      facts: z.array(z.object(factFields)).min(1).max(100),
      createDeck: z.boolean().optional().describe('Create the deck if no deck has this name. Default false: an unknown deck is an error.'),
    },
  }, guard((a) => addFacts(db, uid, { deck: a.deck, tags: a.tags, facts: a.facts, createDeck: a.createDeck, createdBy: 'claude' }, ctx.now())))

  server.registerTool('update_fact', {
    title: 'Update fact',
    description: `Edits a fact; only the fields you pass change (tags replace the list). deck moves it to another deck. The card keeps its schedule and review history. A question that already exists in the target deck fails with a duplicate error. The fact keeps its status. ${FACT_RULES}`,
    inputSchema: {
      id: z.string().describe('Fact id, e.g. ft_abc123.'),
      front: factFields.front.optional(),
      back: factFields.back.optional(),
      tags: factFields.tags,
      deck: z.string().optional().describe('Deck name or id to move it to.'),
    },
  }, guard((a) => {
    const { id, deck, ...patch } = a
    updateFact(db, uid, id, { ...patch, ...(deck ? { deckId: deck } : {}) }, ctx.now())
    return factBrief(factItem(db, uid, id, ctx.now()))
  }))

  server.registerTool('set_fact_status', {
    title: 'Set fact status',
    description: 'Applies one action to several facts: drop (→ rejected: never shown again, kept so the same question is recognised as a duplicate), restore (a dropped fact → active again), suspend / unsuspend (the card stops or resumes being scheduled, history kept), delete (removes the fact, its card and review history permanently — prefer drop or suspend unless the user asked to delete).',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(200).describe('Fact ids.'),
      action: z.enum(['drop', 'restore', 'delete', 'suspend', 'unsuspend']),
    },
  }, guard(({ ids, action }) => {
    const now = ctx.now()
    const results: { id: string; ok: boolean; error?: string }[] = []
    tx(db, () => {
      for (const id of ids) {
        try {
          if (action === 'delete') deleteFact(db, uid, id)
          else if (action === 'drop' || action === 'restore') updateFact(db, uid, id, { status: action === 'drop' ? 'rejected' : 'active' }, now)
          else setFactSuspended(db, uid, id, action === 'suspend')
          results.push({ id, ok: true })
        } catch (e) {
          results.push({ id, ok: false, error: (e as Error).message })
        }
      }
    })
    return { action, results }
  }))

  server.registerTool('list_packs', {
    title: 'List content packs',
    description: 'Ready-made sets of cards the app ships (e.g. "Irregular verbs"): id, name, description, count of cards, whether the user has added it (added, deckId) and how many of its cards they still lack (missing; for the grammar handbook also missingExercises). Suggest one when it fits what the user wants to learn; add it only when they agree.',
    annotations: { readOnlyHint: true },
  }, guard(() => listPacks(db, uid)))

  server.registerTool('add_pack', {
    title: 'Add content pack',
    description: 'Adds a content pack\'s cards to a deck (default: irregular verbs and the grammar handbook into the English deck, other packs into a deck named after the pack), each tagged with the pack\'s name (the grammar handbook: "Grammar/<the topic\'s group>" on rules and theory cards alike); they are active at once, introduced in the pack\'s order (most useful first). The grammar handbook adds per topic a rule (title → cheat sheet) with its exercise pool, and the theory cards; `exercises` = items added to rules. Running it again adds only what the user lacks, including new exercises of rules already added. Only when the user asked for it.',
    inputSchema: { id: z.string().describe('Pack id from list_packs.'), deck: z.string().optional().describe('Deck name or id to add it to.') },
  }, guard(({ id, deck }) => {
    const r = addPack(db, uid, id, ctx.now(), { deckId: deck })
    return { deck: { id: r.deck.id, name: r.deck.name }, added: r.added, alreadyAdded: r.alreadyAdded, duplicates: r.duplicates, exercises: r.exercises }
  }))

  const EXERCISE_RULES = 'Items are answered by tapping on a phone, so write the tap types. choose: {type, text with exactly one "___", options (2–4), answer (one of the options)} — e.g. text "The backup runs ___ 3 a.m.", options ["at", "in", "on"], answer "at"; "—" as an option means nothing there (the zero article). spot: {type, text: a natural sentence with exactly one mistake, wrong: the wrong whole word(s) as they appear (once) in the text, options (1–4 replacements), answer (one of them)} — e.g. "His shoes gets wet every time it rains.", wrong "gets", options ["get", "getting", "got"], answer "get"; "—" as the answer means "delete it" ("See you on next week."). Each item practises the fact\'s rule (read it with search_facts first). Take the distractors from the rule\'s own contrast set (at / in / on; a / the / —; is / are), make exactly one option grammatical in that sentence, and give no hint that translates or names the answer. `explain`: one short line on why, in Russian. Vary contexts, subjects and the two types. Besides those, write: {type: "write", text: a task in Russian asking the learner to write their own sentence with the rule, e.g. "Напиши предложение о своём опыте с present perfect (ever/never)", rubric (optional, ≤ 500): what a right answer must do, for the grader — e.g. "Uses have/has + past participle with ever or never; no finished-time word"} — no answer or options. The server grades the sentence with Claude; at most one write item per review, and only where grading is available, so a rule still needs 3 tap items. One or two write items per rule are plenty. Legacy typed types are still accepted but not wanted: gap (text with "___" and a hint in parentheses, typed answer), fix (answer = the corrected sentence), rewrite ("sentence → cue ___"), each with optional `accepted` variants.'

  server.registerTool('list_exercises', {
    title: 'List exercises',
    description: 'The exercise pool of a fact (a grammar rule): every item with its type, prompt (the task for write items, with their rubric), answer, accepted variants, explain, status (active / flagged: taken out of the pool by the user as a bad item), needsReview (the user said "I was right" on it), and how it went: shownCount, correctCount, wrongCount, lastShownAt. A fact with at least 3 active items other than write is reviewed through 3 of them at a time (one may be a write item where grading is available). Use it to see what is there before add_exercises and to spot items that need fixing.',
    inputSchema: { factId: z.string().describe('Fact id, e.g. ft_abc123.') },
    annotations: { readOnlyHint: true },
  }, guard(({ factId }) => listExercises(db, uid, factId)))

  server.registerTool('add_exercises', {
    title: 'Add exercises',
    description: `Adds up to 50 exercise items to a fact's pool (the fact becomes a rule reviewed through its exercises once it has 3 active items other than write). They are active at once. An item whose prompt (normalised) is already in the pool is not added: it is reported under duplicates with the existing id and status. Invalid items (a choose text without exactly one "___" or with the answer not among 2–4 options; a spot whose wrong word(s) don't occur exactly once as whole words, or whose options repeat them; legacy shape errors) are reported under errors. Once a rule has 3 active tap items, reviews use only tap items. ${EXERCISE_RULES}`,
    inputSchema: {
      factId: z.string(),
      items: z.array(z.object({
        type: z.enum(['choose', 'spot', 'write', 'gap', 'fix', 'rewrite']).describe('choose or spot; write = the learner writes a sentence (graded by Claude); gap / fix / rewrite are legacy typed items.'),
        text: z.string().min(1).max(500).optional().describe('The sentence; for write, the task in Russian.'),
        prompt: z.string().min(1).max(500).optional().describe('Same as text (legacy name).'),
        options: z.array(z.string().min(1).max(100)).max(4).optional().describe('choose: 2–4 options; spot: 1–4 replacements. "—" = nothing.'),
        wrong: z.string().max(200).optional().describe('spot: the wrong word(s), exactly as they appear once in the text.'),
        answer: z.string().min(1).max(300).optional().describe('Every type but write: the right answer.'),
        rubric: z.string().max(500).optional().describe('write only: what a right answer must do, for the grader.'),
        accepted: z.array(z.string()).max(10).optional().describe('Legacy typed types only: other answers that are just as right.'),
        explain: z.string().max(500).optional(),
      })).min(1).max(50),
    },
  }, guard((a) => addExercises(db, uid, a.factId, a.items, 'claude', ctx.now())))

  server.registerTool('review_stats', {
    title: 'Review stats',
    description: 'Review statistics for the last `days` study days (default 30), optionally for one deck: reviews per day (with Again counts), retention (share of non-Again ratings on cards in review state, 0..1) overall and per direction, due forecast for the next 14 days and card counts by state. Disabled directions are left out.',
    inputSchema: {
      deck: z.string().optional().describe('Deck name, id or language code.'),
      days: z.number().int().min(1).max(365).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guard((a) => stats(db, uid, opts, ctx.now(), { days: a.days ?? 30, deckId: a.deck ? deckOf(a.deck).id : undefined })))

  server.registerTool('get_leeches', {
    title: 'Get leeches',
    description: 'Words whose cards keep failing: cards with at least minLapses lapses (default 4), optionally of one direction, with their last ratings (oldest → newest; 1 Again … 4 Easy). Use it to improve those words — a clearer main translation, a better first example (it is what the reverse card blanks), a usage note that separates confusable words — with update_word, which keeps the history.',
    inputSchema: {
      deck: z.string().optional().describe('Deck name, id or language code.'),
      direction: direction.optional().describe('forward = English → Russian, reverse = Russian → English.'),
      minLapses: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Max words, default 20.'),
    },
    annotations: { readOnlyHint: true },
  }, guard((a) => leeches(db, uid, { deckId: a.deck ? deckOf(a.deck).id : undefined, direction: a.direction, minLapses: a.minLapses ?? 4, limit: a.limit ?? 20 })))

  server.registerTool('vocabulary_profile', {
    title: 'Vocabulary profile',
    description: 'A summary of where the user stands, to suggest what to learn next: estimated vocabulary size in English lemmas (within a 30,000-lemma frequency list; from the last Yes/No test combined with words known in the app), its approximate native-speaker equivalent and CEFR-like level, coverage per frequency band (words in the app / known), counts per direction, retention, the weakest words (most lapses) and parts of speech and CEFR levels in the deck. Frequent bands with low coverage are the best source of new words; leeches need better cards rather than more words.',
    inputSchema: { deck: z.string().optional().describe('Deck name, id or language code; default the English deck.') },
    annotations: { readOnlyHint: true },
  }, guard((a) => {
    const l = lex()
    const deck = mustHaveLanguages(deckOf(a.deck))
    const d = dashboard(db, uid, deck, l, opts, ctx.now())
    const v = d.vocabulary
    const cur = v.current
    const mix = (col: 'pos' | 'cefr') => Object.fromEntries((db.prepare(`SELECT coalesce(${col}, 'unknown') AS k, count(*) AS n FROM words WHERE user_id = ? AND deck_id = ? AND status = 'active' GROUP BY 1 ORDER BY 2 DESC`)
      .all(uid, deck.id) as { k: string; n: number }[]).map((r) => [r.k, r.n]))
    return {
      deck: { id: deck.id, name: deck.name, targetLang: deck.targetLang, nativeLang: deck.nativeLang, forwardEnabled: deck.forwardEnabled, reverseEnabled: deck.reverseEnabled },
      words: d.counts.words,
      knownWords: d.counts.known,
      masteredWords: d.counts.mastered,
      directions: d.counts.directions,
      vocabularySize: cur && {
        inListLemmas: cur.adjusted,
        fromLastTest: v.latestTest?.estimate ?? null,
        lastTestAt: v.latestTest?.completedAt ?? null,
        lastTestReliability: v.latestTest?.reliability ?? null,
        knownInApp: cur.srsKnown,
        basis: cur.basis,
        nativeEquivalentApprox: cur.nativeEquivalent.value,
        cefrLike: cur.cefr.level?.id ?? null,
        nextMilestone: cur.scale.native?.next ? { label: cur.scale.native.next.label, nativeEquivalent: cur.scale.native.next.size } : null,
      },
      coverage: d.coverage.map((b) => ({ ranks: `${b.from}-${b.to}`, wordsInApp: b.words, knownInApp: b.known, testShareKnown: cur ? bandShare(cur.perBand, b.from, b.to) : null })),
      retention30d: d.retention,
      streak: d.activity.streak,
      partsOfSpeech: mix('pos'),
      cefrLevels: mix('cefr'),
      weakest: leeches(db, uid, { deckId: deck.id, minLapses: 2, limit: 10 }).map((x) => ({ id: x.wordId, term: x.term, translations: x.translations, maxLapses: x.maxLapses, directions: x.cards.map((c) => c.direction) })),
    }
  }))

  return server
}

// Mean test share known over the test bands inside [from, to].
function bandShare(perBand: { from: number; to: number; known: number; items: number }[], from: number, to: number): number | null {
  const inside = perBand.filter((b) => b.from >= from && b.to <= to)
  if (!inside.length || inside.every((b) => !b.items)) return null
  return Math.round((inside.reduce((s, b) => s + b.known, 0) / inside.length) * 100) / 100
}

// Stateless Streamable HTTP: a fresh server and transport per request.
export async function handleMcp(ctx: AppContext, user: User, req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
    return
  }
  const server = buildMcpServer(ctx, user)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
