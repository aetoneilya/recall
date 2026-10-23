import {
  CEFR_LEVELS, FACT_STATUSES, PARTS_OF_SPEECH, WORD_STATUSES, type Cefr, type FactStatus, type PartOfSpeech, type WordStatus,
} from '@recall/core'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { checkPassword, clearedCookie, createSession, deleteSession, LoginLimiter, readCookie, requireUser, SESSION_COOKIE, sessionCookie } from './auth.ts'
import { autofill } from './autofill.ts'
import { isTime, isTimeZone } from './config.ts'
import type { AppContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import { gradeWrite, GRADE_TEXT_MAX, gradingAvailable } from './grade.ts'
import { addPack, handbook, listPacks } from './packs.ts'
import { PRACTICE_LIMIT, practiceDeck, practiceRule } from './practice.ts'
import { addExercises, deleteExercise, listExercises, updateExercise } from './exercises.ts'
import { createFact, deleteFact, factItem, getFact, searchFacts, setFactSuspended, updateFact } from './facts.ts'
import { fsrsInfo, optimizeNow, REQUEST_RETENTION } from './fsrs.ts'
import { lexiconOf } from './lexicon.ts'
import { createLoginNonce, pollLoginNonce, START_PREFIX } from './login.ts'
import {
  cardSummary, createDeck, createWord, defaultDeck, deleteDeck, deleteWord, getDeck, HttpError, mergeDecks, mustGetWord, mustHaveLanguages, resolveDeck,
  searchWords, setSuspended, setWordStatus, setWordSuspended, syncFreqRanks, TYPE_ANSWERS, updateDeck, updateWord, withCards, WORD_SORTS,
  type TypeAnswer, type WordRow, type WordSort,
} from './repo.ts'
import { addExtraNew, applyReviews, buildQueue, decksWithCounts, factLogs, reviewOptions, stats, studyDay, undoReview, wordLogs } from './study.ts'
import { retagDeck } from './tags.ts'
import { createApiToken, deleteApiToken, listApiTokens } from './tokens.ts'
import { allowedUser, isOwner, ownerUser, updateUserSettings, userDayOptions, type User } from './users.ts'
import { answerVocabTest, createVocabTest, listVocabTests } from './vocab.ts'

// Per review: attempts kept and the answer text stored.
const MAX_ATTEMPTS = 10
const GIVEN_MAX = 500

const tuple = <T extends string>(xs: readonly T[]) => xs as unknown as [T, ...T[]]
export const posSchema = z.enum(tuple<PartOfSpeech>(PARTS_OF_SPEECH))
export const cefrSchema = z.enum(tuple<Cefr>(CEFR_LEVELS))
const statusSchema = z.enum(tuple<WordStatus>(WORD_STATUSES))
const sortSchema = z.enum(tuple<WordSort>(WORD_SORTS))

// One odd field of one review mustn't refuse the whole upload (the outbox
// would resend it forever): what can be cut to size is, per item. Only what
// the rating can't do without (ids, card, rating, time) is strict.
const ReviewsBody = z.array(z.object({
  id: z.string().min(1).max(100),
  cardId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  // Stored and sorted as UTC, whatever offset it came with.
  reviewedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString()),
  durationMs: z.number().transform((n) => Math.max(0, Math.round(n))).optional(),
  exercises: z.array(z.object({
    // A longer id matches no item; recordAttempts skips it.
    id: z.string(),
    given: z.string().transform((s) => s.slice(0, GIVEN_MAX)),
    correct: z.boolean(),
    overridden: z.boolean().optional(),
    bad: z.boolean().optional(),
  })).transform((xs) => xs.slice(0, MAX_ATTEMPTS)).optional(),
})).max(5000)

const ExampleBody = z.object({ text: z.string(), translation: z.string().nullable().optional() })
const WordFields = {
  term: z.string(),
  pos: posSchema,
  translations: z.array(z.string()),
  ipa: z.string().nullable().optional(),
  examples: z.array(ExampleBody).optional(),
  note: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  cefr: cefrSchema.nullable().optional(),
}
const WordBody = z.object({ deckId: z.string().optional(), ...WordFields })
const WordPatchBody = z.object({ ...WordFields, status: statusSchema }).partial()
const typeAnswerSchema = z.enum(tuple<TypeAnswer>(TYPE_ANSWERS))
const DeckBody = z.object({
  name: z.string().optional(),
  // Both or neither: a deck with languages takes words.
  targetLang: z.string().nullable().optional(),
  nativeLang: z.string().nullable().optional(),
  newPerDay: z.number().int().optional(),
  typeAnswer: typeAnswerSchema.optional(),
}).strict()
const ReviewFilterBody = z.object({
  types: z.array(z.enum(['word', 'fact', 'rule'])).optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  pos: z.array(posSchema).optional(),
  cefr: z.array(cefrSchema).optional(),
  directions: z.array(z.enum(['forward', 'reverse'])).optional(),
}).strict()
const DeckPatchBody = z.object({
  name: z.string(),
  newPerDay: z.number().int(),
  reviewFilter: ReviewFilterBody.nullable(),
  forwardEnabled: z.boolean(),
  reverseEnabled: z.boolean(),
  reverseAfterDays: z.number().nullable(),
  typeAnswer: typeAnswerSchema,
}).partial().strict()
const factStatusSchema = z.enum(tuple<FactStatus>(FACT_STATUSES))
const FactFields = { front: z.string().max(5000), back: z.string().max(50000), tags: z.array(z.string()).optional() }
const FactBody = z.object({ deckId: z.string().min(1), ...FactFields }).strict()
const FactPatchBody = z.object({ ...FactFields, status: factStatusSchema, deckId: z.string().min(1) }).partial().strict()
const ExerciseFields = {
  type: z.enum(['choose', 'spot', 'gap', 'fix', 'rewrite', 'write']),
  // The sentence (the task for write); `text` is the same field.
  prompt: z.string().max(1000).optional(),
  text: z.string().max(1000).optional(),
  // Every type but write needs one (core.cleanExercise says so).
  answer: z.string().max(500).optional(),
  options: z.array(z.string().max(200)).max(6).optional(),
  wrong: z.string().max(200).nullable().optional(),
  accepted: z.array(z.string().max(500)).max(20).optional(),
  explain: z.string().max(1000).nullable().optional(),
  // write: what a right answer must do, for the grader.
  rubric: z.string().max(1000).nullable().optional(),
}
const ExercisesBody = z.object({ items: z.array(z.object(ExerciseFields).strict()).min(1).max(100) }).strict()
const ExercisePatchBody = z.object({ ...ExerciseFields, status: z.enum(['active', 'flagged']), needsReview: z.boolean() }).partial().strict()
const ExtraNewBody = z.object({ n: z.number().int().min(1).max(100).optional() }).strict()
const GradeBody = z.object({ text: z.string().min(1).max(GRADE_TEXT_MAX) }).strict()
const AutofillBody = z.object({ deckId: z.string().optional(), term: z.string().min(1).max(200), hint: z.string().max(300).optional() })
const AnswersBody = z.object({ answers: z.array(z.object({ id: z.string(), known: z.boolean() })).max(1000) })
const time = z.string().refine(isTime, 'must be HH:MM (24 h)')
const MePatchBody = z.object({
  timeZone: z.string().refine(isTimeZone, 'unknown IANA time zone').optional(),
  reminderTime: time.optional(),
  // null turns the evening nudge off.
  eveningReminderTime: time.nullable().optional(),
  weeklyReport: z.boolean().optional(),
  // 0 = Sunday … 6 = Saturday.
  weeklyReportDay: z.number().int().min(0).max(6).optional(),
  weeklyReportTime: time.optional(),
  requestRetention: z.number().min(REQUEST_RETENTION.min).max(REQUEST_RETENTION.max).optional(),
  // The first-run wizard is done (or skipped); the gesture coach was seen.
  onboarded: z.boolean().optional(),
  coachSeen: z.boolean().optional(),
}).strict()
const TokenBody = z.object({ name: z.string().trim().min(1).max(100) })

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new HttpError(400, z.prettifyError(r.error))
  return r.data
}

const qint = (v: unknown, fallback: number) => {
  const n = Number(v)
  return v === undefined || v === '' || !Number.isFinite(n) ? fallback : Math.floor(n)
}
const qstr = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
// ?tag=a&tag=b: every one must hold.
const qtags = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '')

export function apiRouter(ctx: AppContext, limiter: LoginLimiter, nonceLimiter = new LoginLimiter(20, 15 * 60_000)): Router {
  const { db, cfg } = ctx
  const r = Router()
  const user = (req: Request): User => req.user!
  const uid = (req: Request) => req.user!.id
  const opts = (req: Request) => userDayOptions(cfg, req.user!)
  const lex = () => {
    const l = lexiconOf(ctx)
    syncFreqRanks(db, l)
    return l
  }
  // ?deck= / deckId: an id, a name or a language code; default the user's
  // English deck. Everything that takes it is about words: a topic deck is 400.
  const deckFor = (req: Request, ref: string | undefined) => {
    if (!ref) return defaultDeck(db, uid(req), ctx.now())
    const d = resolveDeck(db, uid(req), ref)
    if (!d) throw new HttpError(404, 'deck not found')
    return mustHaveLanguages(d)
  }
  // ?deck= for cards of any type: an id, a name or a language code; default
  // the English deck.
  const anyDeck = (req: Request, ref: string | undefined) => {
    if (!ref) return defaultDeck(db, uid(req), ctx.now())
    const d = resolveDeck(db, uid(req), ref)
    if (!d) throw new HttpError(404, 'deck not found')
    return d
  }
  const today = (req: Request) => studyDay(ctx.now(), opts(req)).key
  const item = (req: Request, id: string) => {
    const row = db.prepare('SELECT * FROM words WHERE id = ? AND user_id = ?').get(id, uid(req)) as WordRow | undefined
    if (!row) throw new HttpError(404, `word ${id} not found`)
    return withCards(db, uid(req), [row], ctx.now())[0]!
  }

  const login = (res: Response, userId: string) => {
    const { token, expires } = createSession(db, userId, ctx.now())
    res.setHeader('Set-Cookie', sessionCookie(cfg, token, expires))
  }

  const me = (req: Request) => {
    const u = user(req)
    return {
      user: { id: u.id, telegramId: u.telegramId, name: u.name, isOwner: isOwner(cfg, u) },
      authenticatedVia: req.via,
      timeZone: u.timeZone,
      dayStartHour: cfg.dayStartHour,
      today: studyDay(ctx.now(), opts(req)).key,
      reminderTime: u.reminderTime,
      eveningReminderTime: u.eveningReminderTime,
      weeklyReport: u.weeklyReport,
      weeklyReportDay: u.weeklyReportDay,
      weeklyReportTime: u.weeklyReportTime,
      botUsername: ctx.telegram.botUsername,
      fsrs: fsrsInfo(ctx, u),
      // Write items can be graded here (Claude is configured); else the app skips them.
      grading: gradingAvailable(ctx),
      // false: a new account, the app shows the first-run wizard (then the gesture coach once).
      onboarded: u.onboarded,
      coachSeen: u.coachSeen,
    }
  }

  r.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get()
    res.json({ ok: true })
  })

  // Owner-only fallback for when Telegram is unreachable.
  r.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (limiter.blocked(ip)) throw new HttpError(429, 'too many attempts, try again later')
    if (!checkPassword(cfg, req.body?.password)) {
      limiter.fail(ip)
      throw new HttpError(401, 'wrong password')
    }
    limiter.clear(ip)
    const owner = ownerUser(db, cfg, ctx.now())
    if (!owner) throw new HttpError(503, 'OWNER_TELEGRAM_ID is not configured')
    login(res, owner.id)
    res.json({ ok: true })
  })

  // Log in through the bot: open `url` in Telegram, then poll.
  r.post('/login/telegram', (req, res) => {
    const bot = ctx.telegram.botUsername
    if (!bot) throw new HttpError(503, 'Telegram login is unavailable')
    const ip = req.ip ?? 'unknown'
    if (nonceLimiter.blocked(ip)) throw new HttpError(429, 'too many login attempts, try again later')
    nonceLimiter.fail(ip)
    const n = createLoginNonce(db, ctx.now())
    if (!n) throw new HttpError(429, 'too many pending logins, try again later')
    res.json({ nonce: n.nonce, url: `https://t.me/${bot}?start=${START_PREFIX}${n.nonce}`, expiresAt: n.expiresAt })
  })

  // 202 pending · 200 + session cookie, once · 410 expired, used or unknown.
  r.get('/login/telegram/:nonce', (req, res) => {
    const p = pollLoginNonce(db, req.params.nonce as string, ctx.now())
    if (p.status === 'pending') {
      res.status(202).json({ status: 'pending', expiresAt: p.expiresAt })
      return
    }
    const u = p.status === 'confirmed' ? allowedUser(db, cfg, p.userId) : null
    if (!u) {
      res.status(410).json({ status: 'expired', error: 'login link expired' })
      return
    }
    login(res, u.id)
    res.json({ status: 'ok', user: { id: u.id, telegramId: u.telegramId, name: u.name, isOwner: isOwner(cfg, u) } })
  })

  r.post('/logout', (req, res) => {
    deleteSession(db, readCookie(req.headers.cookie, SESSION_COOKIE))
    res.setHeader('Set-Cookie', clearedCookie())
    res.json({ ok: true })
  })

  r.use(requireUser(ctx))

  r.get('/me', (req, res) => {
    res.json(me(req))
  })

  r.patch('/me', (req, res) => {
    req.user = updateUserSettings(db, uid(req), parse(MePatchBody, req.body ?? {}))
    res.json(me(req))
  })

  // Trains the user's FSRS weights on their history now (at most once a day).
  r.post('/fsrs/optimize', async (req, res) => {
    const result = await optimizeNow(ctx, uid(req))
    req.user = allowedUser(db, cfg, uid(req)) ?? req.user
    const { status } = result
    res.json({
      adopted: status === 'adopted',
      ...(result.status === 'rejected' ? { reason: result.reason } : {}),
      reviews: 'reviews' in result ? result.reviews : null,
      metrics: 'metrics' in result ? result.metrics ?? null : null,
      baseline: 'baseline' in result ? result.baseline ?? null : null,
      fsrs: fsrsInfo(ctx, user(req)),
    })
  })

  // Personal API tokens. Managed only from a signed-in app, never with a
  // bearer: a leaked token must not be able to mint more.
  const tokenAdmin = (req: Request) => {
    if (req.via === 'bearer') throw new HttpError(403, 'manage tokens from the app, not with a bearer token')
  }

  r.get('/tokens', (req, res) => {
    tokenAdmin(req)
    res.json({ tokens: listApiTokens(db, uid(req)) })
  })

  r.post('/tokens', (req, res) => {
    tokenAdmin(req)
    const { name } = parse(TokenBody, req.body ?? {})
    res.status(201).json(createApiToken(db, uid(req), name, ctx.now()))
  })

  r.delete('/tokens/:id', (req, res) => {
    tokenAdmin(req)
    deleteApiToken(db, uid(req), req.params.id as string)
    res.json({ ok: true })
  })

  // ---------- review ----------

  r.get('/queue', (req, res) => {
    const deck = qstr(req.query.deck)
    const deckId = deck ? resolveDeck(db, uid(req), deck)?.id ?? '-' : undefined
    const q = buildQueue(db, uid(req), opts(req), ctx.now(), { limit: qint(req.query.limit, 200), deckId, grading: gradingAvailable(ctx) })
    res.json(q)
  })

  // Extra rounds outside the schedule: nothing is written. ?fact= one rule's
  // items with fresh exercise sets ("Practice this"); else a deck's weak cards.
  r.get('/practice', (req, res) => {
    const grading = gradingAvailable(ctx)
    const fact = qstr(req.query.fact)
    if (fact) {
      res.json({ items: practiceRule(db, uid(req), fact, { grading }) })
      return
    }
    const deck = anyDeck(req, qstr(req.query.deck))
    res.json({ items: practiceDeck(db, uid(req), deck.id, opts(req), ctx.now(), { limit: qint(req.query.limit, PRACTICE_LIMIT.default), grading }) })
  })

  r.post('/reviews', (req, res) => {
    res.json(applyReviews(db, uid(req), parse(ReviewsBody, req.body)))
  })

  r.post('/reviews/undo', (req, res) => {
    const { id } = parse(z.object({ id: z.string() }), req.body)
    res.json({ card: undoReview(db, uid(req), id) })
  })

  // ---------- decks ----------

  r.get('/decks', (req, res) => {
    defaultDeck(db, uid(req), ctx.now())
    res.json({ decks: decksWithCounts(db, uid(req), opts(req), ctx.now()) })
  })

  r.post('/decks', (req, res) => {
    const deck = createDeck(db, uid(req), parse(DeckBody, req.body), ctx.now())
    res.status(201).json({ deck })
  })

  r.patch('/decks/:id', (req, res) => {
    res.json({ deck: updateDeck(db, uid(req), req.params.id as string, parse(DeckPatchBody, req.body), today(req)) })
  })

  // "+5 today": more new cards from this deck for the rest of the study day.
  r.post('/decks/:id/extra-new', (req, res) => {
    const { n } = parse(ExtraNewBody, req.body ?? {})
    addExtraNew(db, uid(req), req.params.id as string, today(req), n ?? 5)
    res.json({ deck: getDeck(db, uid(req), req.params.id as string, today(req))! })
  })

  // Moves every card into another deck (tagged with this deck's name unless
  // tag: false) and deletes this one once empty.
  r.post('/decks/:id/merge', (req, res) => {
    const { into, tag } = parse(z.object({ into: z.string().min(1), tag: z.boolean().optional() }).strict(), req.body)
    const target = resolveDeck(db, uid(req), into)
    if (!target) throw new HttpError(404, 'deck not found')
    res.json(mergeDecks(db, uid(req), req.params.id as string, target.id, { tag: tag ?? true }, ctx.now()))
  })

  // Bulk tag edits on every word and fact of the deck (and its review
  // filter); onlyWith: only cards that carry that tag or one under it.
  const TagName = z.string().min(1).max(200)
  r.post('/decks/:id/tags/rename', (req, res) => {
    const { from, to, onlyWith } = parse(z.object({ from: TagName, to: TagName, onlyWith: TagName.optional() }).strict(), req.body)
    res.json(retagDeck(db, uid(req), req.params.id as string, { kind: 'rename', from, to }, { onlyWith }, ctx.now()))
  })
  r.post('/decks/:id/tags/delete', (req, res) => {
    const { tag, onlyWith } = parse(z.object({ tag: TagName, onlyWith: TagName.optional() }).strict(), req.body)
    res.json(retagDeck(db, uid(req), req.params.id as string, { kind: 'delete', tag }, { onlyWith }, ctx.now()))
  })
  r.post('/decks/:id/tags/add', (req, res) => {
    const { tag, onlyWith } = parse(z.object({ tag: TagName, onlyWith: TagName.optional() }).strict(), req.body)
    res.json(retagDeck(db, uid(req), req.params.id as string, { kind: 'add', tag }, { onlyWith }, ctx.now()))
  })

  // The review filter sheet: the deck's options and today's count under ?filter= (json, not saved).
  r.get('/decks/:id/review-options', (req, res) => {
    let draft: unknown = null
    const raw = qstr(req.query.filter)
    if (raw) {
      try {
        draft = JSON.parse(raw)
      } catch {
        throw new HttpError(400, 'filter must be JSON')
      }
    }
    const filter = draft === null ? null : parse(ReviewFilterBody, draft)
    res.json(reviewOptions(db, uid(req), opts(req), ctx.now(), req.params.id as string, filter))
  })

  // A deck; one with cards only with ?cards=delete (they go too, with their
  // history), else 409 {error, words, facts}.
  r.delete('/decks/:id', (req, res) => {
    const withCards = req.query.cards === 'delete' || req.query.facts === 'delete'
    const gone = deleteDeck(db, uid(req), req.params.id as string, { withCards })
    res.json({ ok: true, ...gone })
  })

  // ---------- packs ----------

  r.get('/packs', (req, res) => {
    res.json({ packs: listPacks(db, uid(req)) })
  })

  // Adds the pack's missing cards (all of them the first time).
  r.post('/packs/:id', (req, res) => {
    const { deckId } = parse(z.object({ deckId: z.string().optional() }).strict(), req.body ?? {})
    const out = addPack(db, uid(req), req.params.id as string, ctx.now(), { deckId, lex: lex() })
    res.json({ ...out, deck: getDeck(db, uid(req), out.deck.id, today(req))!, packs: listPacks(db, uid(req), ctx.now()) })
  })

  // The grammar handbook topics in a deck and the user's own rules.
  r.get('/handbook', (req, res) => {
    res.json(handbook(db, uid(req), anyDeck(req, qstr(req.query.deck)).id))
  })

  // ---------- facts ----------

  r.get('/facts', (req, res) => {
    const q = req.query
    const status = qstr(q.status)
    res.json(searchFacts(db, uid(req), {
      deck: qstr(q.deck),
      q: qstr(q.q),
      tag: qtags(q.tag),
      status: status ? parse(factStatusSchema, status) : undefined,
      limit: qint(q.limit, 50),
      offset: qint(q.offset, 0),
    }, ctx.now()))
  })

  r.get('/facts/:id', (req, res) => {
    const fact = factItem(db, uid(req), req.params.id as string, ctx.now())
    res.json({ fact, logs: factLogs(db, uid(req), fact.id, 20) })
  })

  // Written in the app: active at once. A duplicate question is 409 {error, existing}.
  r.post('/facts', (req, res) => {
    const { deckId, ...fact } = parse(FactBody, req.body)
    const deck = resolveDeck(db, uid(req), deckId)
    if (!deck) throw new HttpError(404, 'deck not found')
    const { fact: f } = createFact(db, uid(req), { deckId: deck.id, fact, status: 'active', createdBy: 'user' }, ctx.now())
    res.status(201).json({ fact: factItem(db, uid(req), f.id, ctx.now()) })
  })

  r.patch('/facts/:id', (req, res) => {
    const f = updateFact(db, uid(req), req.params.id as string, parse(FactPatchBody, req.body), ctx.now())
    res.json({ fact: factItem(db, uid(req), f.id, ctx.now()) })
  })

  r.delete('/facts/:id', (req, res) => {
    deleteFact(db, uid(req), req.params.id as string)
    res.json({ ok: true })
  })

  // ---------- exercises ----------

  r.get('/facts/:id/exercises', (req, res) => {
    res.json({ exercises: listExercises(db, uid(req), req.params.id as string) })
  })

  r.post('/facts/:id/exercises', (req, res) => {
    const { items } = parse(ExercisesBody, req.body)
    const out = addExercises(db, uid(req), req.params.id as string, items, 'user', ctx.now())
    res.status(out.created.length ? 201 : 200).json({ ...out, exercises: listExercises(db, uid(req), req.params.id as string) })
  })

  r.patch('/exercises/:id', (req, res) => {
    res.json({ exercise: updateExercise(db, uid(req), req.params.id as string, parse(ExercisePatchBody, req.body)) })
  })

  // Claude's verdict on a sentence written for a write item; nothing is stored.
  r.post('/exercises/:id/grade', async (req, res) => {
    const { text } = parse(GradeBody, req.body)
    res.json(await gradeWrite(ctx, user(req), req.params.id as string, text))
  })

  r.delete('/exercises/:id', (req, res) => {
    deleteExercise(db, uid(req), req.params.id as string)
    res.json({ ok: true })
  })

  // Drop: never shown again, kept so the same question is recognised as a duplicate.
  for (const [action, status] of [['drop', 'rejected'], ['restore', 'active']] as const) {
    r.post(`/facts/:id/${action}`, (req, res) => {
      const f = updateFact(db, uid(req), req.params.id as string, { status }, ctx.now())
      res.json({ fact: factItem(db, uid(req), f.id, ctx.now()) })
    })
  }
  for (const [action, flag] of [['suspend', true], ['unsuspend', false]] as const) {
    r.post(`/facts/:id/${action}`, (req, res) => {
      setFactSuspended(db, uid(req), req.params.id as string, flag)
      res.json({ fact: factItem(db, uid(req), req.params.id as string, ctx.now()) })
    })
  }

  // ---------- words ----------

  r.get('/words', (req, res) => {
    lex()
    const q = req.query
    const status = qstr(q.status)
    const pos = qstr(q.pos)
    const cefr = qstr(q.cefr)
    const sort = qstr(q.sort)
    res.json(searchWords(db, uid(req), {
      deck: qstr(q.deck),
      q: qstr(q.q),
      status: status ? parse(statusSchema, status) : undefined,
      pos: pos ? parse(posSchema, pos) : undefined,
      cefr: cefr ? parse(cefrSchema, cefr) : undefined,
      tag: qtags(q.tag),
      sort: sort ? parse(sortSchema, sort) : undefined,
      limit: qint(q.limit, 50),
      offset: qint(q.offset, 0),
    }, ctx.now()))
  })

  r.post('/words/autofill', async (req, res) => {
    const b = parse(AutofillBody, req.body)
    res.json(await autofill(ctx, user(req), deckFor(req, b.deckId), b))
  })

  r.get('/words/:id', (req, res) => {
    const word = item(req, req.params.id as string)
    res.json({ word, logs: wordLogs(db, uid(req), word.id, 20) })
  })

  // Manual add: active at once. A duplicate is 409 {error, existing} so the
  // app can offer to add the translation to the existing word instead.
  r.post('/words', (req, res) => {
    const { deckId, ...word } = parse(WordBody, req.body)
    const deck = deckFor(req, deckId)
    const w = createWord(db, uid(req), { deckId: deck.id, word, status: 'active', createdBy: 'user' }, ctx.now(), lex())
    res.status(201).json({ word: item(req, w.id) })
  })

  r.patch('/words/:id', (req, res) => {
    const w = updateWord(db, uid(req), req.params.id as string, parse(WordPatchBody, req.body), ctx.now(), lex())
    res.json({ word: item(req, w.id) })
  })

  r.delete('/words/:id', (req, res) => {
    deleteWord(db, uid(req), req.params.id as string)
    res.json({ ok: true })
  })

  for (const [action, status] of [['drop', 'rejected'], ['restore', 'active']] as const) {
    r.post(`/words/:id/${action}`, (req, res) => {
      const w = setWordStatus(db, uid(req), req.params.id as string, status, ctx.now())
      res.json({ word: item(req, w.id) })
    })
  }

  for (const [action, flag] of [['suspend', true], ['unsuspend', false]] as const) {
    r.post(`/words/:id/${action}`, (req, res) => {
      setWordSuspended(db, uid(req), req.params.id as string, flag)
      res.json({ word: item(req, req.params.id as string) })
    })
    r.post(`/cards/:id/${action}`, (req, res) => {
      const card = setSuspended(db, uid(req), req.params.id as string, flag)
      const owner = card.wordId ? mustGetWord(db, uid(req), card.wordId) : getFact(db, uid(req), card.factId!)!
      const deck = getDeck(db, uid(req), owner.deckId)!
      res.json({ card: { ...card, summary: cardSummary(card, deck, ctx.now()) } })
    })
  }

  // ---------- progress ----------

  r.get('/stats', (req, res) => {
    const deck = qstr(req.query.deck)
    const deckId = deck ? resolveDeck(db, uid(req), deck)?.id ?? '-' : undefined
    res.json(stats(db, uid(req), opts(req), ctx.now(), { days: qint(req.query.days, 30), deckId }))
  })

  r.get('/dashboard', (req, res) => {
    const l = lex()
    res.json(dashboard(db, uid(req), deckFor(req, qstr(req.query.deck)), l, opts(req), ctx.now()))
  })

  r.post('/vocab-test', (req, res) => {
    const { deckId } = parse(z.object({ deckId: z.string().optional() }), req.body ?? {})
    const deck = deckFor(req, deckId)
    res.status(201).json(createVocabTest(db, uid(req), lex(), ctx.now(), { deckId: deck.id }))
  })

  r.post('/vocab-test/:id/answers', (req, res) => {
    const { answers } = parse(AnswersBody, req.body)
    res.json(answerVocabTest(db, uid(req), lex(), req.params.id as string, answers, ctx.now()))
  })

  r.get('/vocab-tests', (req, res) => {
    res.json({ tests: listVocabTests(db, uid(req)) })
  })

  r.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  return r
}
