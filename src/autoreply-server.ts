import { timingSafeEqual } from 'node:crypto'

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'

import { AUTOREPLY_HOST, AUTOREPLY_PORT, AUTOREPLY_TOKEN } from './autoreply-env.js'
import { generateDraftReply } from './autoreply-generate.js'
import { sendDraftNotification } from './autoreply-notify.js'
import { evaluateAutoSendSafety } from './autoreply-safety.js'
import {
  appendAudit,
  appendDraft,
  evaluatePolicy,
  getDefaultPolicy,
  readPolicy,
  writePolicy,
  type AutoReplyPolicy,
} from './autoreply-store.js'
import { resolvePreferredChatLabel, sendTextReply, waitForInboundMessageContext } from './autoreply-wa.js'

const app = Fastify({ logger: false })

const webhookMessageSchema = z.object({
  id: z.string().optional(),
  ts: z.number().optional(),
  direction: z.string().optional(),
  chat_jid: z.string().optional(),
  from_jid: z.string().optional(),
  type: z.string().optional(),
  body: z.string().nullable().optional(),
  from_display_name: z.string().nullable().optional(),
  from_phone: z.string().nullable().optional(),
  chat_phone: z.string().nullable().optional(),
}).passthrough()

const webhookSchema = z.object({
  event: z.string().default('message'),
  session: z.string().optional(),
  message: z.union([webhookMessageSchema, z.string()]).optional(),
}).passthrough()

const activeHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1),
})

const updatePolicySchema = z.object({
  mode: z.enum(['draft', 'auto', 'off']).default('draft'),
  scope: z.enum(['all', 'contacts', 'groups', 'mixed']).default('all'),
  contacts: z.array(z.string()).default([]),
  groups: z.array(z.string()).default([]),
  active_until: z.string().datetime({ offset: true }).nullable().optional(),
  active_hours: activeHoursSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
})

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!AUTOREPLY_TOKEN) {
    reply.code(500).send({ error: 'AUTOREPLY_TOKEN not configured' })
    return false
  }
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : ''
  const given = Buffer.from(bearer, 'utf8')
  const expected = Buffer.from(AUTOREPLY_TOKEN, 'utf8')
  const ok = given.length === expected.length && timingSafeEqual(given, expected)
  if (!ok) {
    reply.code(401).send({ error: 'unauthorized' })
    return false
  }
  return true
}

app.get('/health', async () => ({
  ok: true,
  service: 'wa-autoreply',
  policy: readPolicy(),
  default_policy: getDefaultPolicy(),
  ts: Date.now(),
}))

app.get('/policy', async (req, reply) => {
  if (!authorized(req, reply)) return
  const policy = readPolicy()
  appendAudit('policy_read', { ip: req.ip })
  return policy
})

app.put('/policy', async (req, reply) => {
  if (!authorized(req, reply)) return
  const parsed = updatePolicySchema.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'validation', issues: parsed.error.issues })
    return
  }
  const previous = readPolicy()
  const nextInput: Omit<AutoReplyPolicy, 'updated_at'> = {
    mode: parsed.data.mode,
    scope: parsed.data.scope,
    contacts: parsed.data.contacts,
    groups: parsed.data.groups,
    active_until: parsed.data.active_until ?? null,
    active_hours: parsed.data.active_hours ? {
      start: parsed.data.active_hours.start,
      end: parsed.data.active_hours.end,
      timezone: parsed.data.active_hours.timezone,
    } : null,
    notes: parsed.data.notes ?? null,
  }
  const next = writePolicy(nextInput)
  appendAudit('policy_updated', { ip: req.ip, previous, next })
  return next
})

app.post('/webhook', async (req, reply) => {
  if (!authorized(req, reply)) return
  const parsed = webhookSchema.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'validation', issues: parsed.error.issues })
    return
  }

  const payload = parsed.data
  const message = typeof payload.message === 'string' ? null : payload.message
  const isTestEvent = payload.event === 'test'
  const isGroup = typeof message?.chat_jid === 'string' ? message.chat_jid.endsWith('@g.us') : false
  const policy = readPolicy()
  const decision = evaluatePolicy(policy, {
    chat_jid: message?.chat_jid,
    is_group: isGroup,
  })

  const enrichedMessage = decision.active && message?.chat_jid && message?.id && message?.direction !== 'out'
    ? await waitForInboundMessageContext({
        jid: message.chat_jid,
        messageId: message.id,
        session: payload.session,
        desiredType: message.type ?? null,
      }).catch((error: unknown) => {
        appendAudit('webhook_enrichment_failed', {
          message_id: message.id,
          chat_jid: message.chat_jid,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      })
    : null

  appendAudit('webhook_received', {
    ip: req.ip,
    event: payload.event,
    session: payload.session ?? null,
    message_id: message?.id ?? null,
    chat_jid: message?.chat_jid ?? null,
    from_jid: message?.from_jid ?? null,
    type: message?.type ?? null,
    direction: message?.direction ?? null,
    resolved_body: enrichedMessage?.body ?? message?.body ?? (typeof payload.message === 'string' ? payload.message : null),
    resolved_transcript: enrichedMessage?.transcript ?? null,
    decision,
  })

  if (isTestEvent) {
    return {
      ok: true,
      policy_mode: policy.mode,
      decision,
      test: true,
    }
  }

  const incomingText = (enrichedMessage?.transcript || enrichedMessage?.body || message?.body || '').trim()
  const contactLabel = message?.from_display_name?.trim()
    || message?.from_phone?.trim()
    || message?.chat_phone?.trim()
    || await resolvePreferredChatLabel(
      message?.from_jid ?? message?.chat_jid ?? null,
      payload.session ?? undefined,
    ).catch(() => null)
    || message?.chat_jid
    || 'unknown'

  if (decision.active && message?.direction !== 'out' && incomingText) {
    const draft = await generateDraftReply({
      incomingText,
      contactName: message?.from_display_name ?? null,
      isGroup,
    }).catch((error: unknown) => {
      appendAudit('safety_blocked', {
        session: payload.session ?? null,
        message_id: message?.id ?? null,
        chat_jid: message?.chat_jid ?? null,
        reason: 'draft generation failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })

    if (draft) {
      const autoSafety = decision.mode === 'auto'
        ? evaluateAutoSendSafety({
            session: payload.session ?? null,
            chatJid: message?.chat_jid ?? null,
            messageId: message?.id ?? null,
            incomingText,
            draft,
            isGroup,
          })
        : null

      appendDraft({
        source: 'webhook',
        session: payload.session ?? null,
        message_id: message?.id ?? null,
        chat_jid: message?.chat_jid ?? null,
        from_jid: message?.from_jid ?? null,
        body: enrichedMessage?.body ?? message?.body ?? null,
        transcript: enrichedMessage?.transcript ?? null,
        type: enrichedMessage?.type ?? message?.type ?? null,
        draft_reply: draft.reply,
        confidence: draft.confidence,
        should_send: draft.should_send,
        needs_review: draft.needs_review,
        reasons: draft.reasons,
      })

      if (decision.mode === 'draft') {
        await sendDraftNotification({
          kind: 'whatsapp_draft',
          session: payload.session ?? null,
          chat_jid: message?.chat_jid ?? null,
          contact_label: contactLabel,
          from_jid: message?.from_jid ?? null,
          incoming_text: incomingText,
          draft_reply: draft.reply,
          confidence: draft.confidence,
          should_send: draft.should_send,
          needs_review: draft.needs_review,
          reasons: draft.reasons,
        }).catch(() => false)
      }

      if (decision.mode === 'auto') {
        if (autoSafety?.ok) {
          const sent = await sendTextReply({
            session: payload.session ?? undefined,
            to: message?.chat_jid ?? '',
            text: draft.reply,
            quoted_id: message?.id ?? null,
          }).catch((error: unknown) => {
            appendAudit('safety_blocked', {
              session: payload.session ?? null,
              message_id: message?.id ?? null,
              chat_jid: message?.chat_jid ?? null,
              reason: 'auto send failed',
              error: error instanceof Error ? error.message : String(error),
            })
            return null
          })

          if (sent) {
            appendAudit('auto_sent', {
              session: payload.session ?? null,
              inbound_message_id: message?.id ?? null,
              outbound_message_id: sent.id,
              chat_jid: sent.jid,
              ts: sent.ts,
              reply: draft.reply,
              confidence: draft.confidence,
            })
          }
        } else {
          appendAudit('safety_blocked', {
            session: payload.session ?? null,
            message_id: message?.id ?? null,
            chat_jid: message?.chat_jid ?? null,
            reason: 'auto mode active but safety gates blocked send',
            confidence: draft.confidence,
            should_send: draft.should_send,
            needs_review: draft.needs_review,
            reasons: [...draft.reasons, ...(autoSafety?.reasons ?? [])],
          })
          await sendDraftNotification({
            kind: 'whatsapp_draft',
            session: payload.session ?? null,
            chat_jid: message?.chat_jid ?? null,
            contact_label: contactLabel,
            from_jid: message?.from_jid ?? null,
            incoming_text: incomingText,
            draft_reply: draft.reply,
            confidence: draft.confidence,
            should_send: draft.should_send,
            needs_review: true,
            reasons: [...draft.reasons, ...(autoSafety?.reasons ?? [])],
          }).catch(() => false)
        }
      }
    }
  }

  return {
    ok: true,
    policy_mode: policy.mode,
    decision,
    placeholder: true,
  }
})

export async function startAutoReplyServer(): Promise<void> {
  await app.listen({ host: AUTOREPLY_HOST, port: AUTOREPLY_PORT })
}
