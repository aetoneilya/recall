// Data files in DATA_DIR (default server/data), all optional:
//   en-freq.tsv      English lemma frequency list → Word.freqRank, coverage bands
//   vocab-test.json  Yes/No vocabulary test: real words per 1000-band + pseudowords + scoring
//   vocab-scale.json vocabulary size → level labels for the dashboard
// Loaded lazily and re-read when a file appears or changes (checked at most
// every 30 s), so the server runs — with those features off — while one is missing.
import fs from 'node:fs'
import path from 'node:path'
import type { AppContext } from './context.ts'

export interface TestBand {
  // Inclusive rank range, e.g. 1001..2000.
  from: number
  to: number
  words: string[]
}

export type ScoringMethod = 'isdt' | 'corrected' | 'raw'

export interface VocabTestData {
  bands: TestBand[]
  bandSize: number
  pseudowords: string[]
  itemsPerBand: number
  pseudowordShare: number
  scoring: {
    // corrected: known_b = max(0, (h_b − f) / (1 − f)); isdt: Huibregtse et al. 2002 I_SDT per band; raw: h_b.
    method: ScoringMethod
    // Make the per-band curve non-increasing (pool-adjacent-violators).
    smooth: boolean
    // Above this false-alarm rate the result is flagged unreliable…
    lowFalseAlarmRate: number
    // …and above this one it is invalid (retake).
    invalidFalseAlarmRate: number
    // The file's own description of the scoring, passed through for the UI.
    raw: unknown
  }
}

export type ScaleGroup = 'learner' | 'native' | 'fun' | string

export interface ScalePoint {
  id: string
  size: number
  label: string
  labelRu: string | null
  emoji: string | null
  // learner points (CEFR, X_Lex, ≤ 5k lemmas) compare against the raw in-list
  // estimate; native and fun points against the native equivalent.
  group: ScaleGroup
  range: [number, number] | null
  // Converted or interpolated: show as "≈".
  approximate: boolean
  source: string | null
  url: string | null
}

export interface VocabScale {
  unit: string
  points: ScalePoint[]
  // nativeEquivalent = adultSize × inListEstimate / expectedInList (README §3).
  calibration: { adultSize: number; expectedInList: number; listSize: number | null }
}

export interface Lexicon {
  // Rank of one word, lemmatised (frowned → frown); null when not in the list.
  lemmaRank(word: string): number | null
  // Rank of a term: single words by lemma; a multi-word term takes its rarest
  // component, or null when any component is not in the list.
  rank(term: string): number | null
  // Lemma of a single-word term as found in the list (for "is this lemma in the app").
  lemma(term: string): string | null
  hasFrequencies(): boolean
  // Number of lemmas in the frequency list (0 when missing).
  freqSize(): number
  vocabTest(): VocabTestData | null
  scale(): VocabScale | null
  // Increments whenever the frequency list is (re)loaded.
  freqVersion(): number
}

const RECHECK_MS = 30_000

// Re-reads `file` through `parse` when its mtime changes; null while missing or broken.
function cached<T>(file: string, parse: (text: string) => T): () => T | null {
  let checkedAt = -Infinity
  let mtime = -1
  let value: T | null = null
  return () => {
    const now = Date.now()
    if (now - checkedAt < RECHECK_MS) return value
    checkedAt = now
    let m: number
    try {
      m = fs.statSync(file).mtimeMs
    } catch {
      if (mtime !== -1) console.warn(`${path.basename(file)} is gone; its features are off`)
      mtime = -1
      value = null
      return null
    }
    if (m === mtime) return value
    mtime = m
    try {
      value = parse(fs.readFileSync(file, 'utf8'))
      console.log(`loaded ${file}`)
    } catch (e) {
      console.error(`cannot load ${file}: ${(e as Error).message}`)
      value = null
    }
    return value
  }
}

// ---------- frequency list ----------

// Accepts `rank<TAB>lemma[...]`, `lemma<TAB>rank[...]`, or one lemma per line
// in rank order; `#` comments and a header row (naming rank / lemma|word columns) are fine.
export function parseFrequencies(text: string): Map<string, number> {
  const out = new Map<string, number>()
  let rankCol = -1
  let lemmaCol = -1
  let n = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const cols = (line.includes('\t') ? line.split('\t') : line.split(/\s+/)).map((c) => c.trim())
    if (n === 0 && rankCol < 0 && cols.some((c) => /^(rank|lemma|word|headword)$/i.test(c))) {
      rankCol = cols.findIndex((c) => /^(rank|#|n)$/i.test(c))
      lemmaCol = cols.findIndex((c) => /^(lemma|word|headword)$/i.test(c))
      continue
    }
    n++
    let lemma: string | undefined
    let rank: number
    if (lemmaCol >= 0) {
      lemma = cols[lemmaCol]
      rank = rankCol >= 0 ? Number(cols[rankCol]) : n
    } else if (/^\d+$/.test(cols[0]!) && cols.length > 1) {
      rank = Number(cols[0])
      lemma = cols[1]
    } else {
      lemma = cols[0]
      rank = cols[1] && /^\d+$/.test(cols[1]) ? Number(cols[1]) : n
    }
    if (!lemma || !Number.isFinite(rank)) continue
    const key = lemma.toLowerCase()
    const had = out.get(key)
    if (had === undefined || rank < had) out.set(key, rank)
  }
  return out
}

// Candidate lemmas of an inflected form, most likely first.
export function lemmaCandidates(w: string): string[] {
  const c: string[] = [w]
  const add = (s: string) => {
    if (s.length >= 2 && !c.includes(s)) c.push(s)
  }
  const undouble = (s: string) => (/([^aeiou])\1$/.test(s) ? s.slice(0, -1) : null)
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('es')) add(w.slice(0, -2))
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1))
  for (const suf of ['ed', 'ing', 'er', 'est']) {
    if (!w.endsWith(suf)) continue
    const stem = w.slice(0, -suf.length)
    add(stem)
    add(stem + 'e')
    const u = undouble(stem)
    if (u) add(u)
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }
  return c
}

// "To frown (smb)…" → ["frown"]; "grown-up" stays one token.
export function termTokens(term: string): string[] {
  const t = term
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/…|\.\.\./g, ' ')
    .replace(/[^\p{L}\p{N}'’\- ]/gu, ' ')
    .replace(/’/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^to /, '')
  return t ? t.split(' ').filter((x) => x !== '-') : []
}

export function makeLexicon(freq: () => Map<string, number> | null, test: () => VocabTestData | null, scale: () => VocabScale | null): Lexicon {
  let version = 0
  let last: Map<string, number> | null = null
  const lemmaOf = (word: string): string | null => {
    const f = freq()
    if (!f) return null
    const w = word.toLowerCase().replace(/^'+|'+$/g, '')
    for (const cand of lemmaCandidates(w)) if (f.has(cand)) return cand
    return null
  }
  const lemmaRank = (word: string) => {
    const l = lemmaOf(word)
    return l === null ? null : freq()!.get(l)!
  }
  return {
    lemmaRank,
    rank(term) {
      const tokens = termTokens(term)
      if (!tokens.length || !freq()) return null
      if (tokens.length === 1) {
        const r = lemmaRank(tokens[0]!)
        if (r !== null || !tokens[0]!.includes('-')) return r
        tokens.splice(0, 1, ...tokens[0]!.split('-').filter(Boolean))
      }
      let worst = 0
      for (const t of tokens) {
        const r = lemmaRank(t)
        if (r === null) return null
        worst = Math.max(worst, r)
      }
      return worst
    },
    lemma(term) {
      const tokens = termTokens(term)
      return tokens.length === 1 ? lemmaOf(tokens[0]!) : null
    },
    hasFrequencies: () => freq() !== null,
    freqSize: () => freq()?.size ?? 0,
    freqVersion() {
      const f = freq()
      if (f !== last) {
        last = f
        version++
      }
      return version
    },
    vocabTest: test,
    scale,
  }
}

// ---------- vocabulary test ----------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)

function wordList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? ((x as Record<string, unknown>).word ?? (x as Record<string, unknown>).lemma ?? (x as Record<string, unknown>).text) : null))
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim())
}

// Bands as an array of {from, to, words} (also {band: k} = the k-th thousand,
// {start, end}, {range: "1001-2000"}) or an object keyed by band ("1000",
// "1-1000", "2k"); a word list per band.
function parseBands(v: unknown): TestBand[] {
  const out: TestBand[] = []
  const push = (key: unknown, b: Record<string, unknown> | null, words: string[]) => {
    let from = num(b?.from ?? b?.start ?? b?.min)
    let to = num(b?.to ?? b?.end ?? b?.max)
    const range = (b?.range ?? key) as unknown
    if ((from === null || to === null) && typeof range === 'string') {
      const m = range.match(/^(\d+)\s*[-–]\s*(\d+)$/)
      if (m) [from, to] = [Number(m[1]), Number(m[2])]
      else {
        const k = range.match(/^(\d+)\s*k$/i)
        if (k) [from, to] = [(Number(k[1]) - 1) * 1000 + 1, Number(k[1]) * 1000]
      }
    }
    const band = num(b?.band ?? (typeof key === 'string' || typeof key === 'number' ? key : null))
    if ((from === null || to === null) && band !== null) {
      // "3" = the third thousand; "3000" = up to rank 3000.
      if (band <= 100) [from, to] = [(band - 1) * 1000 + 1, band * 1000]
      else [from, to] = [band - 999, band]
    }
    if (from !== null && to !== null && words.length) out.push({ from, to, words })
  }
  if (Array.isArray(v)) {
    v.forEach((b, i) => {
      const o = b && typeof b === 'object' ? (b as Record<string, unknown>) : null
      push(i + 1, o, wordList(o?.words ?? o?.items ?? b))
    })
  } else if (v && typeof v === 'object') {
    for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
      const o = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null
      push(k, o, wordList(o ? o.words ?? o.items : b))
    }
  }
  return out.sort((a, b) => a.from - b.from)
}

export function parseVocabTest(text: string): VocabTestData {
  const j = JSON.parse(text) as Record<string, unknown>
  const bands = parseBands(j.bands ?? j.real ?? j.words)
  if (!bands.length) throw new Error('no bands with words')
  const pseudowords = wordList(j.pseudowords ?? j.nonwords ?? j.pseudo ?? j.fakes)
  if (!pseudowords.length) throw new Error('no pseudowords')
  const s = (j.scoring && typeof j.scoring === 'object' ? j.scoring : {}) as Record<string, unknown>
  // An explicit method name wins; then the formula: "(h_b - f) / (1 - f)" is
  // the correction for guessing; I_SDT only when it is the main formula.
  const named = String(s.name ?? s.correction ?? '').toLowerCase()
  const formula = String(s.formula ?? s.method ?? (typeof j.scoring === 'string' ? j.scoring : '')).toLowerCase()
  const method: ScoringMethod =
    /isdt|i_sdt|huibregtse/.test(named) ? 'isdt'
    : /raw|none|uncorrected/.test(named) ? 'raw'
    : named ? 'corrected'
    : /\(\s*h(_b)?\s*-\s*f\s*\)\s*\/\s*\(\s*1\s*-\s*f\s*\)|correction for guessing|cfg/.test(formula) ? 'corrected'
    : /^\s*i_?sdt/.test(formula) ? 'isdt'
    : 'corrected'
  const per = num(j.itemsPerBand ?? s.itemsPerBand) ?? 3
  const shareRaw = j.pseudowordShare ?? s.pseudowordShare
  const share = typeof shareRaw === 'number' ? shareRaw : 0.25
  const invalid = Number(s.invalidFalseAlarmRate ?? 0.5)
  const low = Number(s.lowFalseAlarmRate ?? s.maxFalseAlarmRate ?? 0.2)
  return {
    bands,
    bandSize: num(j.bandSize) ?? (bands[0]!.to - bands[0]!.from + 1),
    pseudowords,
    itemsPerBand: Math.max(1, Math.min(per, 20)),
    pseudowordShare: Math.max(0, Math.min(share, 0.5)),
    scoring: {
      method,
      smooth: s.smooth !== false,
      lowFalseAlarmRate: Number.isFinite(low) && low > 0 && low < 1 ? low : 0.2,
      invalidFalseAlarmRate: Number.isFinite(invalid) && invalid > 0 && invalid < 1 ? invalid : 0.5,
      raw: j.scoring ?? null,
    },
  }
}

// {points: [{id, value, label_en, label_ru, emoji, group, range, approximate, …}], calibration}
// (also a bare array; size may be called value / size / words, label label_en / label / level).
export function parseScale(text: string): VocabScale {
  const j = JSON.parse(text) as unknown
  const o = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  const list = Array.isArray(j) ? j : (o?.points ?? o?.levels ?? o?.scale ?? [])
  if (!Array.isArray(list)) throw new Error('no scale points')
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const points = list
    .map((p, i): ScalePoint | null => {
      if (!p || typeof p !== 'object') return null
      const r = p as Record<string, unknown>
      const size = num(r.value ?? r.size ?? r.words ?? r.vocabulary ?? r.n)
      const label = str(r.label_en ?? r.label ?? r.level ?? r.name ?? r.title)
      if (size === null || !label) return null
      const range = Array.isArray(r.range) && r.range.length === 2 && r.range.every((x) => typeof x === 'number') ? (r.range as [number, number]) : null
      return {
        id: str(r.id) ?? `p${i}`,
        size,
        label,
        labelRu: str(r.label_ru),
        emoji: str(r.emoji),
        group: str(r.group) ?? 'native',
        range,
        approximate: r.approximate === true,
        source: str(r.source),
        url: str(r.url),
      }
    })
    .filter((p): p is ScalePoint => p !== null)
    .sort((a, b) => a.size - b.size)
  if (!points.length) throw new Error('no scale points')
  const cal = (o?.calibration ?? {}) as Record<string, unknown>
  const adult = points.find((p) => p.id === 'adult20')?.size ?? 42000
  return {
    unit: str(o?.unit) ?? 'lemmas',
    points,
    calibration: {
      adultSize: num(cal.adultSize) ?? adult,
      expectedInList: num(cal.expectedKnownInList_averageRespondent ?? cal.expectedInList) ?? 26686,
      listSize: num(cal.listSize),
    },
  }
}

export function loadLexicon(dir: string): Lexicon {
  return makeLexicon(
    cached(path.join(dir, 'en-freq.tsv'), parseFrequencies),
    cached(path.join(dir, 'vocab-test.json'), parseVocabTest),
    cached(path.join(dir, 'vocab-scale.json'), parseScale),
  )
}

export function lexiconOf(ctx: AppContext): Lexicon {
  return (ctx.lexicon ??= loadLexicon(ctx.cfg.dataDir))
}

// The point at or below `size` and the next one above it, among `points`.
export function scalePosition(points: ScalePoint[], size: number | null): { level: ScalePoint | null; next: ScalePoint | null } {
  if (size === null) return { level: null, next: null }
  let level: ScalePoint | null = null
  for (const p of points) if (p.size <= size) level = p
  return { level, next: points.find((p) => p.size > size) ?? null }
}
