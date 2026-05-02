import Fastify from 'fastify'
import pino from 'pino'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { Buffer } from 'node:buffer'

import { API_TOKEN, HOST, PORT } from './env.js'
import { wa, normalizeJid } from './wa.js'
import {
  listConversations,
  listMessages,
  upsertAlias,
  removeAlias,
  listAliases,
  pushNameFor,
  phoneFor,
  reactionsFor,
  db,
} from './db.js'
import { dispatchTest } from './webhook.js'
import { WEBHOOK_URL } from './env.js'

const log = pino({ level: 'info' }).child({ mod: 'api' })

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf',
}

function mediaUrl(mediaPath: string | null): string | null {
  if (!mediaPath) return null
  const m = mediaPath.match(/data\/media\/([^/]+)\/(.+)$/)
  if (!m) return null
  return `/v1/media/${m[1]}/${m[2]}`
}

function lookupBody(session: string, fullId: string): string | null {
  const row = db
    .prepare(`SELECT body, type FROM messages WHERE id = ? AND session = ?`)
    .get(fullId, session) as { body: string | null; type: string } | undefined
  if (!row) return null
  return row.body ?? `[${row.type}]`
}

function enrichConvo(session: string, row: any) {
  const display = row.chat_name ?? row.push_name ?? pushNameFor(session, row.chat_jid)
  return {
    chat_jid: row.chat_jid,
    is_group: !!row.is_group,
    archived: !!row.archived,
    pinned: !!row.pinned,
    unread_count: row.unread_count ?? 0,
    display_name: display,
    phone: phoneFor(session, row.chat_jid),
    profile_pic_url: row.profile_pic_url ?? null,
    last_body: row.last_body,
    last_direction: row.last_direction,
    last_type: row.last_type,
    last_ts: row.last_ts,
  }
}

function shortJid(jid: string): string {
  // "94279548584018@lid" -> "~94279548584018"
  // "12025550100:34@s.whatsapp.net" -> "+12025550100"
  const local = jid.split('@')[0].split(':')[0]
  if (jid.endsWith('@s.whatsapp.net') && /^\d+$/.test(local)) return `+${local}`
  if (jid.endsWith('@g.us')) return 'group'
  return `~${local.slice(0, 12)}`
}

function enrichMessage(session: string, row: any) {
  const from_display_name = pushNameFor(session, row.from_jid)
  const from_phone = phoneFor(session, row.from_jid)
  const reactions = reactionsFor(session, row.id).map((r) => ({
    from_jid: r.from_jid,
    from_display_name: pushNameFor(session, r.from_jid),
    from_phone: phoneFor(session, r.from_jid),
    emoji: r.emoji,
    ts: r.ts,
  }))
  const quoted = row.quoted_id ? { id: row.quoted_id, body_preview: lookupBody(session, row.quoted_id) } : null
  return {
    ...row,
    from_display_name,
    from_phone,
    from_label: from_display_name ?? from_phone ?? shortJid(row.from_jid),
    chat_phone: phoneFor(session, row.chat_jid),
    media_url: mediaUrl(row.media_path),
    reactions,
    quoted,
  }
}

// Simple in-memory idempotency cache for POST /v1/send
const idempotencyCache = new Map<string, { ts: number; payload: unknown }>()
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
function gcIdempotency() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS
  for (const [k, v] of idempotencyCache) if (v.ts < cutoff) idempotencyCache.delete(k)
}
setInterval(gcIdempotency, 60_000).unref()

async function fetchToBuffer(url: string): Promise<{ buf: Buffer; mime: string | null }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`)
  const arr = new Uint8Array(await res.arrayBuffer())
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null
  return { buf: Buffer.from(arr), mime }
}

export async function startApi(): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 })

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (path === '/v1/health' || path === '/' || path === '/index.html') return

    const headerAuth = req.headers.authorization
    const queryAuth = (req.query as any)?.token
    const provided =
      headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : (queryAuth ?? '')

    if (provided !== API_TOKEN) {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  // ---- static ----
  const indexHtml = readFileSync(resolve('./web/index.html'), 'utf8')
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(indexHtml)
  })

  app.get<{ Params: { session: string; file: string } }>(
    '/v1/media/:session/:file',
    async (req, reply) => {
      const { session, file } = req.params
      if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
        reply.code(400).send({ error: 'bad session' }); return
      }
      const safeFile = basename(file)
      if (safeFile !== file) {
        reply.code(400).send({ error: 'bad path' }); return
      }
      const path = resolve(`./data/media/${session}/${safeFile}`)
      const root = resolve('./data/media/')
      if (!path.startsWith(root)) { reply.code(403).send({ error: 'forbidden' }); return }
      if (!existsSync(path)) { reply.code(404).send({ error: 'not found' }); return }
      const ext = safeFile.split('.').pop()?.toLowerCase() ?? ''
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
      reply.type(mime).send(readFileSync(path))
    },
  )

  // ---- system ----
  app.get('/v1/health', async () => ({
    ok: true,
    sessions: wa.list(),
    ts: Date.now(),
  }))

  // ---- conversations / messages ----
  app.get<{ Querystring: { session?: string; limit?: string } }>(
    '/v1/conversations',
    async (req) => {
      const session = req.query.session ?? 'main'
      const limit = Math.min(Number(req.query.limit ?? 100), 500)
      const rows = listConversations(session, limit)
      return { session, conversations: rows.map((r) => enrichConvo(session, r)) }
    },
  )

  app.get<{ Querystring: { session?: string; jid?: string; limit?: string; before?: string } }>(
    '/v1/messages',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const jid = req.query.jid
      if (!jid) { reply.code(400).send({ error: 'jid query param required' }); return }
      const limit = Math.min(Number(req.query.limit ?? 50), 500)
      const before = req.query.before ? Number(req.query.before) : undefined
      const rows = listMessages(session, jid, limit, before)
      return { session, jid, messages: rows.map((r) => enrichMessage(session, r)) }
    },
  )

  // ---- send (text or media) ----
  app.post<{
    Body: {
      session?: string
      to?: string
      text?: string
      media_url?: string
      media_base64?: string
      media_kind?: 'image' | 'video' | 'audio' | 'document'
      mime?: string
      filename?: string
      caption?: string
      quoted_id?: string
      sent_by?: 'user' | 'agent' | 'api'
    }
  }>(
    '/v1/send',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const to = req.body.to
      if (!to) { reply.code(400).send({ error: '"to" is required' }); return }

      const idemKey = req.headers['idempotency-key'] as string | undefined
      if (idemKey) {
        const cached = idempotencyCache.get(idemKey)
        if (cached) return cached.payload
      }

      try {
        let result: { id: string; jid: string; ts: number }
        const { text, caption, quoted_id, sent_by, media_url, media_base64, media_kind, mime, filename } = req.body

        if (text && !media_url && !media_base64) {
          result = await wa.sendText(session, to, text, { quoted_id, sent_by })
        } else if (media_url || media_base64) {
          if (!media_kind) { reply.code(400).send({ error: 'media_kind required when sending media' }); return }
          let buf: Buffer
          let detectedMime: string | null = mime ?? null
          if (media_url) {
            const fetched = await fetchToBuffer(media_url)
            buf = fetched.buf
            detectedMime = detectedMime ?? fetched.mime
          } else {
            buf = Buffer.from(media_base64!, 'base64')
          }
          result = await wa.sendMedia(
            session,
            to,
            { kind: media_kind, data: buf, mime: detectedMime ?? undefined, filename },
            { caption, quoted_id, sent_by },
          )
        } else {
          reply.code(400).send({ error: 'either "text" or media_url/media_base64 (with media_kind) required' })
          return
        }

        const payload = { ok: true, ...result }
        if (idemKey) idempotencyCache.set(idemKey, { ts: Date.now(), payload })
        return payload
      } catch (err) {
        log.error({ err: (err as Error).message }, 'send failed')
        reply.code(500).send({ error: (err as Error).message })
      }
    },
  )

  // ---- reactions / delete / typing / read / check ----
  app.post<{ Body: { session?: string; chat_jid?: string; message_id?: string; emoji?: string } }>(
    '/v1/react',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { chat_jid, message_id, emoji = '' } = req.body
      if (!chat_jid || !message_id) {
        reply.code(400).send({ error: 'chat_jid and message_id required' }); return
      }
      try {
        await wa.sendReaction(session, message_id, chat_jid, emoji)
        return { ok: true }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.delete<{ Body: { session?: string; chat_jid?: string; message_id?: string; from_me?: boolean; participant?: string } }>(
    '/v1/messages',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { chat_jid, message_id, from_me = true, participant } = req.body
      if (!chat_jid || !message_id) {
        reply.code(400).send({ error: 'chat_jid and message_id required' }); return
      }
      try {
        await wa.deleteMessage(session, message_id, chat_jid, from_me, participant)
        return { ok: true }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.post<{ Body: { session?: string; jid?: string; state?: 'composing' | 'paused' | 'recording' | 'available' | 'unavailable' } }>(
    '/v1/typing',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { jid, state = 'composing' } = req.body
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try {
        await wa.sendPresence(session, jid, state)
        return { ok: true, state }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.post<{ Body: { session?: string; jid?: string; message_ids?: string[] } }>(
    '/v1/read',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { jid, message_ids } = req.body
      if (!jid || !message_ids?.length) {
        reply.code(400).send({ error: 'jid and message_ids[] required' }); return
      }
      try {
        await wa.markRead(session, jid, message_ids)
        return { ok: true, marked: message_ids.length }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.get<{ Querystring: { session?: string; phone?: string } }>(
    '/v1/check',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const phone = req.query.phone
      if (!phone) { reply.code(400).send({ error: 'phone query param required' }); return }
      try {
        const r = await wa.checkOnWhatsApp(session, phone)
        return { phone, ...r }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  // ---- group operations ----
  app.get<{ Querystring: { session?: string; jid?: string } }>(
    '/v1/groups/info',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const jid = req.query.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try { return await wa.groupInfo(session, jid) }
      catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.get<{ Querystring: { session?: string; jid?: string } }>(
    '/v1/groups/invite',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const jid = req.query.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try { return { invite_url: await wa.groupInviteLink(session, jid) } }
      catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.post<{ Body: { session?: string; jid?: string } }>(
    '/v1/groups/leave',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const jid = req.body.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try { await wa.groupLeave(session, jid); return { ok: true } }
      catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.post<{ Body: { session?: string; jid?: string; participants?: string[]; action?: 'add' | 'remove' | 'promote' | 'demote' } }>(
    '/v1/groups/participants',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { jid, participants, action } = req.body
      if (!jid || !participants?.length || !action) {
        reply.code(400).send({ error: 'jid, participants[], action required' }); return
      }
      try {
        const normalized = participants.map((p) => normalizeJid(p))
        return { results: await wa.groupParticipants(session, jid, normalized, action) }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  app.post<{ Body: { session?: string; jid?: string } }>(
    '/v1/profile_pic/refresh',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const jid = req.body.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try {
        const url = await wa.fetchProfilePicture(session, jid)
        return { jid, profile_pic_url: url }
      } catch (err) { reply.code(500).send({ error: (err as Error).message }) }
    },
  )

  // ---- aliases ----
  app.get<{ Querystring: { session?: string } }>(
    '/v1/aliases',
    async (req) => {
      const session = req.query.session ?? 'main'
      return { session, aliases: listAliases(session) }
    },
  )

  app.post<{ Body: { session?: string; alias?: string; canonical?: string } }>(
    '/v1/aliases',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { alias, canonical } = req.body
      if (!alias || !canonical) {
        reply.code(400).send({ error: 'alias and canonical are required' }); return
      }
      try {
        upsertAlias(session, alias, canonical)
        return { ok: true, session, alias, canonical }
      } catch (err) { reply.code(400).send({ error: (err as Error).message }) }
    },
  )

  app.delete<{ Body: { session?: string; alias?: string } }>(
    '/v1/aliases',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { alias } = req.body
      if (!alias) { reply.code(400).send({ error: 'alias is required' }); return }
      const result = removeAlias(session, alias)
      return { ok: true, removed: result.changes }
    },
  )

  // ---- webhook test ----
  app.post('/v1/webhook/test', async () => {
    const result = await dispatchTest()
    return { configured_url: WEBHOOK_URL, ...result }
  })

  await app.listen({ host: HOST, port: PORT })
  log.info(
    { host: HOST, port: PORT, webhook: WEBHOOK_URL ?? 'disabled' },
    `API listening — token in .env`,
  )
}
