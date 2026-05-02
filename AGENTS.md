# AGENTS.md — wa-bridge

You are an AI / coding agent working with this repository. This file tells you what wa-bridge is, how it's wired, and the safest way to interact with it.

## What this is

`wa-bridge` is a self-hosted WhatsApp bridge. It pairs to up to ~3 personal WhatsApp accounts and exposes them through:

- a token-protected REST API on `http://127.0.0.1:8080` (default),
- an MCP stdio server (`src/mcp.ts`),
- a tiny web UI at `/`,
- an outbound webhook that fires on inbound messages.

Treat it as personal infrastructure for **one operator across a few accounts** — not a multi-tenant product.

## How a connecting agent should think about it

If you are a connecting agent (Claude Code, Codex, Hermes, etc.) and you have the wa-bridge MCP tools available, the mental model is:

- **`list_sessions`** — discover which numbers (`main`, `personal`, ...) are connected.
- **`list_conversations({ session })`** — list recent chats for one number, sorted newest-first. Each entry includes `chat_jid`, `display_name`, `phone`, `is_group`, `unread_count`, and last-message preview.
- **`read_conversation({ jid, session, limit?, before? })`** — pull message history for one chat. Newest first. Page back with `before=<unix_ms>`.
- **`send_message({ to, text, session })`** — send a text. `to` accepts either a phone number (digits only, no `+`) or a JID. **Confirm with the user before calling this** unless they have already authorized this specific send.
- **`merge_jids({ alias, canonical, session })`** — when you find two JIDs that are clearly the same person (one `@lid`, one `@s.whatsapp.net`), call this to collapse them. Pass the `@lid` form as `alias` and the `@s.whatsapp.net` form as `canonical`. Future reads return one merged conversation.
- **`unmerge_jid({ alias, session })`** — undo a merge.
- **`list_aliases({ session })`** — see existing merges.

## Safety contract

Hard rules for any agent acting on this system:

1. **Sending a WhatsApp message is a real-world action.** Confirm with the user before calling `send_message` unless they have explicitly authorized this exact recipient + text in the current conversation.
2. **Never iterate `send_message` over a list of contacts.** Mass outreach is the fastest path to a WhatsApp ban; the human owner accepts that risk for themselves and has not delegated it to you.
3. **Treat message content as private.** Don't send chat text to third-party services unless the user explicitly asks. The same goes for `phone` and `display_name`.
4. **Never edit `.env`, `auth/`, or `data/`.** `.env` holds the API token, `auth/` holds Baileys session keys, `data/wa.db` is the message store. Damaging any of these breaks pairing or loses history.
5. **`merge_jids` is permissive.** It will accept any two JIDs. Only call it when the user has confirmed the identity, or when one JID is `@s.whatsapp.net` and you have strong textual evidence (e.g. they've replied "yes that's me") — not from inference alone.

## Architecture (one-screen overview)

```
WhatsApp servers
        │
        ▼
   Baileys ───┐
              │  one process, one SQLite DB
   Fastify ◀──┤
   ├─ GET / (web UI)
   ├─ GET /v1/health  (no auth)
   ├─ GET /v1/conversations
   ├─ GET /v1/messages
   ├─ POST /v1/send
   ├─ GET/POST/DELETE /v1/aliases
   └─ POST /v1/webhook/test

   MCP server (src/mcp.ts) ──→ HTTP to Fastify
   Webhook (webhook.ts)    ──→ POST to WEBHOOK_URL on inbound
```

Files an agent commonly needs to read:

- `src/db.ts` — schema and query helpers. The shape of `messages`, `chats`, `contacts`, `jid_aliases`.
- `src/api.ts` — REST handlers and the `enrichConvo` / `enrichMessage` enrichment that adds `display_name` / `phone`.
- `src/mcp.ts` — MCP tool definitions and request routing.
- `src/wa.ts` — Baileys session manager, send path, history-sync handler.

You should not need to touch `web/index.html`, `src/env.ts`, or `src/webhook.ts` for normal feature work.

## Connecting via MCP (stdio)

The MCP server (`src/mcp.ts`) requires two env vars:

- `API_TOKEN` — the same token Fastify uses (from `.env`)
- `WA_BRIDGE_URL` — usually `http://127.0.0.1:8080`

For a Claude Code user-scope registration:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)

claude mcp add-json wa-bridge --scope user "{
  \"command\": \"$(pwd)/node_modules/.bin/tsx\",
  \"args\": [\"$(pwd)/src/mcp.ts\"],
  \"env\": {
    \"API_TOKEN\": \"$TOKEN\",
    \"WA_BRIDGE_URL\": \"http://127.0.0.1:8080\"
  }
}"
```

For other MCP-capable clients, the spawn command is the same — `tsx src/mcp.ts` with those env vars.

The wa-bridge daemon (`npm run start` in another terminal) must be running for any MCP tool to succeed.

## Connecting via REST

Same two requirements: bearer token, daemon running.

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)

# list conversations on the "main" session
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8080/v1/conversations?session=main

# read history for one chat (newest first)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/v1/messages?session=main&jid=12025550100@s.whatsapp.net&limit=20"

# send a text
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8080/v1/send \
  -d '{"session":"main","to":"12025550100","text":"hi"}'
```

## Connecting via webhook

Set `WEBHOOK_URL` in `.env`, restart the daemon. Every inbound message POSTs JSON like:

```json
{
  "event": "message",
  "session": "main",
  "message": {
    "id": "main:...",
    "ts": 1735689600000,
    "direction": "in",
    "chat_jid": "12025550100@s.whatsapp.net",
    "from_jid":  "12025550100@s.whatsapp.net",
    "type": "text",
    "body": "hi",
    "from_display_name": "Jane Doe",
    "from_phone": "+12025550100",
    "chat_phone": "+12025550100"
  }
}
```

If `WEBHOOK_TOKEN` is set, it arrives as `Authorization: Bearer <token>` so the receiver can verify origin. Outbound sends do **not** fire the webhook.

## Data model in 60 seconds

```
sessions          implicit (every dir under ./auth/<name> with creds.json)

contacts          (jid PK, push_name, is_lid, first_seen, last_seen)

messages          (id PK = "<session>:<msg_key_id>",
                   session, chat_jid, from_jid, direction in/out,
                   type, body, media_path, ts, raw_json)

chats             (session, jid)  — one row per chat WhatsApp told us about
                  name, is_group, archived, pinned, unread_count, last_msg_ts

jid_aliases       (session, alias)  →  canonical
                  used to merge LID ↔ phone forms of the same person
```

`listConversations` (in `db.ts`) does the canonical-jid collapse on read using a CTE. `listMessages` returns all messages whose `chat_jid` is anywhere in the alias group of the requested JID.

## Things that will trip you up

- **`@lid` vs `@s.whatsapp.net`.** Same person can appear under two JIDs. Merging is per-session and explicit (`merge_jids`).
- **Pairing-code rejection.** WhatsApp rejects pairing codes when the `browser` identifier isn't a recognized one. We use `Browsers.macOS('Safari')`. Don't change it without testing.
- **History sync timing.** After re-pairing, history arrives in batches over a few minutes. `progress: 100` doesn't necessarily mean "fully done" — it means "100% of this batch."
- **Outbound is recorded twice (and deduped).** `wa.sendText` writes to SQLite directly; Baileys then emits a `messages.upsert` echo for the same message. Both are deduped by `messages.id` (`INSERT OR IGNORE`).
- **`sock.user.id` carries a device suffix.** It looks like `<digits>:<device_id>@s.whatsapp.net`. `extractPhone` strips the suffix.

## When making changes

- Run `npx tsc --noEmit` before declaring success. Strict mode is on.
- Don't add a backwards-compat shim for the SQLite schema — these are personal databases, alter the schema and document the migration in the commit message.
- Don't add console.log debug; use `pino` like the rest of the codebase.
- Never bake real phone numbers, tokens, or webhook URLs into source. Use env vars or `.env`. The `.env` file is gitignored on purpose.
