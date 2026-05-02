import './env.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const API_BASE = process.env.WA_BRIDGE_URL ?? 'http://127.0.0.1:8080'
const TOKEN = process.env.API_TOKEN

if (!TOKEN) {
  process.stderr.write('API_TOKEN not set — start the wa-bridge daemon first\n')
  process.exit(1)
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    throw new Error(`wa-bridge API ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

const server = new Server(
  { name: 'wa-bridge', version: '0.5.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description:
        'List paired WhatsApp sessions (e.g. "main", "personal"). Use this to discover which numbers are available before reading or sending.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_conversations',
      description:
        'List recent conversations for a WhatsApp session, sorted by most recent message first. Each entry includes chat_jid, push_name, last message body and timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            description: 'Session name. Default: "main".',
          },
          limit: {
            type: 'integer',
            description: 'Max conversations to return. Default 100, max 500.',
          },
        },
      },
    },
    {
      name: 'read_conversation',
      description:
        'Read message history for one conversation. Returns most-recent messages first. Paginate older messages with the "before" param (unix ms).',
      inputSchema: {
        type: 'object',
        properties: {
          jid: {
            type: 'string',
            description:
              'Chat JID. Either "<digits>@s.whatsapp.net" (1-on-1 by phone) or "<id>@lid" (LID-addressed user) or "<id>@g.us" (group).',
          },
          session: { type: 'string', description: 'Session name. Default: "main".' },
          limit: {
            type: 'integer',
            description: 'Max messages. Default 50, max 500.',
          },
          before: {
            type: 'integer',
            description:
              'Unix ms timestamp. Only return messages older than this — used for paging back through history.',
          },
        },
        required: ['jid'],
      },
    },
    {
      name: 'send_message',
      description:
        'Send a text WhatsApp message from a session. Returns the WA message id and timestamp on success. Confirm with the user before sending unless they have already authorized this specific send.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient. Either a phone number in international format (digits only, no "+") which will be normalized to "<digits>@s.whatsapp.net", or a full JID ending in @s.whatsapp.net / @lid / @g.us.',
          },
          text: { type: 'string', description: 'Message body.' },
          session: {
            type: 'string',
            description: 'Session name to send from. Default: "main".',
          },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'list_aliases',
      description:
        'List all JID aliases for a session. Each entry maps an alias JID (typically @lid) to a canonical JID (typically @s.whatsapp.net), so the same person shows up as one conversation regardless of which form WhatsApp used.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
      },
    },
    {
      name: 'merge_jids',
      description:
        'Mark two JIDs as the same person. After merging, list_conversations collapses them and read_conversation returns combined history regardless of which JID is queried. Pass the @lid form as alias and the @s.whatsapp.net form as canonical, so phone-number metadata is preserved.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: {
            type: 'string',
            description: 'The JID to map FROM (typically the @lid form).',
          },
          canonical: {
            type: 'string',
            description: 'The JID to map TO (typically the @s.whatsapp.net form, which exposes the phone number).',
          },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['alias', 'canonical'],
      },
    },
    {
      name: 'unmerge_jid',
      description: 'Remove a previously-set alias mapping for a JID.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'The alias JID to unmap.' },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['alias'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params
  const args = (rawArgs ?? {}) as Record<string, unknown>
  const session = (args.session as string | undefined) ?? 'main'

  try {
    if (name === 'list_sessions') {
      const data = await api<{ sessions: string[] }>('/v1/health')
      return {
        content: [{ type: 'text', text: JSON.stringify(data.sessions, null, 2) }],
      }
    }

    if (name === 'list_conversations') {
      const limit = Math.min(Number(args.limit ?? 100), 500)
      const data = await api<{ conversations: unknown[] }>(
        `/v1/conversations?session=${encodeURIComponent(session)}&limit=${limit}`,
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(data.conversations, null, 2) }],
      }
    }

    if (name === 'read_conversation') {
      const jid = String(args.jid ?? '')
      if (!jid) throw new Error('jid is required')
      const limit = Math.min(Number(args.limit ?? 50), 500)
      const params = new URLSearchParams({
        session,
        jid,
        limit: String(limit),
      })
      if (args.before) params.set('before', String(args.before))
      const data = await api<{ messages: unknown[] }>(`/v1/messages?${params}`)
      return {
        content: [{ type: 'text', text: JSON.stringify(data.messages, null, 2) }],
      }
    }

    if (name === 'send_message') {
      const to = String(args.to ?? '')
      const text = String(args.text ?? '')
      if (!to || !text) throw new Error('to and text are required')
      const data = await api<unknown>('/v1/send', {
        method: 'POST',
        body: JSON.stringify({ session, to, text }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'list_aliases') {
      const data = await api<{ aliases: unknown }>(
        `/v1/aliases?session=${encodeURIComponent(session)}`,
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(data.aliases, null, 2) }],
      }
    }

    if (name === 'merge_jids') {
      const alias = String(args.alias ?? '')
      const canonical = String(args.canonical ?? '')
      if (!alias || !canonical) throw new Error('alias and canonical are required')
      const data = await api<unknown>('/v1/aliases', {
        method: 'POST',
        body: JSON.stringify({ session, alias, canonical }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'unmerge_jid') {
      const alias = String(args.alias ?? '')
      if (!alias) throw new Error('alias is required')
      const data = await api<unknown>('/v1/aliases', {
        method: 'DELETE',
        body: JSON.stringify({ session, alias }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `error: ${(err as Error).message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('[mcp] wa-bridge MCP server listening on stdio\n')
