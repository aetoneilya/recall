import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { PartOfSpeech, QueueItem, Rating, Word, WordInput, WordStatus } from '@recall/core'
import { createApp } from '../src/app.ts'
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AutofillClient } from '../src/autofill.ts'
import { loadConfig, type Config } from '../src/config.ts'
import type { AppContext } from '../src/context.ts'
import { openDb } from '../src/db.ts'
import { makeLexicon, parseFrequencies, parseScale, parseVocabTest, type Lexicon } from '../src/lexicon.ts'
import { createDeck, createWord, defaultDeck, wordCards } from '../src/repo.ts'
import { applyReviews } from '../src/study.ts'
import { ensureUser, migrationEnv, type User } from '../src/users.ts'

export const TZ = { timeZone: 'Europe/Moscow', startHour: 4 }
export const TEST_TELEGRAM_ID = 1001

export type TestCtx = AppContext & { clock: { t: Date }; user: User; lexicon: Lexicon }

// A small frequency list and vocabulary test: ranks 1..8000 as "w<rank>",
// plus a few real words at known ranks.
export const FREQ = ['lemma\trank', 'the\t1', 'be\t2', 'frown\t2500', 'bone\t1800', 'break\t300', 'cry\t900', 'house\t150', 'auction\t6500', 'stop\t400', 'make\t50']
  .concat(Array.from({ length: 8000 }, (_, i) => `w${i + 1}\t${i + 1}`))
  .join('\n')
export const TEST_DATA = JSON.stringify({
  bandSize: 1000,
  bands: Array.from({ length: 8 }, (_, b) => ({ from: b * 1000 + 1, to: (b + 1) * 1000, words: Array.from({ length: 10 }, (_, i) => `w${b * 1000 + 1 + i * 37}`) })),
  pseudowords: Array.from({ length: 20 }, (_, i) => `blorf${i}`),
  scoring: { formula: 'known_b = max(0, (h_b - f) / (1 - f)); smooth to non-increasing; size = bandSize * sum' },
})
export const SCALE = JSON.stringify({
  unit: 'lemmas',
  points: [
    { id: 'A1', label_en: 'CEFR A1 learner', value: 1000, group: 'learner' },
    { id: 'B1', label_en: 'CEFR B1 learner', value: 3000, group: 'learner' },
    { id: 'child5', label_en: '5-year-old child', value: 6000, group: 'native', approximate: true },
    { id: 'adult20', label_en: 'Average 20-year-old native adult', value: 42000, group: 'native' },
  ],
  calibration: { expectedKnownInList_averageRespondent: 26686 },
})

export function testLexicon(): Lexicon {
  const f = parseFrequencies(FREQ)
  const t = parseVocabTest(TEST_DATA)
  const s = parseScale(SCALE)
  return makeLexicon(() => f, () => t, () => s)
}

// A fresh in-memory app with one user (`ctx.user`) that unit tests act as.
export function makeCtx(env: Record<string, string> = {}, at = '2026-10-21T09:00:00Z', autofill: AutofillClient | null = null): TestCtx {
  const cfg: Config = loadConfig({ TZ_NAME: 'Europe/Moscow', DAY_START_HOUR: '4', APP_ORIGIN: 'http://localhost:9', ...env }, [])
  const clock = { t: new Date(at) }
  const db = openDb(':memory:', migrationEnv(cfg))
  const user = ensureUser(db, cfg, TEST_TELEGRAM_ID, clock.t, 'Tester')
  return { db, cfg, now: () => clock.t, clock, telegram: { botUsername: null }, user, lexicon: testLexicon(), autofill }
}

export interface AddWord extends Partial<WordInput> {
  status?: WordStatus
  at?: Date
  userId?: string
  deckId?: string
}

// A word with the given term (default noun, translation "<term> ru").
export function addWord(ctx: TestCtx, term: string, opts: AddWord = {}) {
  const { status, at, userId, deckId, ...rest } = opts
  const uid = userId ?? ctx.user.id
  return createWord(ctx.db, uid, {
    deckId: deckId ?? defaultDeck(ctx.db, uid, ctx.now()).id,
    word: { term, pos: 'noun' as PartOfSpeech, translations: [`${term} ru`], ...rest },
    status: status ?? 'active',
    createdBy: 'user',
  }, at ?? ctx.now(), ctx.lexicon)
}

// The user's English deck, with a daily new-card limit.
export function deck(ctx: TestCtx, newPerDay = 15, userId = ctx.user.id) {
  const d = defaultDeck(ctx.db, userId, ctx.now())
  ctx.db.prepare('UPDATE decks SET new_per_day = ? WHERE id = ?').run(newPerDay, d.id)
  return { ...d, newPerDay }
}

// A second language deck.
export function otherDeck(ctx: TestCtx, targetLang = 'de', newPerDay = 15, userId = ctx.user.id) {
  return createDeck(ctx.db, userId, { targetLang, nativeLang: 'ru', newPerDay }, ctx.now())
}

// A queue item that must be a word's card.
export function wordOf(it: QueueItem): Word {
  if (it.kind !== 'word') throw new Error(`card ${it.card.id} is a fact's`)
  return it.word
}

let seq = 0
export function rate(ctx: TestCtx, cardId: string, rating: Rating, at: Date) {
  return applyReviews(ctx.db, ctx.user.id, [{ id: `r${++seq}`, cardId, rating, reviewedAt: at.toISOString() }])
}

// [forward, reverse]
export function cardsOf(ctx: TestCtx, wordId: string, userId = ctx.user.id) {
  return wordCards(ctx.db, userId, wordId)
}

export async function listen(ctx: AppContext): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createApp(ctx).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) }
}

// Telegram Mini App initData signed with `token`, as Telegram would.
export function initData(user: object, authDate: number, token: string): string {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE', user: JSON.stringify(user) })
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const key = createHmac('sha256', 'WebAppData').update(token).digest()
  params.set('hash', createHmac('sha256', key).update(check).digest('hex'))
  return params.toString()
}

export const bearer = (t: string) => ['Bearer', t].join(' ')

export const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

// Calls one MCP tool; returns the parsed JSON result, or { error } for tool errors.
export async function callTool(url: string, token: string, name: string, args: object = {}): Promise<any> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: bearer(token) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  if (res.status !== 200) return { status: res.status }
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  const text = body.result.content[0]!.text
  return body.result.isError ? { error: text } : JSON.parse(text)
}

// fetch with a JSON body.
export function send(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

// A Claude answer with `body` as its JSON text.
export function claudeMessage(body: unknown, over: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body), citations: null }],
    usage: { input_tokens: 100, output_tokens: 50 },
    ...over,
  } as unknown as BetaMessage
}

// A fake client that records requests and answers with `reply` (or throws).
export function fakeClaude(reply: (body: MessageCreateParamsNonStreaming) => BetaMessage | Promise<BetaMessage>) {
  const calls: MessageCreateParamsNonStreaming[] = []
  const client: AutofillClient = { beta: { messages: { create: async (body) => (calls.push(body), reply(body)) } } }
  return { client, calls }
}
