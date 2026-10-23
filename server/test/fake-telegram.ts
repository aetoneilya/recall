// The real bot handlers over a fake Telegram API that records every call and
// keeps each message's current text and buttons (sendMessage, edits). No
// network: file downloads go through `files`.
import type { UserFromGetMe } from 'grammy/types'
import { TaskQueue } from '../src/bot-words.ts'
import { createBot } from '../src/bot.ts'
import type { AppContext } from '../src/context.ts'

export interface Shown {
  chatId: number
  text: string
  // [[label, callback_data | web_app url]]
  buttons: [string, string][][]
}

export function fakeBot(ctx: AppContext, files: Map<string, Uint8Array> = new Map()) {
  const queue = new TaskQueue()
  const bot = createBot(ctx, { id: 123456, is_bot: true, first_name: 'Mnemosyne', username: 'mnemo_bot' } as UserFromGetMe, {
    queue,
    download: async (path) => {
      const f = files.get(path)
      if (!f) throw new Error(`no file ${path}`)
      return f
    },
  })
  const calls: { method: string; payload: any }[] = []
  const messages = new Map<number, Shown>()
  let nextId = 100
  const keyboard = (markup: any): [string, string][][] =>
    (markup?.inline_keyboard ?? []).map((row: any[]) => row.map((b) => [b.text, b.callback_data ?? b.web_app?.url ?? b.url]))
  bot.api.config.use(async (_prev, method, payload: any) => {
    calls.push({ method, payload })
    let result: unknown = true
    if (method === 'sendMessage') {
      const id = ++nextId
      messages.set(id, { chatId: payload.chat_id, text: payload.text, buttons: keyboard(payload.reply_markup) })
      result = { message_id: id, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text }
    } else if (method === 'editMessageText') {
      const m = messages.get(payload.message_id)
      if (m) messages.set(payload.message_id, { ...m, text: payload.text, buttons: keyboard(payload.reply_markup) })
    } else if (method === 'editMessageReplyMarkup') {
      const m = messages.get(payload.message_id)
      if (m) messages.set(payload.message_id, { ...m, buttons: keyboard(payload.reply_markup) })
    } else if (method === 'getFile') {
      result = { file_id: payload.file_id, file_unique_id: `u${payload.file_id}`, file_size: files.get(`photos/${payload.file_id}.jpg`)?.byteLength, file_path: `photos/${payload.file_id}.jpg` }
    }
    return { ok: true, result } as any
  })
  let updateId = 0
  // Telegram sends the same first name (and @username) with every update from a user.
  const names = new Map<number, string>()
  const usernames = new Map<number, string>()
  const profile = (id: number, p: { name?: string; username?: string }) => {
    if (p.name) names.set(id, p.name)
    if (p.username) usernames.set(id, p.username)
  }
  const sentIds = () => calls.filter((c) => c.method === 'sendMessage').length
  const lastId = () => [...messages.keys()].at(-1)
  const deliver = async (update: object) => {
    await bot.handleUpdate({ update_id: ++updateId, ...update } as any)
    await queue.idle()
  }
  const from = (id: number, name = names.get(id) ?? `user${id}`) => {
    names.set(id, name)
    const username = usernames.get(id)
    return { id, is_bot: false, first_name: name, ...(username ? { username } : {}) }
  }
  const base = (id: number, name?: string) => ({ message_id: ++updateId, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private', first_name: name ?? names.get(id) ?? `user${id}` }, from: from(id, name) })

  // Sends a text message; returns the text of the last message the bot sent (or edited) in reply.
  const message = async (id: number, text: string, name?: string) => {
    const before = sentIds()
    const command = text.split(' ')[0]!
    await deliver({ message: { ...base(id, name), text, entities: command.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: command.length }] : [] } })
    return sentIds() > before ? messages.get(lastId()!)?.text : undefined
  }
  // A photo in the given sizes (file ids), smallest first, as Telegram sends them.
  const photo = async (id: number, sizes: { fileId: string; width: number; size?: number }[], caption?: string) => {
    await deliver({ message: { ...base(id), ...(caption ? { caption } : {}), photo: sizes.map((s) => ({ file_id: s.fileId, file_unique_id: `u${s.fileId}`, width: s.width, height: s.width, file_size: s.size })) } })
    return messages.get(lastId()!)?.text
  }
  const document = async (id: number, doc: { fileId: string; mime: string; size?: number }) => {
    await deliver({ message: { ...base(id), document: { file_id: doc.fileId, file_unique_id: `u${doc.fileId}`, mime_type: doc.mime, file_size: doc.size } } })
    return messages.get(lastId()!)?.text
  }
  // The buttons under a message (default: the last one the bot sent).
  const buttons = (messageId = lastId()): [string, string][] => (messageId ? messages.get(messageId)?.buttons.flat() ?? [] : [])
  const data = (label: string | RegExp, messageId = lastId()) => {
    const b = buttons(messageId).find(([l]) => (typeof label === 'string' ? l === label : label.test(l)))
    if (!b) throw new Error(`no button ${label} under message ${messageId}: ${JSON.stringify(buttons(messageId))}`)
    return b[1]
  }
  // Presses a button on a message; returns what the bot did: the message's new
  // text (if edited) and the popup on the button.
  const press = async (id: number, callbackData: string, messageId = lastId() ?? 1, chat = id) => {
    const before = calls.length
    const shown = messages.get(messageId)
    await deliver({
      callback_query: {
        id: `cq${updateId}`, data: callbackData, chat_instance: 'ci', from: from(id),
        message: { message_id: messageId, date: 0, chat: { id: chat, type: 'private' }, text: shown?.text ?? '' },
      },
    })
    const made = calls.slice(before)
    return {
      edited: made.filter((c) => c.method === 'editMessageText').at(-1)?.payload.text as string | undefined,
      answered: made.some((c) => c.method === 'answerCallbackQuery'),
      popup: made.find((c) => c.method === 'answerCallbackQuery')?.payload.text as string | undefined,
    }
  }
  // The messages the bot sent to one chat, oldest first, with their ids.
  const sentTo = (chatId: number) => [...messages].filter(([, m]) => m.chatId === chatId).map(([id, m]) => ({ id, ...m }))
  return { bot, queue, calls, messages, message, photo, document, buttons, data, press, profile, sentTo, last: () => messages.get(lastId()!) }
}
