import {
  CEFR_LEVELS, PARTS_OF_SPEECH, WORD_STATUSES, type Cefr, type PartOfSpeech, type WordStatus,
} from '@recall/core'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { checkPassword, clearedCookie, createSession, deleteSession, LoginLimiter, readCookie, requireUser, SESSION_COOKIE, sessionCookie } from './auth.ts'
import { autofill } from './autofill.ts'
import { isTime, isTimeZone } from './config.ts'
import type { AppContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import { fsrsInfo, optimizeNow, REQUEST_RETENTION } from './fsrs.ts'
import { lexiconOf } from './lexicon.ts'
import { createLoginNonce, pollLoginNonce, START_PREFIX } from './login.ts'
import {
  approveAll, cardSummary, createDeck, createWord, defaultDeck, deleteWord, getDeck, HttpError, inboxWords, mustGetWord, resolveDeck,
  searchWords, setSuspended, setWordStatus, setWordSuspended, syncFreqRanks, TYPE_ANSWERS, updateDeck, updateWord, withCards, WORD_SORTS,
  type TypeAnswer, type WordRow, type WordSort,
} from './repo.ts'
import { applyReviews, buildQueue, decksWithCounts, inboxCount, stats, studyDay, undoReview, wordLogs } from './study.ts'
import { createApiToken, deleteApiToken, listApiTokens } from './tokens.ts'
import { allowedUser, isOwner, ownerUser, updateUserSettings, userDayOptions, type User } from './users.ts'
import { answerVocabTest, createVocabTest, listVocabTests } from './vocab.ts'

const tuple = <T extends string>(xs: readonly T[]) => xs as unknown as [T, ...T[]]
export const posSchema = z.enum(tuple<PartOfSpeech>(PARTS_OF_SPEECH))
export const cefrSchema = z.enum(tuple<Cefr>(CEFR_LEVELS))
const statusSchema = z.enum(tuple<WordStatus>(WORD_STATUSES))
const sortSchema = z.enum(tuple<WordSort>(WORD_SORTS))

const ReviewsBody = z.array(z.object({
  id: z.string().min(1).max(100),
  cardId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reviewedAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().min(0).optional(),
})).max(5000)

const ExampleBody = z.object({ text: z.string(), translation: z.string().nullable().optional() })
const WordFields = {
  term: z.string(),
  pos: posSchema,
  translations: z.array(z.string()),
  ipa: z.string().nullable().optional(),
  examples: z.array(ExampleBody).optional(),
  note: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  cefr: cefrSchema.nullable().optional(),
}
const WordBody = z.object({ deckId: z.string().optional(), ...WordFields })
const WordPatchBody = z.object({ ...WordFields, status: statusSchema }).partial()
const typeAnswerSchema = z.enum(tuple<TypeAnswer>(TYPE_ANSWERS))
const DeckBody = z.object({ name: z.string().optional(), targetLang: z.string(), nativeLang: z.string(), newPerDay: z.number().int().optional(), typeAnswer: typeAnswerSchema.optional() })
const DeckPatchBody = z.object({
  name: z.string(),
  newPerDay: z.number().int(),
  forwardEnabled: z.boolean(),
  reverseEnabled: z.boolean(),
  reverseAfterDays: z.number().nullable(),
  typeAnswer: typeAnswerSchema,
}).partial().strict()
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
  // ?deck= / deckId: an id, a name or a language code; default the user's English deck.
  const deckFor = (req: Request, ref: string | undefined) => {
    if (!ref) return defaultDeck(db, uid(req), ctx.now())
    const d = resolveDeck(db, uid(req), ref)
    if (!d) throw new HttpError(404, 'deck not found')
    return d
  }
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
    const q = buildQueue(db, uid(req), opts(req), ctx.now(), { limit: qint(req.query.limit, 200), deckId })
    res.json({ ...q, inbox: inboxCount(db, uid(req)) })
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
    res.status(201).json({ deck: createDeck(db, uid(req), parse(DeckBody, req.body), ctx.now()) })
  })

  r.patch('/decks/:id', (req, res) => {
    res.json({ deck: updateDeck(db, uid(req), req.params.id as string, parse(DeckPatchBody, req.body)) })
  })

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
      tag: qstr(q.tag),
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

  for (const [action, status] of [['approve', 'active'], ['reject', 'rejected']] as const) {
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
      const deck = getDeck(db, uid(req), mustGetWord(db, uid(req), card.wordId).deckId)!
      res.json({ card: { ...card, summary: cardSummary(card, deck, ctx.now()) } })
    })
  }

  r.get('/inbox', (req, res) => {
    const deck = qstr(req.query.deck)
    res.json({ words: inboxWords(db, uid(req), ctx.now(), deck ? deckFor(req, deck).id : undefined) })
  })

  r.post('/inbox/approve-all', (req, res) => {
    const { deckId } = parse(z.object({ deckId: z.string().optional() }), req.body ?? {})
    const id = deckId ? resolveDeck(db, uid(req), deckId)?.id ?? '-' : undefined
    res.json({ approved: approveAll(db, uid(req), id, ctx.now()) })
  })

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
