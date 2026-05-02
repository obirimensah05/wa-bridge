# wa-bridge

A private, self-hosted WhatsApp bridge. Runs locally or on a small VPS, holds up to ~3 WhatsApp accounts, and exposes them through:

- a local web UI (read + send),
- a token-protected REST API,
- an MCP server (so AI agents like Claude Code can read and reply on your behalf),
- an outbound webhook for inbound-message push.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys) (reverse-engineered WhatsApp Web protocol). Single Node process, SQLite for storage. No external dependencies at runtime aside from WhatsApp itself.

## Status

This is personal infrastructure. It is not a product, not multi-tenant, has no billing, and is not hardened for public exposure. Use behind loopback or a reverse proxy you control.

WhatsApp can ban any number used with reverse-engineered clients, especially under spammy patterns. The author has accepted that risk; you should think carefully before doing the same.

## What you get

| Feature | Notes |
|---|---|
| Pair via QR or 8-character pairing code | Pairing code is the headless-friendly path |
| Multiple sessions in one process | Up to ~3 numbers, each addressed by `?session=` |
| Inbound + outbound persistence | SQLite, per-session, deduped by message id |
| Full history backfill on first pair | `syncFullHistory: true` — typically several months |
| `messages` + `chats` + `contacts` tables | Group chats included |
| LID ↔ phone-number alias merge | Collapses two-JID-same-person into one conversation |
| Display name + phone enrichment | Resolved across the alias group |
| REST API on `127.0.0.1:8080` | Bearer-token auth, auto-generated on first boot |
| Web UI at `/` | Single HTML file, polls for updates |
| MCP server (stdio) | Claude Code, Codex, etc. can use it as a tool source |
| Inbound webhook | Configurable URL, retries with backoff, optional bearer header |

## Quick start

```bash
# 1. install
cd ~/apps/wa-bridge
npm install

# 2. pair the first number — opens a session, prints an 8-char pairing code
npm run pair -- main <country-code+number-digits>
# e.g. npm run pair -- main 491761234567
```

On the phone for that number: **WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** → enter the code printed in your terminal.

After pairing succeeds, the daemon stays running. You can subsequently start everything with:

```bash
npm run start
```

This restores every paired session under `./auth/<name>/` and starts the API + UI.

To pair a second number alongside an existing one:

```bash
npm run start -- personal 491771234567
```

(Restores `main`, pairs `personal` in the same process.)

## Web UI

Open http://127.0.0.1:8080/ — paste the token from `.env` (`API_TOKEN=...`) and you're in. The token is stored in `localStorage`; click *Logout* to clear it.

## REST API

All paths under `/v1/`. All routes require `Authorization: Bearer <API_TOKEN>` except `/v1/health` and `/`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/v1/health` | — | `{ ok, sessions, ts }` |
| `GET` | `/v1/conversations` | `?session=` `?limit=` | List of conversations with last message + display_name + phone |
| `GET` | `/v1/messages` | `?session=` `?jid=` `?limit=` `?before=` | Paginated messages for one chat (alias-aware) |
| `POST` | `/v1/send` | `{ session, to, text }` | Sends a text message |
| `GET` | `/v1/aliases` | `?session=` | List of LID-to-canonical mappings |
| `POST` | `/v1/aliases` | `{ session, alias, canonical }` | Add/update a mapping |
| `DELETE` | `/v1/aliases` | `{ session, alias }` | Remove a mapping |
| `POST` | `/v1/webhook/test` | — | Pings the configured `WEBHOOK_URL` |

`to` accepts either a JID (`<digits>@s.whatsapp.net`, `<id>@lid`, `<id>@g.us`) or a phone number string (digits only, no `+`).

## MCP server

A stdio MCP server is shipped at `src/mcp.ts`. It connects to the local REST API and exposes:

- `list_sessions`
- `list_conversations({ session?, limit? })`
- `read_conversation({ jid, session?, limit?, before? })`
- `send_message({ to, text, session? })`
- `list_aliases({ session? })`
- `merge_jids({ alias, canonical, session? })`
- `unmerge_jid({ alias, session? })`

To wire into Claude Code (user-scope):

```bash
TOKEN=$(grep '^API_TOKEN=' ~/apps/wa-bridge/.env | cut -d= -f2)

claude mcp add-json wa-bridge --scope user "{
  \"command\": \"$(pwd)/node_modules/.bin/tsx\",
  \"args\": [\"$(pwd)/src/mcp.ts\"],
  \"env\": {
    \"API_TOKEN\": \"$TOKEN\",
    \"WA_BRIDGE_URL\": \"http://127.0.0.1:8080\"
  }
}"
```

The wa-bridge daemon must be running for MCP tools to do anything.

## Inbound webhook

If `WEBHOOK_URL` is set in `.env`, every inbound message POSTs to it as JSON:

```json
{
  "event": "message",
  "session": "main",
  "message": {
    "id": "main:ABC123",
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

If `WEBHOOK_TOKEN` is set, it's sent as `Authorization: Bearer <token>`. Three attempts with 1s/3s backoff, 5s timeout per attempt. Outbound messages do not fire the webhook.

## Configuration

Read from `.env` at startup. All optional; sensible defaults apply.

| Variable | Default | Notes |
|---|---|---|
| `API_TOKEN` | auto-generated | 32-byte hex token written to `.env` on first run if absent |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only behind a reverse proxy |
| `PORT` | `8080` | |
| `WEBHOOK_URL` | (disabled) | If set, every inbound message POSTs to this URL |
| `WEBHOOK_TOKEN` | (none) | Optional bearer token for `WEBHOOK_URL` |
| `WA_DB_PATH` | `./data/wa.db` | SQLite file location |

## Layout

```
src/
  index.ts     boot — restore all paired sessions + start API
  wa.ts        WaManager — per-session sockets, send, message capture, history sync
  db.ts        SQLite schema + queries (messages, chats, contacts, aliases)
  api.ts       Fastify REST + static UI route
  mcp.ts       MCP stdio server (talks HTTP to api.ts)
  webhook.ts   inbound dispatcher with retries
  env.ts       dotenv loader + token generator
  history.ts   CLI: print recent messages for a session
web/
  index.html   single-page web UI
auth/<name>/   Baileys session keys (per number) — gitignored
data/wa.db     SQLite — gitignored
.env           secrets — gitignored
```

## How history is backfilled

`syncFullHistory: true` is enabled in `wa.ts`. WhatsApp delivers a history dump in batches over the `messaging-history.set` event after pairing. We ingest chats, contacts, and messages into SQLite. Existing rows are deduped by primary key.

Re-pairing an existing session triggers a fresh history dump:

1. On the phone, **Settings → Linked Devices → Log Out** the wa-bridge entry.
2. Locally, `rm -rf auth/<name>` and re-run `npm run start -- <name> <number>`.
3. SQLite messages and aliases survive the wipe (they're in `data/`, not `auth/`).

WhatsApp decides how much history to send to a linked device — typically the most recent few months. There is no API to request "everything since the dawn of time."

## LID vs phone — the merge layer

Inbound messages from non-contacts often arrive with a `<id>@lid` JID instead of `<phone>@s.whatsapp.net`. WhatsApp does this for privacy. The same person can therefore appear as two conversations.

When you know two JIDs are the same person, register an alias:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8080/v1/aliases \
  -d '{"session":"main","alias":"123456789@lid","canonical":"491761234567@s.whatsapp.net"}'
```

`listConversations` and `listMessages` collapse them on read. Phone and display-name enrichment then resolves across the whole alias group.

Aliases are per-session.

## Risks and limits

- **WhatsApp can ban the number.** Ban rate scales with how spammy your usage looks. Personal use across known contacts is generally safe; cold outreach is not.
- **No media yet.** v0 stores `[image]` / `[audio]` / `[document]` placeholders. Bodies of media messages (captions) are captured. Actual binary download is on the todo list.
- **Pairing-code reliability.** Some custom `browser` identifiers cause WhatsApp to reject the pairing code. We use `Browsers.macOS('Safari')` because it's known-good.
- **Baileys breakage.** WhatsApp ships protocol changes occasionally; expect to `npm update @whiskeysockets/baileys` every few months.
- **History sync size.** Initial sync can pull thousands of messages. The first batch hits SQLite within a few seconds.

## License

Personal use. No warranty.
