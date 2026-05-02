import Fastify from 'fastify'
import pino from 'pino'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { API_TOKEN, HOST, PORT } from './env.js'
import { wa } from './wa.js'
import {
  listConversations,
  listMessages,
  upsertAlias,
  removeAlias,
  listAliases,
  pushNameFor,
  phoneFor,
} from './db.js'
import { dispatchTest } from './webhook.js'
import { WEBHOOK_URL } from './env.js'

const log = pino({ level: 'info' }).child({ mod: 'api' })

function enrichConvo(session: string, row: {
  chat_jid: string
  chat_name: string | null
  is_group: number
  archived: number
  pinned: number
  unread_count: number | null
  push_name: string | null
  last_body: string | null
  last_direction: 'in' | 'out' | null
  last_type: string | null
  last_ts: number | null
}) {
  const display = row.chat_name ?? row.push_name ?? pushNameFor(session, row.chat_jid)
  return {
    chat_jid: row.chat_jid,
    is_group: !!row.is_group,
    archived: !!row.archived,
    pinned: !!row.pinned,
    unread_count: row.unread_count ?? 0,
    display_name: display,
    phone: phoneFor(session, row.chat_jid),
    last_body: row.last_body,
    last_direction: row.last_direction,
    last_type: row.last_type,
    last_ts: row.last_ts,
  }
}

function enrichMessage(session: string, row: {
  id: string
  ts: number
  direction: 'in' | 'out'
  from_jid: string
  chat_jid: string
  type: string
  body: string | null
}) {
  return {
    ...row,
    from_display_name: pushNameFor(session, row.from_jid),
    from_phone: phoneFor(session, row.from_jid),
    chat_phone: phoneFor(session, row.chat_jid),
  }
}

export async function startApi(): Promise<void> {
  const app = Fastify({ logger: false })

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/v1/health') return
    if (req.url === '/' || req.url === '/index.html') return
    const auth = req.headers.authorization
    if (auth !== `Bearer ${API_TOKEN}`) {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  const indexHtml = readFileSync(resolve('./web/index.html'), 'utf8')
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(indexHtml)
  })

  app.get('/v1/health', async () => ({
    ok: true,
    sessions: wa.list(),
    ts: Date.now(),
  }))

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
      if (!jid) {
        reply.code(400).send({ error: 'jid query param required' })
        return
      }
      const limit = Math.min(Number(req.query.limit ?? 50), 500)
      const before = req.query.before ? Number(req.query.before) : undefined
      const rows = listMessages(session, jid, limit, before)
      return {
        session,
        jid,
        messages: rows.map((r) => enrichMessage(session, r)),
      }
    },
  )

  app.post<{ Body: { session?: string; to?: string; text?: string } }>(
    '/v1/send',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { to, text } = req.body
      if (!to || !text) {
        reply.code(400).send({ error: 'to and text are required' })
        return
      }
      try {
        const result = await wa.sendText(session, to, text)
        return { ok: true, ...result }
      } catch (err) {
        log.error({ err }, 'send failed')
        reply.code(500).send({ error: (err as Error).message })
      }
    },
  )

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
        reply.code(400).send({ error: 'alias and canonical are required' })
        return
      }
      try {
        upsertAlias(session, alias, canonical)
        return { ok: true, session, alias, canonical }
      } catch (err) {
        reply.code(400).send({ error: (err as Error).message })
      }
    },
  )

  app.delete<{ Body: { session?: string; alias?: string } }>(
    '/v1/aliases',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { alias } = req.body
      if (!alias) {
        reply.code(400).send({ error: 'alias is required' })
        return
      }
      const result = removeAlias(session, alias)
      return { ok: true, removed: result.changes }
    },
  )

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
