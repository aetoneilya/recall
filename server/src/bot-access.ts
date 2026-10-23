// Getting in from the bot. A stranger's /start (or any message) gets a short
// line with [Request access]; pressing it sends the owner the requester's
// name, @username and Telegram id with [Allow] [Deny]. Allow puts them on the
// allowlist (access.ts) and sends them the Mini App button; Deny says so
// politely; either way the owner's message shows the outcome. While a request
// waits, or for a week after a deny, asking again doesn't reach the owner.
// /users (owner only) lists who has access, with [Revoke] for the accounts
// let in from here.
// Buttons carry `<kind>:<action>:<telegram id>` (≤ 64 bytes); only the
// owner's presses on Allow / Deny / Revoke count.
import { InlineKeyboard, type Bot, type Context } from 'grammy'
import { decideRequest, dropRequest, getRequest, listAllowed, openRequest, requestState, revokeAccount, type AllowedAccount, type Requester } from './access.ts'
import type { AppContext } from './context.ts'
import { ensureUser, ownerTelegramId, setBotStarted } from './users.ts'

export const ACCESS_TEXT = {
  intro: 'This is a private bot: Mnemosyne, a spaced-repetition app for learning English words. Ask the owner to let you in.',
  button: '🙋 Request access',
  sent: 'Asked — you’ll get a message here once the owner answers.',
  pending: 'You’ve already asked — you’ll get a message here once the owner answers.',
  cooldown: 'Not now, sorry — try again in a few days.',
  closed: 'This is a private bot.',
  unreachable: 'Couldn’t reach the owner just now — try again later.',
  allowed: 'You’re in! Open Mnemosyne to set it up — it takes a minute. You can also send me English words to add.',
  denied: 'Sorry, the owner can’t add you right now. Thanks for asking!',
  already: 'Already answered',
  open: 'Open Mnemosyne',
}

// Telegram ids are at most 52 bits; the pattern only has to keep junk out.
const ID = '(\\d{1,16})'
const REQUEST = new RegExp(`^access:req:${ID}$`)
const DECIDE = new RegExp(`^access:(allow|deny):${ID}$`)
const REVOKE = new RegExp(`^users:revoke:${ID}$`)

export const requestData = (id: number) => `access:req:${id}`

export function requesterOf(from: { id: number; first_name?: string; last_name?: string; username?: string }): Requester {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim().slice(0, 100)
  return { telegramId: from.id, name, username: from.username ?? null }
}

// "Anna Smith @anna · 2002" — the owner's chat only.
export function whoLine(a: Pick<Requester, 'telegramId' | 'name' | 'username'>): string {
  const name = [a.name, a.username ? `@${a.username}` : ''].filter(Boolean).join(' ')
  return name ? `${name} · ${a.telegramId}` : String(a.telegramId)
}

export function ownerRequestText(who: Requester): string {
  return `🙋 Access request\n${whoLine(who)}`
}

export function decisionText(who: Requester, allow: boolean): string {
  return `${allow ? '✅ Allowed' : '✖ Denied'}: ${whoLine(who)}`
}

// The /users message: everyone let in besides the owner, the config's
// marked (changed in the config, not here), a Revoke button per account
// let in from the bot.
export function usersView(list: AllowedAccount[], note?: string): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
  const lines = list.map((a) => `• ${whoLine(a)} — ${a.via === 'config' ? 'from the config (ALLOW_USER_IDS), not revocable here' : 'let in from the bot'}`)
  for (const [i, a] of list.filter((x) => x.via === 'bot').entries()) {
    if (i) keyboard.row()
    keyboard.text(`✖ Revoke ${(a.name || (a.username ? `@${a.username}` : String(a.telegramId))).slice(0, 24)}`, `users:revoke:${a.telegramId}`)
  }
  const head = list.length ? `👥 Who has access besides you (${list.length}):` : 'No one else has access yet. When someone sends me /start they can ask, and you’ll get a message here.'
  return { text: [note, head, ...lines].filter(Boolean).join('\n'), keyboard }
}

// Updates from accounts that aren't allowed: the way in, and nothing else.
export async function answerStranger(c: Context, ctx: AppContext): Promise<void> {
  const from = c.from
  if (!from) return
  const owner = ctx.cfg.ownerTelegramId
  if (c.callbackQuery) {
    const m = c.callbackQuery.data?.match(REQUEST)
    if (!m || Number(m[1]) !== from.id) return void (await c.answerCallbackQuery())
    if (owner === null) return void (await c.answerCallbackQuery({ text: ACCESS_TEXT.closed }))
    await requestAccess(c, ctx, owner)
    return
  }
  if (c.chat?.type !== 'private') return
  if (owner === null) return void (await c.reply(ACCESS_TEXT.closed))
  const state = requestState(getRequest(ctx.db, from.id), ctx.now())
  if (state === 'pending') await c.reply(ACCESS_TEXT.pending)
  else if (state === 'cooldown') await c.reply(ACCESS_TEXT.cooldown)
  else await c.reply(ACCESS_TEXT.intro, { reply_markup: new InlineKeyboard().text(ACCESS_TEXT.button, requestData(from.id)) })
}

async function requestAccess(c: Context, ctx: AppContext, owner: number) {
  const who = requesterOf(c.from!)
  const state = openRequest(ctx.db, who, ctx.now())
  await c.answerCallbackQuery()
  if (state !== 'new') return void (await c.editMessageText(state === 'pending' ? ACCESS_TEXT.pending : ACCESS_TEXT.cooldown))
  try {
    const buttons = new InlineKeyboard().text('✅ Allow', `access:allow:${who.telegramId}`).text('✖ Deny', `access:deny:${who.telegramId}`)
    await c.api.sendMessage(owner, ownerRequestText(who), { reply_markup: buttons })
  } catch (e) {
    // The owner hasn't started the bot (or blocked it): forget the request so it can be sent again.
    dropRequest(ctx.db, who.telegramId)
    console.error('telegram: access request not delivered:', (e as Error).message)
    return void (await c.editMessageText(ACCESS_TEXT.unreachable))
  }
  await c.editMessageText(ACCESS_TEXT.sent)
}

// Allow / Deny / Revoke and /users. Runs behind the allowlist middleware, so
// only allowed accounts get here; of those only the owner's presses count.
export function installAccessHandlers(bot: Bot, ctx: AppContext) {
  const { db, cfg } = ctx
  const isOwner = (c: Context) => !!c.from && c.from.id === ownerTelegramId(cfg)

  // An old [Request access] pressed by someone who is in by now.
  bot.callbackQuery(REQUEST, async (c) => {
    await c.answerCallbackQuery({ text: 'You already have access' })
  })

  bot.callbackQuery(DECIDE, async (c) => {
    if (!isOwner(c)) return void (await c.answerCallbackQuery())
    const [, action, raw] = c.match as RegExpMatchArray
    const allow = action === 'allow'
    const id = Number(raw)
    const now = ctx.now()
    const req = decideRequest(db, id, allow, now)
    if (!req) return void (await c.answerCallbackQuery({ text: ACCESS_TEXT.already }))
    await c.answerCallbackQuery()
    await c.editMessageText(decisionText(req, allow))
    try {
      if (allow) {
        // They've talked to the bot already: reminders may go to their chat.
        const user = ensureUser(db, cfg, id, now, req.name)
        setBotStarted(db, user.id, now)
        await c.api.sendMessage(id, ACCESS_TEXT.allowed, { reply_markup: new InlineKeyboard().webApp(ACCESS_TEXT.open, cfg.appOrigin) })
        await c.api.setChatMenuButton({ chat_id: id, menu_button: { type: 'web_app', text: 'Review', web_app: { url: cfg.appOrigin } } })
      } else await c.api.sendMessage(id, ACCESS_TEXT.denied)
    } catch (e) {
      console.error('telegram: access answer not delivered:', (e as Error).message)
    }
  })

  bot.command('users', async (c, next) => {
    if (!isOwner(c)) return next()
    const v = usersView(listAllowed(db, cfg))
    await c.reply(v.text, { reply_markup: v.keyboard })
  })

  bot.callbackQuery(REVOKE, async (c) => {
    if (!isOwner(c)) return void (await c.answerCallbackQuery())
    const id = Number((c.match as RegExpMatchArray)[1])
    const who = listAllowed(db, cfg).find((a) => a.telegramId === id && a.via === 'bot')
    const gone = who ? revokeAccount(db, cfg, id) : false
    await c.answerCallbackQuery(gone ? {} : { text: 'Not on the list' })
    const v = usersView(listAllowed(db, cfg), gone && who ? `✖ Revoked: ${whoLine(who)}` : undefined)
    // Unchanged text and buttons is an error to Telegram; nothing to show then.
    await c.editMessageText(v.text, { reply_markup: v.keyboard }).catch(() => {})
  })
}
