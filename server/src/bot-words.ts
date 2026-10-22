// Adding words by messaging the bot. What a message means:
//   a word or short phrase (≤ 6 words, no sentence punctuation) → ✨ autofill,
//     added to the deck at once (studied from today), shown as a card with ✏️ Edit · ✖ (· ↔ Other meaning);
//   "word — sentence", or a sentence with the *word* (or "word", «word»)
//     marked → the same, the sentence picks the sense and becomes the first example;
//   "word — перевод" (no target-language sentence) → the right side is a hint;
//   several such lines (≤ 20) → each autofilled in turn, one progress message,
//     then a list with ✏️ Open in app and ✖ per word;
//   anything else (prose, a paragraph) or a photo / image file → Claude picks
//     up to 12 words likely new to this learner, shown as toggles + ➕ Add selected.
// Buttons carry `<kind>:<action>:<draft id>[:<index>]`; the draft (drafts.ts)
// holds the rest and must belong to the presser. Work runs in a per-user
// queue so a slow batch doesn't hold up the poller or other users.
import { LIMITS, normalizeTerm, type Deck, type PartOfSpeech } from '@recall/core'
import { GrammyError, InlineKeyboard, type Api, type Bot, type Context } from 'grammy'
import { autofill, withFirstExample, type Draft as Sense } from './autofill.ts'
import type { AppContext } from './context.ts'
import { createDraft, deleteDraft, getDraft, saveDraft } from './drafts.ts'
import { extractCandidates, IMAGE_TYPES, MAX_IMAGE_BYTES, type Candidate, type ExtractSource, type ImageType } from './extract.ts'
import { lexiconOf } from './lexicon.ts'
import {
  createWord, defaultDeck, deleteWord, DuplicateWordError, getWord, HttpError, setWordStatus, updateWord, withCards,
  type WordListItem, type WordRow,
} from './repo.ts'
import { KNOWN_R } from './study.ts'
import { ensureUser, type User } from './users.ts'

export const MAX_BATCH = 20
const SHORT_WORDS = 6

// ---------- runs work per user, in order ----------

export class TaskQueue {
  private tails = new Map<string, Promise<void>>()

  run(key: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(fn).catch((e) => console.error('telegram:', e))
    this.tails.set(key, next)
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    })
    return next
  }

  // Resolves once everything queued so far (and anything it queued) is done.
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all([...this.tails.values()])
  }
}

export interface WordBotOptions {
  queue?: TaskQueue
  // Downloads a file by its Bot API file_path; default https://api.telegram.org/file/bot<token>/<path>.
  download?: (filePath: string) => Promise<Uint8Array>
}

// ---------- reading a message ----------

export interface Item {
  term: string
  // A target-language sentence with the term: the first example.
  context: string | null
  // Anything else said about it ("— перевод"): steers the sense.
  hint: string | null
}

export type Parsed =
  | { kind: 'word'; item: Item }
  | { kind: 'batch'; items: Item[]; total: number }
  | { kind: 'text'; text: string }
  | { kind: 'link' }
  | { kind: 'empty' }

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
const words = (s: string) => clean(s).split(' ').filter(Boolean)
const LATIN = /[A-Za-z]/

// A word or phrase as one would look it up: ≤ 6 words, no sentence punctuation
// (one trailing . ! ? or … is fine).
export function isShortTerm(s: string): boolean {
  const t = clean(s).replace(/(\.\.\.|[.!?…])$/, '')
  return !!t && t.length <= 100 && words(t).length <= SHORT_WORDS && !/[.!?;:]/.test(t) && LATIN.test(t)
}

const MARKED = [/\*([^*\n]{1,100})\*/, /«([^»\n]{1,100})»/, /“([^”\n]{1,100})”/, /"([^"\n]{1,100})"/, /_([^_\n]{1,100})_/]

export function parseItem(raw: string): Item | null {
  const line = clean(raw).replace(/^(?:[-•*·]\s+|\d{1,2}[.)]\s+)/, '')
  if (!line) return null
  // term — sentence / term — перевод
  const dash = line.match(/^(.+?)\s+[—–-]\s+(.+)$/)
  if (dash && isShortTerm(dash[1]!)) {
    const right = dash[2]!.trim()
    const sentence = LATIN.test(right) && words(right).length >= 3
    return { term: clean(dash[1]!).replace(/[.!?]$/, ''), context: sentence ? right : null, hint: sentence ? null : right }
  }
  // A sentence with the word marked.
  for (const re of MARKED) {
    const m = line.match(re)
    if (m && isShortTerm(m[1]!) && words(line).length > words(m[1]!).length) {
      return { term: clean(m[1]!), context: clean(line.replace(re, '$1').replace(/[*«»“”]/g, '')), hint: null }
    }
  }
  return isShortTerm(line) ? { term: line.replace(/[.!?]$/, ''), context: null, hint: null } : null
}

export function parseMessage(text: string): Parsed {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { kind: 'empty' }
  if (lines.length === 1 && /^https?:\/\/\S+$/.test(lines[0]!)) return { kind: 'link' }
  const items = lines.map(parseItem)
  if (items.every((i): i is Item => i !== null)) {
    if (items.length === 1) return { kind: 'word', item: items[0]! }
    return { kind: 'batch', items: items.slice(0, MAX_BATCH), total: items.length }
  }
  return { kind: 'text', text: lines.join('\n') }
}

// ---------- texts ----------

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type CardWord = Pick<Sense, 'term' | 'pos' | 'translations' | 'ipa' | 'examples' | 'cefr'>

const posName = (p: PartOfSpeech) => p.replace('_', ' ')
const gloss = (w: Pick<CardWord, 'translations'>, n = 1) => w.translations.slice(0, n).join(', ')

// **term** /ipa/ · pos · CEFR; translations; one example + its translation.
export function cardText(w: CardWord): string {
  const head = [`<b>${esc(w.term)}</b>${w.ipa ? ` /${esc(w.ipa)}/` : ''}`, w.pos !== 'other' ? posName(w.pos) : null, w.cefr].filter(Boolean).join(' · ')
  const lines = [head, esc(w.translations.join(', '))]
  const ex = w.examples[0]
  if (ex) {
    lines.push(`<i>${esc(ex.text)}</i>`)
    if (ex.translation) lines.push(esc(ex.translation))
  }
  return lines.join('\n')
}

export function stateLabel(w: WordListItem): string {
  if (w.status === 'rejected') return 'dropped'
  const cards = [w.cards.forward, w.cards.reverse].filter((c) => c !== null && c.enabled)
  const live = cards.filter((c) => !c!.suspended)
  if (cards.length && !live.length) return 'suspended'
  if (live.some((c) => c!.state === 'review' && (c!.retrievability ?? 0) >= KNOWN_R)) return 'known'
  if (live.some((c) => c!.state !== 'new')) return 'learning'
  return 'new'
}

export const WORD_TEXT = {
  added: (w: Pick<CardWord, 'term' | 'translations'>) => `✅ Added: <b>${esc(w.term)}</b> — ${esc(gloss(w))}`,
  removed: (term: string) => `✖ Removed: ${esc(term)}`,
  duplicate: (w: WordListItem) => `Already in your deck: <b>${esc(w.term)}</b> — ${esc(gloss(w, 2))} · ${stateLabel(w)}`,
  translationsAdded: (term: string, added: string[]) => `➕ Added to <b>${esc(term)}</b>: ${esc(added.join(', '))}`,
  expired: 'This message has expired — send the word again',
  gone: 'This word is no longer in your deck',
  noOther: 'No other meaning to switch to',
  link: "I can't open links — paste the text or send a screenshot.",
  notLatin: 'Send the word in English, e.g. “to frown”.',
  looking: '🔍 Looking for words…',
  pickNone: 'Select some words first',
  noCandidates: 'No new words found here — they look familiar or are already in your deck.',
}

// Why autofill couldn't help, for the "add it in the app" reply.
export function failureReason(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 503 && /not configured/.test(e.message)) return 'autofill is off on this server'
    if (e.status === 429) return 'daily autofill limit reached'
    if (e.status === 422) return 'Claude declined'
    if (e.status === 504) return 'autofill timed out'
    if (e.status === 400) return e.message
  }
  return 'autofill failed'
}

// Limit / not configured: the rest of a batch would fail the same way.
const fatal = (e: unknown) => e instanceof HttpError && (e.status === 429 || (e.status === 503 && /not configured/.test(e.message)))

// ---------- adding one word ----------

interface WordPayload {
  wordId: string
  // The draft sense first, then the alternatives; `index` is the one the word has now.
  senses: Sense[]
  index: number
  context: string | null
}

interface DuplicatePayload {
  wordId: string
  translations: string[]
  context: string | null
}

export type AddOutcome =
  | { kind: 'created'; word: WordListItem; senses: Sense[]; context: string | null }
  | { kind: 'duplicate'; existing: WordListItem; newTranslations: string[]; context: string | null }
  | { kind: 'failed'; term: string; reason: string; error: unknown }

function item(ctx: AppContext, userId: string, id: string): WordListItem | null {
  const row = ctx.db.prepare('SELECT * FROM words WHERE id = ? AND user_id = ?').get(id, userId) as WordRow | undefined
  return row ? withCards(ctx.db, userId, [row], ctx.now())[0]! : null
}

const newTranslations = (existing: string[], proposed: string[]) => {
  const lower = existing.map((t) => t.toLowerCase())
  return proposed.filter((t) => !lower.includes(t.toLowerCase()))
}

export async function addOne(ctx: AppContext, user: User, deck: Deck, it: Item): Promise<AddOutcome> {
  let r
  try {
    r = await autofill(ctx, user, deck, { term: it.term, ...(it.hint ? { hint: it.hint } : {}), ...(it.context ? { context: it.context } : {}) })
  } catch (e) {
    return { kind: 'failed', term: it.term, reason: failureReason(e), error: e }
  }
  const senses = [r.draft, ...r.alternatives.map((a) => (it.context ? { ...a, examples: withFirstExample(a.examples, it.context) } : a))]
  const dupOf = (existingId: string): AddOutcome => {
    const existing = item(ctx, user.id, existingId)!
    return { kind: 'duplicate', existing, newTranslations: newTranslations(existing.translations, r.draft.translations), context: it.context }
  }
  if (r.duplicate) return dupOf(r.duplicate.id)
  try {
    const w = createWord(ctx.db, user.id, { deckId: deck.id, word: r.draft, status: 'active', createdBy: 'user' }, ctx.now(), lexiconOf(ctx))
    return { kind: 'created', word: item(ctx, user.id, w.id)!, senses, context: it.context }
  } catch (e) {
    if (e instanceof DuplicateWordError) return dupOf(e.existing.id)
    return { kind: 'failed', term: it.term, reason: failureReason(e), error: e }
  }
}

// ✖ on a word just added: deleted while unstudied, dropped (kept, never
// shown) once it has been reviewed.
function remove(ctx: AppContext, userId: string, wordId: string) {
  const reviewed = ctx.db.prepare('SELECT 1 FROM cards WHERE word_id = ? AND reps > 0').get(wordId)
  if (reviewed) setWordStatus(ctx.db, userId, wordId, 'rejected', ctx.now())
  else deleteWord(ctx.db, userId, wordId)
}

// ---------- keyboards ----------

const editUrl = (ctx: AppContext, wordId: string) => `${ctx.cfg.appOrigin}/#/words/${wordId}`
const newUrl = (ctx: AppContext, term: string) => `${ctx.cfg.appOrigin}/#/words/new?term=${encodeURIComponent(term)}`

function wordKeyboard(ctx: AppContext, draftId: string, p: WordPayload): InlineKeyboard {
  const k = new InlineKeyboard().webApp('✏️ Edit', editUrl(ctx, p.wordId)).text('✖', `w:no:${draftId}`)
  if (p.senses.length > 1) k.row().text('↔ Other meaning', `w:alt:${draftId}`)
  return k
}

const short = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

interface BatchPayload {
  created: { wordId: string; term: string; translation: string }[]
  removed: number[]
  duplicates: { term: string; translation: string; state: string }[]
  failed: { term: string; reason: string }[]
  // Lines beyond MAX_BATCH that were left out.
  skipped: number
}

export function batchText(p: BatchPayload): string {
  const out: string[] = []
  if (p.created.length) {
    out.push(`✅ Added ${p.created.length} ${p.created.length === 1 ? 'word' : 'words'}:`)
    p.created.forEach((c, i) => {
      const line = `${i + 1}. <b>${esc(c.term)}</b> — ${esc(c.translation)}`
      out.push(p.removed.includes(i) ? `<s>${line}</s>` : line)
    })
  } else out.push('Nothing new added.')
  if (p.duplicates.length) out.push(`Already in your deck: ${p.duplicates.map((d) => `${esc(d.term)} — ${esc(d.translation)} (${d.state})`).join('; ')}`)
  if (p.failed.length) out.push(`Not added: ${p.failed.map((f) => `${esc(f.term)} (${esc(f.reason)})`).join('; ')} — add in the app`)
  if (p.skipped) out.push(`Only the first ${MAX_BATCH} lines were taken; send the other ${p.skipped} again.`)
  return out.join('\n')
}

function batchKeyboard(ctx: AppContext, draftId: string, p: BatchPayload): InlineKeyboard | undefined {
  const live = p.created.map((c, i) => ({ c, i })).filter(({ i }) => !p.removed.includes(i))
  if (!live.length) return p.failed.length ? new InlineKeyboard().webApp('✏️ Add in the app', newUrl(ctx, p.failed[0]!.term)) : undefined
  const k = new InlineKeyboard().webApp('✏️ Open in app', `${ctx.cfg.appOrigin}/#/words`)
  live.forEach(({ c, i }, n) => {
    if (n % 3 === 0) k.row()
    k.text(`✖ ${short(c.term)}`, `b:rm:${draftId}:${i}`)
  })
  return k
}

interface PickPayload {
  candidates: Candidate[]
  selected: number[]
}

export function pickText(p: PickPayload): string {
  const n = p.candidates.length
  return [`Found ${n} ${n === 1 ? 'word' : 'words'} worth learning — tap to pick, then ➕ Add selected:`,
    ...p.candidates.map((c, i) => `${i + 1}. <b>${esc(c.term)}</b>${c.gloss ? ` — ${esc(c.gloss)}` : ''}`)].join('\n')
}

function pickKeyboard(draftId: string, p: PickPayload): InlineKeyboard {
  const k = new InlineKeyboard()
  p.candidates.forEach((c, i) => {
    if (i && i % 2 === 0) k.row()
    k.text(`${p.selected.includes(i) ? '✓ ' : ''}${short(c.term, 22)}`, `p:t:${draftId}:${i}`)
  })
  return k.row().text(p.selected.length ? `➕ Add selected (${p.selected.length})` : '➕ Add selected', `p:add:${draftId}`)
}

// ---------- telegram plumbing ----------

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } }

async function editText(api: Api, chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) {
  try {
    await api.editMessageText(chatId, messageId, text, { ...HTML, ...(keyboard ? { reply_markup: keyboard } : {}) })
  } catch (e) {
    if (!(e instanceof GrammyError && /not modified/.test(e.description))) throw e
  }
}

async function replyOutcome(ctx: AppContext, api: Api, chatId: number, user: User, o: AddOutcome, messageId?: number) {
  const send = (text: string, keyboard?: InlineKeyboard) =>
    messageId ? editText(api, chatId, messageId, text, keyboard) : api.sendMessage(chatId, text, { ...HTML, ...(keyboard ? { reply_markup: keyboard } : {}) })
  if (o.kind === 'created') {
    const d = createDraft<WordPayload>(ctx.db, user.id, 'word', { wordId: o.word.id, senses: o.senses, index: 0, context: o.context }, ctx.now())
    await send(`✅ ${cardText(o.word)}`, wordKeyboard(ctx, d.id, d.payload))
  } else if (o.kind === 'duplicate') {
    let text = WORD_TEXT.duplicate(o.existing)
    let k: InlineKeyboard | undefined
    if (o.newTranslations.length) {
      const d = createDraft<DuplicatePayload>(ctx.db, user.id, 'duplicate', { wordId: o.existing.id, translations: o.newTranslations, context: o.context }, ctx.now())
      text += `\nAlso: ${esc(o.newTranslations.join(', '))}`
      k = new InlineKeyboard().text('➕ Add translations', `d:add:${d.id}`)
    }
    await send(text, k)
  } else {
    await send(`Couldn't fill in <b>${esc(o.term)}</b>: ${esc(o.reason)}. Add it in the app:`, new InlineKeyboard().webApp('✏️ Add in the app', newUrl(ctx, o.term)))
  }
}

// Autofills the items one by one into the deck, editing `messageId` with the
// progress, and leaves the list with its buttons there.
async function runBatch(ctx: AppContext, api: Api, chatId: number, messageId: number, user: User, deck: Deck, items: Item[], skipped: number) {
  const p: BatchPayload = { created: [], removed: [], duplicates: [], failed: [], skipped }
  let stop: string | null = null
  for (const [n, it] of items.entries()) {
    if (stop) {
      p.failed.push({ term: it.term, reason: stop })
      continue
    }
    if (n) await editText(api, chatId, messageId, `⏳ Adding ${items.length} words… ${n}/${items.length}`).catch(() => {})
    void api.sendChatAction(chatId, 'typing').catch(() => {})
    const o = await addOne(ctx, user, deck, it)
    if (o.kind === 'created') p.created.push({ wordId: o.word.id, term: o.word.term, translation: gloss(o.word) })
    else if (o.kind === 'duplicate') p.duplicates.push({ term: o.existing.term, translation: gloss(o.existing), state: stateLabel(o.existing) })
    else {
      p.failed.push({ term: o.term, reason: o.reason })
      if (fatal(o.error)) stop = o.reason
    }
  }
  const d = createDraft<BatchPayload>(ctx.db, user.id, 'batch', p, ctx.now())
  await editText(api, chatId, messageId, batchText(p), batchKeyboard(ctx, d.id, p))
}

// ---------- handlers ----------

const DRAFT = 'bd_[a-z0-9]{10}'

export function installWordHandlers(bot: Bot, ctx: AppContext, opts: WordBotOptions = {}): TaskQueue {
  const { db, cfg } = ctx
  const queue = opts.queue ?? new TaskQueue()
  const download = opts.download ?? (async (filePath: string) => {
    const r = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`)
    if (!r.ok) throw new Error(`file download failed: ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  })
  const userOf = (c: Context) => ensureUser(db, cfg, c.from!.id, ctx.now(), c.from!.first_name)
  const deckOf = (u: User) => defaultDeck(db, u.id, ctx.now())
  const later = (c: Context, fn: (user: User) => Promise<void>) => {
    const user = userOf(c)
    void queue.run(user.id, () => fn(user))
  }

  const extract = async (c: Context, user: User, src: ExtractSource) => {
    const chatId = c.chat!.id
    const m = await c.reply(WORD_TEXT.looking)
    void c.api.sendChatAction(chatId, 'typing').catch(() => {})
    let candidates: Candidate[]
    try {
      candidates = (await extractCandidates(ctx, user, deckOf(user), src)).candidates
    } catch (e) {
      const reason = failureReason(e)
      await editText(c.api, chatId, m.message_id, `Couldn't look for words: ${esc(reason)}.`)
      return
    }
    if (!candidates.length) {
      await editText(c.api, chatId, m.message_id, WORD_TEXT.noCandidates)
      return
    }
    const d = createDraft<PickPayload>(db, user.id, 'pick', { candidates, selected: [] }, ctx.now())
    await editText(c.api, chatId, m.message_id, pickText(d.payload), pickKeyboard(d.id, d.payload))
  }

  bot.on('message:text', async (c, next) => {
    if (c.chat.type !== 'private') return next()
    const text = c.message.text
    if (text.startsWith('/')) {
      await c.reply('Unknown command. /help shows what I can do.')
      return
    }
    const parsed = parseMessage(text)
    if (parsed.kind === 'empty') return
    if (parsed.kind === 'link') {
      await c.reply(WORD_TEXT.link)
      return
    }
    later(c, async (user) => {
      const chatId = c.chat.id
      if (parsed.kind === 'word') {
        void c.api.sendChatAction(chatId, 'typing').catch(() => {})
        await replyOutcome(ctx, c.api, chatId, user, await addOne(ctx, user, deckOf(user), parsed.item))
      } else if (parsed.kind === 'batch') {
        const m = await c.reply(`⏳ Adding ${parsed.items.length} words…`)
        await runBatch(ctx, c.api, chatId, m.message_id, user, deckOf(user), parsed.items, parsed.total - parsed.items.length)
      } else {
        await extract(c, user, { kind: 'text', text: parsed.text })
      }
    })
  })

  const image = async (c: Context, user: User, fileId: string, size: number | undefined, mediaType: ImageType, caption?: string) => {
    if (size !== undefined && size > MAX_IMAGE_BYTES) {
      await c.reply('This image is too large — send it as a photo, not a file.')
      return
    }
    let data: Uint8Array
    try {
      const file = await c.api.getFile(fileId)
      if (!file.file_path) throw new Error('no file_path')
      data = await download(file.file_path)
    } catch (e) {
      console.error('telegram: photo download:', e)
      await c.reply("Couldn't download the image, try again.")
      return
    }
    if (data.byteLength > MAX_IMAGE_BYTES) {
      await c.reply('This image is too large — send it as a photo, not a file.')
      return
    }
    // Only in memory: the image goes to Claude and is dropped.
    await extract(c, user, { kind: 'image', data, mediaType, ...(caption ? { caption } : {}) })
  }

  bot.on('message:photo', async (c, next) => {
    if (c.chat.type !== 'private') return next()
    // Largest size that fits the limit (Telegram lists them small to large).
    const sizes = [...c.message.photo].sort((a, b) => a.width * a.height - b.width * b.height)
    const best = sizes.filter((s) => (s.file_size ?? 0) <= MAX_IMAGE_BYTES).at(-1) ?? sizes.at(-1)!
    later(c, (user) => image(c, user, best.file_id, best.file_size, 'image/jpeg', c.message.caption))
  })

  bot.on('message:document', async (c, next) => {
    const doc = c.message.document
    if (c.chat.type !== 'private' || !doc.mime_type || !(IMAGE_TYPES as readonly string[]).includes(doc.mime_type)) return next()
    later(c, (user) => image(c, user, doc.file_id, doc.file_size, doc.mime_type as ImageType, c.message.caption))
  })

  // ---------- buttons ----------

  const expired = (c: Context) => c.answerCallbackQuery({ text: WORD_TEXT.expired })

  bot.callbackQuery(new RegExp(`^w:(ok|no|alt):(${DRAFT})$`), (c) => later(c, async (user) => {
    const [, action, id] = c.match as RegExpMatchArray
    const d = getDraft<WordPayload>(db, user.id, id!, 'word', ctx.now())
    if (!d) return void (await expired(c))
    const p = d.payload
    const word = getWord(db, user.id, p.wordId)
    if (!word) {
      deleteDraft(db, user.id, d.id)
      await c.answerCallbackQuery({ text: WORD_TEXT.gone })
      await c.editMessageReplyMarkup().catch(() => {})
      return
    }
    if (action === 'ok') {
      // ✅ of a message sent before the inbox went away: the word is studied already.
      const w = word.status === 'active' ? word : setWordStatus(db, user.id, word.id, 'active', ctx.now())
      deleteDraft(db, user.id, d.id)
      await c.answerCallbackQuery()
      await c.editMessageText(WORD_TEXT.added(w), { ...HTML, reply_markup: new InlineKeyboard().webApp('✏️ Edit', editUrl(ctx, w.id)) })
    } else if (action === 'no') {
      remove(ctx, user.id, word.id)
      deleteDraft(db, user.id, d.id)
      await c.answerCallbackQuery()
      await c.editMessageText(WORD_TEXT.removed(word.term), HTML)
    } else {
      // The next sense that doesn't collide with another word of the deck.
      for (let step = 1; step < p.senses.length; step++) {
        const index = (p.index + step) % p.senses.length
        const s = p.senses[index]!
        try {
          updateWord(db, user.id, word.id, { term: s.term, pos: s.pos, translations: s.translations, ipa: s.ipa, examples: s.examples, note: s.note, cefr: s.cefr }, ctx.now(), lexiconOf(ctx))
        } catch (e) {
          if (e instanceof DuplicateWordError) continue
          throw e
        }
        p.index = index
        saveDraft(db, user.id, d.id, p)
        await c.answerCallbackQuery()
        await c.editMessageText(`✅ ${cardText(s)}`, { ...HTML, reply_markup: wordKeyboard(ctx, d.id, p) })
        return
      }
      await c.answerCallbackQuery({ text: WORD_TEXT.noOther })
    }
  }))

  bot.callbackQuery(new RegExp(`^d:add:(${DRAFT})$`), (c) => later(c, async (user) => {
    const d = getDraft<DuplicatePayload>(db, user.id, (c.match as RegExpMatchArray)[1]!, 'duplicate', ctx.now())
    if (!d) return void (await expired(c))
    const word = getWord(db, user.id, d.payload.wordId)
    if (!word) {
      deleteDraft(db, user.id, d.id)
      await c.answerCallbackQuery({ text: WORD_TEXT.expired })
      return
    }
    const added = newTranslations(word.translations, d.payload.translations).slice(0, Math.max(0, LIMITS.translations - word.translations.length))
    // The sentence it was just met in joins the examples, after the existing ones.
    const sentence = d.payload.context
    const ex = sentence && word.examples.length < LIMITS.examples && !word.examples.some((e) => normalizeTerm(e.text) === normalizeTerm(sentence))
      ? [...word.examples, { text: sentence, translation: null }]
      : word.examples
    updateWord(db, user.id, word.id, { translations: [...word.translations, ...added], examples: ex }, ctx.now(), lexiconOf(ctx))
    deleteDraft(db, user.id, d.id)
    await c.answerCallbackQuery()
    await c.editMessageText(WORD_TEXT.translationsAdded(word.term, added), { ...HTML, reply_markup: new InlineKeyboard().webApp('✏️ Edit', editUrl(ctx, word.id)) })
  }))

  bot.callbackQuery(new RegExp(`^b:(all|rm):(${DRAFT})(?::(\\d{1,2}))?$`), (c) => later(c, async (user) => {
    const [, action, id, index] = c.match as RegExpMatchArray
    const d = getDraft<BatchPayload>(db, user.id, id!, 'batch', ctx.now())
    if (!d) return void (await expired(c))
    const p = d.payload
    if (action === 'rm') {
      const i = Number(index)
      const it = p.created[i]
      if (!it || p.removed.includes(i)) return void (await c.answerCallbackQuery())
      if (getWord(db, user.id, it.wordId)) remove(ctx, user.id, it.wordId)
      p.removed.push(i)
    } else {
      // ✅ Add all of a list sent before the inbox went away: nothing left to do.
      return void (await c.answerCallbackQuery())
    }
    saveDraft(db, user.id, d.id, p)
    await c.answerCallbackQuery()
    const k = batchKeyboard(ctx, d.id, p)
    await c.editMessageText(batchText(p), { ...HTML, ...(k ? { reply_markup: k } : {}) })
  }))

  bot.callbackQuery(new RegExp(`^p:(t|add):(${DRAFT})(?::(\\d{1,2}))?$`), (c) => later(c, async (user) => {
    const [, action, id, index] = c.match as RegExpMatchArray
    const d = getDraft<PickPayload>(db, user.id, id!, 'pick', ctx.now())
    if (!d) return void (await expired(c))
    const p = d.payload
    if (action === 't') {
      const i = Number(index)
      if (!p.candidates[i]) return void (await c.answerCallbackQuery())
      p.selected = p.selected.includes(i) ? p.selected.filter((x) => x !== i) : [...p.selected, i].sort((a, b) => a - b)
      saveDraft(db, user.id, d.id, p)
      await c.answerCallbackQuery()
      await c.editMessageReplyMarkup({ reply_markup: pickKeyboard(d.id, p) })
      return
    }
    if (!p.selected.length) return void (await c.answerCallbackQuery({ text: WORD_TEXT.pickNone }))
    deleteDraft(db, user.id, d.id)
    await c.answerCallbackQuery()
    const chatId = c.chat!.id
    const messageId = c.callbackQuery!.message!.message_id
    const items = p.selected.map((i) => p.candidates[i]!).map((cand) => ({ term: cand.term, context: cand.sentence, hint: cand.gloss }))
    await editText(c.api, chatId, messageId, `⏳ Adding ${items.length} words…`)
    await runBatch(ctx, c.api, chatId, messageId, user, deckOf(user), items, 0)
  }))

  return queue
}
