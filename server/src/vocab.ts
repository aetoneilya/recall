// Vocabulary size: a periodic Yes/No test with pseudowords, adjusted
// continuously by the words the user demonstrably knows in the app.
//
// Test (server/data/vocab-test.json, README §2): ~3 real words per 1000-rank
// band + pseudowords (~25% of items). h_b = share of band b's words ticked,
// f = share of pseudowords ticked. known_b = max(0, (h_b − f)/(1 − f))
// (or I_SDT / raw, as the file's `scoring` says), smoothed to be
// non-increasing over bands (pool-adjacent-violators, weighted by items),
// size = bandSize × Σ known_b — lemmas within the frequency list.
//
// Adjusted (README §4): per band max(known_b, srs_b) × bandSize, where
// srs_b = distinct lemmas of the band whose word is known in the app (a card
// in review state with R ≥ 0.9 now; single-word terms only) / bandSize. The
// SRS count is a hard lower bound, so learning words raises the estimate
// between tests and a lucky test is never overruled.
//
// Placing it on vocab-scale.json: learner (CEFR) points compare against the
// in-list estimate; native and fun points against
// nativeEquivalent = adultSize × estimate / expectedInList (≈, README §3).
import { normalizeTerm } from '@recall/core'
import { newId, type Db } from './db.ts'
import { scalePosition, termTokens, type Lexicon, type ScalePoint, type TestBand, type VocabScale, type VocabTestData } from './lexicon.ts'
import { HttpError } from './repo.ts'
import { isKnown, reviewCards } from './study.ts'

export interface TestItem {
  id: string
  word: string
  kind: 'real' | 'pseudo'
  // Index into the test data's bands for real words.
  band: number | null
}

export interface BandResult {
  from: number
  to: number
  items: number
  yes: number
  hitRate: number | null
  // Test share known after correction and smoothing, 0..1.
  known: number
  // Share of the band's lemmas known in the app, 0..1.
  srs: number
}

export interface Placement {
  // The point at or below the number and the next one above it, within the group.
  level: ScalePoint | null
  next: ScalePoint | null
}

export interface VocabEstimate {
  // Lemmas within the frequency list; `estimate` from the test alone (null without a test).
  estimate: number | null
  interval: [number, number] | null
  // Test and app combined (= app-only lower bound without a test).
  adjusted: number
  // From the app alone: the hard lower bound.
  srsKnown: number
  basis: 'test+app' | 'app'
  // Compare with native speakers: adultSize × adjusted / expectedInList. Always approximate.
  nativeEquivalent: { value: number; approximate: true }
  // CEFR learner level from the adjusted in-list number (learner points cap at ~5000).
  cefr: Placement
  // Per scale group: learner with the in-list number, native / fun with the native equivalent.
  scale: Record<string, Placement>
  perBand: BandResult[]
}

export interface TestResult extends VocabEstimate {
  testId: string
  falseAlarmRate: number
  pseudowords: { items: number; yes: number }
  answered: number
  method: string
  // low: many false alarms (f > 0.2) or overall hits no better than false alarms; valid=false: f above the file's limit (0.5) — retake.
  reliability: 'ok' | 'low'
  valid: boolean
}

function testData(lex: Lexicon): VocabTestData {
  const d = lex.vocabTest()
  if (!d) throw new HttpError(503, 'vocabulary test data is not installed')
  return d
}

// Bands to estimate over: the test's, or 1000-rank bands of the frequency list.
function bandsOf(lex: Lexicon): { bands: Pick<TestBand, 'from' | 'to'>[]; bandSize: number } {
  const d = lex.vocabTest()
  if (d) return { bands: d.bands, bandSize: d.bandSize }
  const n = lex.freqSize()
  const bands: Pick<TestBand, 'from' | 'to'>[] = []
  for (let from = 1; from <= n; from += 1000) bands.push({ from, to: Math.min(from + 999, n) })
  return { bands, bandSize: 1000 }
}

// Normalised terms and lemmas of every word the user has (any status).
function userLemmas(db: Db, userId: string, lex: Lexicon): Set<string> {
  const out = new Set<string>()
  for (const { term } of db.prepare('SELECT term FROM words WHERE user_id = ?').all(userId) as { term: string }[]) {
    out.add(normalizeTerm(term))
    const l = lex.lemma(term)
    if (l) out.add(l)
  }
  return out
}

// Per band: lemmas known in the app (distinct freq ranks of known single-word terms).
export function srsBandCounts(db: Db, userId: string, bands: Pick<TestBand, 'from' | 'to'>[], now: Date, deckId?: string): number[] {
  const ranks = new Set<number>()
  for (const c of reviewCards(db, userId, deckId)) {
    if (c.freq_rank === null || termTokens(c.term).length !== 1 || !isKnown(c, now)) continue
    ranks.add(c.freq_rank)
  }
  return bands.map((b) => [...ranks].filter((r) => r >= b.from && r <= b.to).length)
}

type Rng = () => number

function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

export function createVocabTest(db: Db, userId: string, lex: Lexicon, now: Date, opts: { deckId?: string; rng?: Rng } = {}): { testId: string; items: { id: string; word: string }[] } {
  const data = testData(lex)
  const rng = opts.rng ?? Math.random
  const have = userLemmas(db, userId, lex)
  const known = (w: string) => have.has(w.toLowerCase()) || have.has(lex.lemma(w) ?? '\u0000')
  const real: Omit<TestItem, 'id'>[] = []
  data.bands.forEach((b, band) => {
    // Words already in the app are known (or not) from the SRS, not from a tick.
    for (const word of shuffle(b.words.filter((w) => !known(w)), rng).slice(0, data.itemsPerBand)) real.push({ word, kind: 'real', band })
  })
  const nPseudo = Math.round((real.length * data.pseudowordShare) / (1 - data.pseudowordShare))
  const pseudo = shuffle(data.pseudowords, rng).slice(0, nPseudo).map((word) => ({ word, kind: 'pseudo' as const, band: null }))
  const items: TestItem[] = shuffle([...real, ...pseudo], rng).map((it, i) => ({ ...it, id: `q${i + 1}` }))
  const id = newId('vt')
  db.prepare('INSERT INTO vocab_tests(id, user_id, deck_id, items, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, opts.deckId ?? null, JSON.stringify(items), now.toISOString())
  return { testId: id, items: items.map(({ id, word }) => ({ id, word })) }
}

// Huibregtse, Admiraal & Meara (2002), as in Lemhöfer & Broersma (2012).
export function isdt(h: number, f: number): number {
  if (h <= f || h === 0) return 0
  const a = 4 * h * (1 - f)
  const b = (h - f) * (1 + h - f)
  const den = a - b
  return den <= 0 ? 0 : Math.max(0, Math.min(1, 1 - (a - 2 * b) / den))
}

export function correctShare(method: string, h: number, f: number): number {
  if (method === 'raw') return h
  if (method === 'isdt') return isdt(h, f)
  return f >= 1 ? 0 : Math.max(0, Math.min(1, (h - f) / (1 - f)))
}

// Pool-adjacent-violators for a non-increasing sequence, weighted.
export function nonIncreasing(values: number[], weights: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = []
  values.forEach((v, i) => {
    blocks.push({ v, w: weights[i]!, n: 1 })
    while (blocks.length > 1 && blocks.at(-2)!.v < blocks.at(-1)!.v) {
      const b = blocks.pop()!
      const a = blocks.pop()!
      const w = a.w + b.w
      blocks.push({ v: w ? (a.v * a.w + b.v * b.w) / w : (a.v + b.v) / 2, w, n: a.n + b.n })
    }
  })
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.v))
}

function place(scale: VocabScale | null, inList: number): Pick<VocabEstimate, 'nativeEquivalent' | 'cefr' | 'scale'> {
  const cal = scale?.calibration ?? { adultSize: 42000, expectedInList: 26686, listSize: null }
  const native = Math.round((cal.adultSize * inList) / cal.expectedInList)
  const groups: Record<string, Placement> = {}
  for (const g of new Set((scale?.points ?? []).map((p) => p.group))) {
    const pts = scale!.points.filter((p) => p.group === g)
    groups[g] = scalePosition(pts, g === 'learner' ? inList : native)
  }
  return {
    nativeEquivalent: { value: native, approximate: true },
    cefr: groups.learner ?? { level: null, next: null },
    scale: groups,
  }
}

// Combines per-band test shares (null = no test) with the app's known lemmas.
export function estimate(lex: Lexicon, srs: number[], test: { known: number[]; items: number[]; yes: number[]; f: number; interval: [number, number] } | null): VocabEstimate {
  const { bands, bandSize } = bandsOf(lex)
  const perBand: BandResult[] = bands.map((b, i) => {
    const size = b.to - b.from + 1
    return {
      from: b.from,
      to: b.to,
      items: test?.items[i] ?? 0,
      yes: test?.yes[i] ?? 0,
      hitRate: test && test.items[i] ? test.yes[i]! / test.items[i]! : null,
      known: test?.known[i] ?? 0,
      srs: Math.min(1, (srs[i] ?? 0) / size),
    }
  })
  const srsKnown = srs.reduce((a, b) => a + b, 0)
  const adjusted = Math.round(perBand.reduce((s, b) => s + Math.max(b.known, b.srs) * (b.to - b.from + 1), 0))
  const est = test ? Math.round(perBand.reduce((s, b) => s + b.known * bandSize, 0)) : null
  return {
    estimate: est,
    interval: test?.interval ?? null,
    adjusted: Math.max(adjusted, srsKnown),
    srsKnown,
    basis: test ? 'test+app' : 'app',
    ...place(lex.scale(), Math.max(adjusted, srsKnown)),
    perBand,
  }
}

export function scoreItems(data: VocabTestData, items: TestItem[], answers: Map<string, boolean>) {
  const n = data.bands.map(() => 0)
  const yes = data.bands.map(() => 0)
  let pn = 0
  let py = 0
  for (const it of items) {
    const a = answers.get(it.id)
    if (a === undefined) continue
    if (it.kind === 'pseudo') {
      pn++
      if (a) py++
    } else if (it.band !== null && it.band < n.length) {
      n[it.band]!++
      if (a) yes[it.band]!++
    }
  }
  const f = pn ? py / pn : 0
  const raw = n.map((k, i) => (k ? correctShare(data.scoring.method, yes[i]! / k, f) : null))
  // Bands without items take their neighbours' mean, so smoothing sees a full curve.
  const filled = raw.map((v, i) => {
    if (v !== null) return v
    const prev = raw.slice(0, i).reverse().find((x) => x !== null)
    const next = raw.slice(i + 1).find((x) => x !== null)
    return prev != null && next != null ? (prev + next) / 2 : (prev ?? next ?? 0)
  })
  const known = data.scoring.smooth ? nonIncreasing(filled, n.map((k) => Math.max(k, 0.5))) : filled
  // Rough 95% interval from the binomial error of each band's hit rate.
  const variance = n.reduce((s, k, i) => {
    if (!k) return s
    const h = yes[i]! / k
    const se = Math.sqrt(Math.max(h * (1 - h), 0.25 / k) / k) / Math.max(1 - f, 0.05)
    return s + (se * data.bandSize) ** 2
  }, 0)
  const est = known.reduce((s, v) => s + v * data.bandSize, 0)
  const half = 1.96 * Math.sqrt(variance)
  const total = data.bands.reduce((s, b) => s + (b.to - b.from + 1), 0)
  const interval: [number, number] = [Math.max(0, Math.round(est - half)), Math.min(total, Math.round(est + half))]
  // Ticks no better than guessing: the overall hit rate does not beat the
  // false-alarm rate. (Per band this fires for anyone who doesn't know the
  // rare bands, so it is judged over all real items.)
  const realItems = n.reduce((a, b) => a + b, 0)
  const hits = yes.reduce((a, b) => a + b, 0)
  const noise = f > 0 && realItems > 0 && hits / realItems <= f
  return { n, yes, known, f, pn, py, interval, noise }
}

interface TestRow {
  id: string
  user_id: string
  deck_id: string | null
  items: string
  answers: string | null
  result: string | null
  created_at: string
  completed_at: string | null
}

export function answerVocabTest(db: Db, userId: string, lex: Lexicon, testId: string, answers: { id: string; known: boolean }[], now: Date): TestResult {
  const row = db.prepare('SELECT * FROM vocab_tests WHERE id = ? AND user_id = ?').get(testId, userId) as TestRow | undefined
  if (!row) throw new HttpError(404, `vocabulary test ${testId} not found`)
  if (row.completed_at) throw new HttpError(409, 'this test has already been answered')
  const data = testData(lex)
  const items = JSON.parse(row.items) as TestItem[]
  const ids = new Set(items.map((i) => i.id))
  const map = new Map<string, boolean>()
  for (const a of answers) if (ids.has(a.id)) map.set(a.id, a.known)
  if (map.size < Math.ceil(items.length / 2)) throw new HttpError(400, `answer at least half of the ${items.length} items`)
  const s = scoreItems(data, items, map)
  const srs = srsBandCounts(db, userId, data.bands, now, row.deck_id ?? undefined)
  const est = estimate(lex, srs, { known: s.known, items: s.n, yes: s.yes, f: s.f, interval: s.interval })
  const result: TestResult = {
    testId,
    ...est,
    falseAlarmRate: Math.round(s.f * 1000) / 1000,
    pseudowords: { items: s.pn, yes: s.py },
    answered: map.size,
    method: data.scoring.method,
    reliability: s.f > data.scoring.lowFalseAlarmRate || s.noise ? 'low' : 'ok',
    valid: s.f <= data.scoring.invalidFalseAlarmRate,
  }
  db.prepare('UPDATE vocab_tests SET answers = ?, result = ?, completed_at = ? WHERE id = ?')
    .run(JSON.stringify([...map].map(([id, known]) => ({ id, known }))), JSON.stringify(result), now.toISOString(), testId)
  return result
}

export interface TestSummary {
  id: string
  createdAt: string
  completedAt: string | null
  items: number
  result: TestResult | null
}

// Newest first.
export function listVocabTests(db: Db, userId: string): TestSummary[] {
  const rows = db.prepare('SELECT * FROM vocab_tests WHERE user_id = ? ORDER BY created_at DESC, id').all(userId) as unknown as TestRow[]
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    items: (JSON.parse(r.items) as unknown[]).length,
    result: r.result ? (JSON.parse(r.result) as TestResult) : null,
  }))
}

export interface VocabularySummary {
  available: { frequencies: boolean; test: boolean; scale: boolean }
  // Latest valid completed test, as scored then.
  latestTest: (TestResult & { completedAt: string }) | null
  // Now: the latest test's per-band shares combined with today's known words.
  current: VocabEstimate | null
  history: { testId: string; completedAt: string; estimate: number | null; adjusted: number; nativeEquivalent: number; reliability: string; valid: boolean }[]
  scale: VocabScale | null
}

export function vocabularySummary(db: Db, userId: string, lex: Lexicon, now: Date, deckId?: string): VocabularySummary {
  const available = { frequencies: lex.hasFrequencies(), test: lex.vocabTest() !== null, scale: lex.scale() !== null }
  const done = listVocabTests(db, userId).filter((t) => t.result && t.completedAt)
  const latest = done.find((t) => t.result!.valid) ?? null
  let current: VocabEstimate | null = null
  if (available.frequencies) {
    const { bands } = bandsOf(lex)
    const srs = srsBandCounts(db, userId, bands, now, deckId)
    const r = latest?.result
    // The latest test's smoothed shares, re-combined with today's SRS counts.
    const test = r && r.perBand.length === bands.length
      ? { known: r.perBand.map((b) => b.known), items: r.perBand.map((b) => b.items), yes: r.perBand.map((b) => b.yes), f: r.falseAlarmRate, interval: r.interval ?? [0, 0] as [number, number] }
      : null
    current = estimate(lex, srs, test)
  }
  return {
    available,
    latestTest: latest ? { ...latest.result!, completedAt: latest.completedAt! } : null,
    current,
    history: done.reverse().map((t) => ({
      testId: t.id,
      completedAt: t.completedAt!,
      estimate: t.result!.estimate,
      adjusted: t.result!.adjusted,
      nativeEquivalent: t.result!.nativeEquivalent.value,
      reliability: t.result!.reliability,
      valid: t.result!.valid,
    })),
    scale: lex.scale(),
  }
}
