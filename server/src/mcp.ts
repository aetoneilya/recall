import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CEFR_LEVELS, PARTS_OF_SPEECH, wordFace, type Cefr, type PartOfSpeech, type WordStatus } from '@recall/core'
import type { Request, Response } from 'express'
import { z } from 'zod'
import type { AppContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import { tx } from './db.ts'
import { lexiconOf } from './lexicon.ts'
import {
  addWords, defaultDeck, deleteWord, HttpError, resolveDeck, searchWords, setWordStatus, setWordSuspended, syncFreqRanks,
  updateWord, withCards, type WordListItem, type WordRow,
} from './repo.ts'
import { decksWithCounts, leeches, stats, wordLogs } from './study.ts'
import { userDayOptions, type User } from './users.ts'

const INSTRUCTIONS = `Mnemosyne is the user's personal vocabulary trainer (spaced repetition, FSRS). The user is a Russian speaker learning English; each language they learn is one deck ("English": English terms, Russian translations).

Each word has two cards: forward (English → Russian, recognition) and reverse (Russian → English, production; its prompt shows the translations and the first example with the term blanked out as "___"). A deck can turn a direction off or delay reverse cards until the forward card is stable.

You can look up words, propose new ones, fix existing ones, and read progress (review_stats, get_leeches, vocabulary_profile) to suggest what to learn next. Words you add go to the user's inbox and are not studied until the user approves them in the app (autoApprove only when the user explicitly asks). A word is unique per deck by its normalised term (lowercase, "to " dropped) plus part of speech: adding an existing one returns its id and what your proposal would add instead of creating a copy — use update_word to merge in a new translation or example.

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
const status = z.enum(['inbox', 'active', 'rejected'])
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
  source: z.string().max(300).optional().describe('Where the word came from, e.g. a book title or an article.'),
  tags: z.array(z.string()).max(30).optional().describe('Free-form short tags, e.g. a topic.'),
}

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
  source: w.source,
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
    description: 'Lists the user\'s decks (one per language being learnt) with settings and counts. Words: total, active (being studied), inbox (proposals awaiting approval), known (a card in review with recall probability ≥ 90% now). Cards today: learning, due (learning + review), new (available today after the daily limit newPerDay). forwardEnabled / reverseEnabled: which directions are studied; reverseAfterDays: reverse cards start only once the forward card is that stable (null = immediately).',
    annotations: { readOnlyHint: true },
  }, guard(() => {
    defaultDeck(db, uid, ctx.now())
    return decksWithCounts(db, uid, opts, ctx.now())
  }))

  server.registerTool('search_words', {
    title: 'Search words',
    description: 'Finds words by substring (over the term, translations, examples, note, tags and source; case-insensitive for Latin letters only), deck, status, part of speech or CEFR level, newest first. Each result has both cards\' state (new / learning / review / relearning), due date, stability in days, lapses and current recall probability. Use it before adding words to catch near-duplicates the exact check would miss (e.g. a different part of speech), and to find words to fix.',
    inputSchema: {
      query: z.string().optional().describe('Substring to look for.'),
      deck: z.string().optional().describe('Deck name, id or language code ("en"); default all decks.'),
      status: status.optional().describe('inbox = proposed, awaiting approval; active = being studied; rejected = declined by the user.'),
      pos: pos.optional(),
      cefr: cefr.optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guard((a) => {
    lex()
    const r = searchWords(db, uid, { deck: a.deck, q: a.query, status: a.status, pos: a.pos, cefr: a.cefr, limit: a.limit ?? 20, offset: a.offset }, ctx.now())
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
    description: 'Proposes up to 100 words for a deck (default: the user\'s English deck). They land in the user\'s inbox and are not studied until the user approves them in the app; autoApprove: true makes them active at once — use it only when the user asked. Every word gets a forward and a reverse card. A word whose normalised term + part of speech already exists in the deck (any status, including rejected) is not added: it is reported under duplicates with the existing id, its status and `differs` — what your proposal has that the existing word lacks (newTranslations, newExamples, a different ipa / note / cefr / source / term spelling); merge those with update_word if they are worth it. Invalid words are reported under errors. Freshly created words report their frequency rank (1 = most common lemma; null = not in the 30k list or multi-word with a rare part).',
    inputSchema: {
      deck: z.string().optional().describe('Deck name, id or language code; default the English deck.'),
      words: z.array(z.object(fields)).min(1).max(100),
      autoApprove: z.boolean().optional().describe('Default false: words go to the inbox.'),
    },
  }, guard((a) => addWords(db, uid, { deck: a.deck, words: a.words, autoApprove: a.autoApprove, createdBy: 'claude' }, ctx.now(), lex())))

  server.registerTool('update_word', {
    title: 'Update word',
    description: 'Edits a word; only the fields you pass change (arrays replace the whole list: to add a translation, pass the existing ones plus the new one). Pass null to clear ipa, note, cefr or source. Both cards keep their schedule and review history whatever you change. Changing term or pos to one that already exists in the deck fails with a duplicate error. The word keeps its status.',
    inputSchema: {
      id: z.string(),
      term: fields.term.optional(),
      pos: pos.optional(),
      translations: fields.translations.optional(),
      ipa: z.string().nullable().optional(),
      examples: fields.examples,
      note: z.string().max(2000).nullable().optional(),
      cefr: cefr.nullable().optional(),
      source: z.string().max(300).nullable().optional(),
      tags: fields.tags,
    },
  }, guard((a) => {
    const { id, ...patch } = a
    updateWord(db, uid, id, patch, ctx.now(), lex())
    return brief(item(id))
  }))

  server.registerTool('set_word_status', {
    title: 'Set word status',
    description: 'Applies one action to several words: approve (inbox → active, starts studying), reject (→ rejected: never studied, kept so the same proposal is recognised as a duplicate), suspend / unsuspend (both cards stop or resume being scheduled, history kept), delete (removes the word, its cards and their review history permanently — prefer suspend or reject unless the user asked to delete).',
    inputSchema: {
      ids: z.array(z.string()).min(1).max(200).describe('Word ids.'),
      action: z.enum(['approve', 'reject', 'delete', 'suspend', 'unsuspend']),
    },
  }, guard(({ ids, action }) => {
    const now = ctx.now()
    const results: { id: string; ok: boolean; error?: string }[] = []
    tx(db, () => {
      for (const id of ids) {
        try {
          if (action === 'delete') deleteWord(db, uid, id)
          else if (action === 'approve') setWordStatus(db, uid, id, 'active', now)
          else if (action === 'reject') setWordStatus(db, uid, id, 'rejected' as WordStatus, now)
          else setWordSuspended(db, uid, id, action === 'suspend')
          results.push({ id, ok: true })
        } catch (e) {
          results.push({ id, ok: false, error: (e as Error).message })
        }
      }
    })
    return { action, results }
  }))

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
    const deck = deckOf(a.deck)
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
      inbox: d.counts.words.inbox,
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
