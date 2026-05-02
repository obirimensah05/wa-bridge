import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

import {
  upsertContact,
  insertMessage,
  upsertChatsBatch,
  type Direction,
  type MessageInput,
  type ChatInput,
} from './db.js'
import { dispatchInbound } from './webhook.js'

export function scanRegisteredSessions(authDir = './auth'): string[] {
  if (!existsSync(authDir)) return []
  const names: string[] = []
  for (const entry of readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const credsPath = `${authDir}/${entry.name}/creds.json`
    if (!existsSync(credsPath)) continue
    try {
      const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
      if (creds?.registered === true || creds?.me?.id) names.push(entry.name)
    } catch {
      /* skip unreadable */
    }
  }
  return names.sort()
}

const log = pino({ level: 'info' }).child({ mod: 'wa' })

function getType(message: any): string {
  if (!message) return 'unknown'
  if (message.conversation || message.extendedTextMessage) return 'text'
  if (message.imageMessage) return 'image'
  if (message.videoMessage) return 'video'
  if (message.audioMessage) return 'audio'
  if (message.documentMessage) return 'document'
  if (message.stickerMessage) return 'sticker'
  if (message.contactMessage) return 'contact'
  if (message.locationMessage) return 'location'
  if (message.reactionMessage) return 'reaction'
  if (message.protocolMessage) return 'protocol'
  return 'unknown'
}

function getBody(message: any): string | null {
  if (!message) return null
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.reactionMessage?.text ??
    null
  )
}

function extractTs(raw: unknown): number {
  if (raw && typeof raw === 'object' && 'toNumber' in raw && typeof (raw as any).toNumber === 'function') {
    return (raw as any).toNumber() * 1000
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now()
}

function toMessageRow(msg: any, session: string, ourJid: string | undefined): MessageInput | null {
  const id = msg?.key?.id
  const remoteJid = msg?.key?.remoteJid
  if (!id || !remoteJid) return null

  const type = getType(msg.message)
  if (type === 'protocol' || type === 'unknown') return null

  const isGroup = remoteJid.endsWith('@g.us')
  const direction: Direction = msg.key.fromMe ? 'out' : 'in'
  const fromJid = msg.key.fromMe
    ? (ourJid ?? remoteJid)
    : (isGroup ? (msg.key.participant ?? remoteJid) : remoteJid)

  return {
    id: `${session}:${id}`,
    session,
    chat_jid: remoteJid,
    from_jid: fromJid,
    direction,
    type,
    body: getBody(msg.message),
    media_path: null,
    ts: Math.floor(extractTs(msg.messageTimestamp)),
    raw_json: JSON.stringify(msg),
  }
}

export function normalizeJid(to: string): string {
  if (to.includes('@')) return to
  const digits = to.replace(/[^0-9]/g, '')
  return `${digits}@s.whatsapp.net`
}

class WaManager {
  private sessions = new Map<string, WASocket>()

  async start(name: string, pairingNumber?: string): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth/${name}`)
    const { version } = await fetchLatestBaileysVersion()
    const usePairingCode = !!pairingNumber

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: usePairingCode ? Browsers.macOS('Safari') : Browsers.macOS('Desktop'),
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
    })

    this.sessions.set(name, sock)

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr && !usePairingCode) {
        log.info({ session: name }, 'scan this QR with WhatsApp on your phone')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        log.info({ session: name, jid: sock.user?.id }, 'connected')
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        log.warn({ session: name, code, loggedOut }, 'connection closed')
        this.sessions.delete(name)
        if (!loggedOut) {
          setTimeout(() => this.start(name, pairingNumber), 2_000)
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const row = toMessageRow(msg, name, sock.user?.id)
        if (!row) continue

        if (row.direction === 'in') {
          upsertContact({
            jid: row.from_jid,
            push_name: msg.pushName ?? null,
            is_lid: row.from_jid.endsWith('@lid') ? 1 : 0,
            ts: row.ts,
          })
        }

        const result = insertMessage(row)
        if (result.changes > 0) {
          log.info(
            { session: name, dir: row.direction, from: row.from_jid, type: row.type, body: row.body },
            row.direction === 'in' ? 'inbound' : 'outbound',
          )
          if (row.direction === 'in') dispatchInbound(row)
        }
      }
    })

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }) => {
      const chatRows: ChatInput[] = []
      for (const chat of chats) {
        if (!chat.id) continue
        chatRows.push({
          session: name,
          jid: chat.id,
          name: chat.name ?? null,
          is_group: chat.id.endsWith('@g.us') ? 1 : 0,
          archived: chat.archived ? 1 : 0,
          pinned: chat.pinned ? 1 : 0,
          mute_until: chat.muteEndTime ? Number(chat.muteEndTime) * 1000 : null,
          unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
          last_msg_ts: chat.conversationTimestamp
            ? Number(chat.conversationTimestamp) * 1000
            : null,
          raw_json: JSON.stringify(chat),
        })
      }
      if (chatRows.length) upsertChatsBatch(chatRows)

      for (const c of contacts) {
        if (!c.id) continue
        upsertContact({
          jid: c.id,
          push_name: c.name ?? c.notify ?? null,
          is_lid: c.id.endsWith('@lid') ? 1 : 0,
          ts: Date.now(),
        })
      }

      let inserted = 0
      for (const msg of messages) {
        const row = toMessageRow(msg, name, sock.user?.id)
        if (!row) continue
        if (row.direction === 'in') {
          upsertContact({
            jid: row.from_jid,
            push_name: msg.pushName ?? null,
            is_lid: row.from_jid.endsWith('@lid') ? 1 : 0,
            ts: row.ts,
          })
        }
        const r = insertMessage(row)
        if (r.changes > 0) inserted++
      }

      log.info(
        {
          session: name,
          chats: chats.length,
          contacts: contacts.length,
          messages: messages.length,
          inserted,
          isLatest: isLatest ?? false,
          progress: progress ?? null,
        },
        'history sync batch',
      )
    })

    sock.ev.on('chats.upsert', (newChats) => {
      const rows: ChatInput[] = []
      for (const chat of newChats) {
        if (!chat.id) continue
        rows.push({
          session: name,
          jid: chat.id,
          name: chat.name ?? null,
          is_group: chat.id.endsWith('@g.us') ? 1 : 0,
          archived: chat.archived ? 1 : 0,
          pinned: chat.pinned ? 1 : 0,
          mute_until: chat.muteEndTime ? Number(chat.muteEndTime) * 1000 : null,
          unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
          last_msg_ts: chat.conversationTimestamp
            ? Number(chat.conversationTimestamp) * 1000
            : null,
          raw_json: JSON.stringify(chat),
        })
      }
      if (rows.length) upsertChatsBatch(rows)
    })

    sock.ev.on('contacts.upsert', (newContacts) => {
      for (const c of newContacts) {
        if (!c.id) continue
        upsertContact({
          jid: c.id,
          push_name: c.name ?? c.notify ?? null,
          is_lid: c.id.endsWith('@lid') ? 1 : 0,
          ts: Date.now(),
        })
      }
    })

    if (usePairingCode && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairingNumber)
          const formatted = code.match(/.{1,4}/g)?.join('-') ?? code
          log.info({ session: name, number: pairingNumber, code: formatted }, 'pairing code ready')
        } catch (err) {
          log.error({ err }, 'failed to request pairing code')
        }
      }, 3_000)
    }
  }

  get(name: string): WASocket | undefined {
    return this.sessions.get(name)
  }

  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  async sendText(name: string, to: string, text: string): Promise<{ id: string; jid: string; ts: number }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)

    const jid = normalizeJid(to)
    const result = await sock.sendMessage(jid, { text })
    if (!result?.key?.id) throw new Error('send failed: no message id returned')

    const ts = Date.now()
    insertMessage({
      id: `${name}:${result.key.id}`,
      session: name,
      chat_jid: jid,
      from_jid: sock.user?.id ?? 'unknown',
      direction: 'out',
      type: 'text',
      body: text,
      media_path: null,
      ts,
      raw_json: JSON.stringify(result),
    })

    log.info({ session: name, to: jid, body: text }, 'sent')
    return { id: result.key.id, jid, ts }
  }
}

export const wa = new WaManager()
