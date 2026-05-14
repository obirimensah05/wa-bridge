# wa-bridge

> Self-hosted WhatsApp bridge for AI agents. One paired number, exposed via REST, MCP, and a web UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Built on [Baileys](https://github.com/WhiskeySockets/Baileys). Single Node process, SQLite for storage, no runtime dependencies beyond WhatsApp itself.

## What you get

- **REST API** on `127.0.0.1:8080` — read conversations, send messages, manage aliases.
- **MCP server** (stdio) — drops directly into Claude Code, Codex, or any MCP-capable agent.
- **Web UI** at `/` — single-page inbox for reading and sending.
- **Inbound webhook** (optional) — every received message POSTed to a URL of your choice.
- **Full history backfill** on first pair — typically several months of past chats.
- **LID ↔ phone alias merge** — collapses the two JIDs WhatsApp uses for the same person into one conversation.
- **Display name resolution** that works without any local contacts sync (push_name from WhatsApp itself), with optional macOS Contacts enrichment.
- **Local-timezone CLI output** with DST handled by IANA tzdata.

## Status

Personal infrastructure. Not multi-tenant. Locked to **one paired number at a time**. Use behind loopback or a reverse proxy you control.

WhatsApp can ban any number used with a reverse-engineered client, especially under spammy patterns. Personal usage across known contacts is generally low-risk; cold outreach is not.

## Quick start

```bash
# 1. install
cd ~/apps/wa-bridge
npm install

# 2. pair your number — country code + national digits, no `+`, no spaces
npm run pair -- main 491761234567
```

On the phone for that number: **WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** → enter the 8-character code printed in your terminal.

On first boot the bridge:
- generates `API_TOKEN` and writes it to `.env`
- detects your system timezone and writes it as `WA_TZ` to `.env` (e.g. `Europe/Berlin`)
- prints the active timezone at the start of the pair flow so you can confirm it before approving the code

After pairing succeeds, the daemon stays running. Subsequent starts:

```bash
npm run start
```

To switch to a different number:

```bash
rm -rf auth/main/
npm run pair -- main <new-digits>
```

## Running as a service

The daemon is not supervised by default — if it crashes or you reboot, it stays down. Put it under a process supervisor.

**macOS (launchd)** — create `~/Library/LaunchAgents/com.example.wa-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.example.wa-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npm</string>
        <string>run</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key><string>/Users/YOU/apps/wa-bridge</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
        <key>Crashed</key><true/>
    </dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>/Users/YOU/apps/wa-bridge/logs/wa-bridge.out.log</string>
    <key>StandardErrorPath</key><string>/Users/YOU/apps/wa-bridge/logs/wa-bridge.err.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/apps/wa-bridge/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.wa-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.wa-bridge   # restart after edits
launchctl bootout  gui/$(id -u)/com.example.wa-bridge        # uninstall
```

**Linux (systemd)** — a `systemd --user` unit pointing at `npm run start` with `Restart=on-failure` works the same way.

## Web UI

Open <http://127.0.0.1:8080/> and paste the value of `API_TOKEN` from `.env`. Token is stored in `localStorage`; click *Logout* to clear it.

## REST API

All routes under `/v1/`. All require `Authorization: Bearer <API_TOKEN>` except `/v1/health` and `/`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/v1/health` | — | `{ ok, sessions, ts }` |
| `GET` | `/v1/conversations` | `?session=` `?limit=` | Chats with last message + `display_name` + `phone` |
| `GET` | `/v1/messages` | `?session=` `?jid=` `?limit=` `?before=` | Paginated messages for one chat (alias-aware) |
| `POST` | `/v1/send` | `{ session, to, text }` | Sends a text |
| `GET` | `/v1/aliases` | `?session=` | LID-to-canonical mappings |
| `POST` | `/v1/aliases` | `{ session, alias, canonical }` | Add/update a mapping |
| `DELETE` | `/v1/aliases` | `{ session, alias }` | Remove a mapping |
| `POST` | `/v1/webhook/test` | — | Pings the configured `WEBHOOK_URL` |

`to` accepts either a JID (`<digits>@s.whatsapp.net`, `<id>@lid`, `<id>@g.us`) or digits-only phone number (no `+`).

Quick example:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/v1/conversations?session=main&limit=20'
```

## MCP server

The MCP server at `src/mcp.ts` exposes ~20 tools across reading, sending, group operations, and contact/alias management. See [AGENTS.md](AGENTS.md) for the full tool surface and the safety contract.

Wire into Claude Code (user-scope):

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

The daemon must be running for any MCP tool to do anything.

## Inbound webhook (optional)

Set `WEBHOOK_URL` in `.env` and restart. Every inbound message POSTs:

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

If `WEBHOOK_TOKEN` is set, it arrives as `Authorization: Bearer <token>` so the receiver can verify origin. Three attempts, 1s/3s backoff, 5s timeout per attempt. Outbound sends do **not** fire the webhook.

## Configuration

All variables are read from `.env` at startup; all are optional with sensible defaults.

| Variable | Default | Notes |
|---|---|---|
| `API_TOKEN` | auto-generated | 32-byte hex token written to `.env` on first run if absent. |
| `WA_TZ` | system tz | Auto-detected on first boot and persisted. Use IANA names (`Europe/Berlin`, `America/New_York`) — DST is handled by tzdata. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only behind a reverse proxy. Set `WA_ALLOW_PUBLIC=1` to override the loopback guard. |
| `PORT` | `8080` | |
| `WEBHOOK_URL` | (disabled) | If set, every inbound message POSTs to this URL. |
| `WEBHOOK_TOKEN` | (none) | Optional bearer token for `WEBHOOK_URL`. |
| `OPENAI_API_KEY` | (none) | Used by `npm run transcribe-backlog` to transcribe past audio messages. |

## NPM scripts

| Command | Purpose |
|---|---|
| `npm run start` | Boot the daemon. |
| `npm run dev` | Same, with `tsx --watch`. |
| `npm run pair -- main <digits>` | Pair a number. Refuses if any session already exists. |
| `npm run history` | CLI dump of recent messages, with display names, in local time. |
| `npm run import-contacts -- --session=main` | Bulk-enrich contacts from macOS Contacts.app (`--refresh`, `--limit=N`). |
| `npm run transcribe-backlog` | Run Whisper over past audio messages without transcripts. |
| `npm run backup` | SQLite backup of `data/wa.db` into `data/backups/`. |
| `npm run mcp` | Spawn the MCP stdio server (Claude Code launches this automatically). |

See [COMMANDS.md](COMMANDS.md) for the full reference including REST examples and common ops.

## Layout

```
src/
  index.ts       boot — restore the paired session + start API
  wa.ts          WaManager — socket, send, history sync, group meta refresh
  db.ts          SQLite schema + queries (single source of truth for SQL)
  api.ts         Fastify REST + static UI route
  mcp.ts         MCP stdio server (talks HTTP to api.ts)
  webhook.ts     inbound dispatcher with retries
  env.ts         .env loader + API_TOKEN/WA_TZ auto-persist
  time.ts        formatLocal(ts) for CLI/log timestamps
  history.ts     CLI: print recent messages with display names
web/index.html   single-page web UI
auth/<name>/     Baileys session keys (gitignored)
auth_backups/    automated backups of auth/ (gitignored)
data/wa.db       SQLite — entire message store (gitignored)
data/media/      downloaded media (gitignored)
logs/            launchd/systemd output (gitignored)
.env             secrets + config (gitignored)
```

## How history is backfilled

`syncFullHistory: true` is enabled in `wa.ts`. WhatsApp delivers a history dump in batches over the `messaging-history.set` event after pairing. The bridge ingests chats, contacts, and messages into SQLite. Existing rows are deduped by primary key.

To force a fresh dump:

1. On the phone, **Settings → Linked Devices** → log out the wa-bridge entry.
2. `rm -rf auth/main/` and re-run `npm run pair -- main <digits>`.
3. SQLite messages and aliases survive the wipe (they live in `data/`, not `auth/`).

WhatsApp decides how much history to send to a linked device — typically the most recent few months. There is no API to request "everything since the dawn of time."

## LID vs phone — the merge layer

Inbound messages from non-contacts often arrive with a `<id>@lid` JID instead of `<phone>@s.whatsapp.net`. WhatsApp does this for privacy. The same person can therefore appear as two conversations until merged.

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8080/v1/aliases \
  -d '{"session":"main","alias":"123456789@lid","canonical":"491761234567@s.whatsapp.net"}'
```

After that, `listConversations` and `listMessages` collapse them on read. Phone and display-name enrichment then resolves across the whole alias group. The MCP equivalent is `merge_jids` / `unmerge_jid`.

## Risks and limits

- **WhatsApp can ban the number.** Ban rate scales with how spammy your usage looks. Personal use across known contacts is generally safe; cold outreach is not.
- **Baileys breakage.** WhatsApp ships protocol changes occasionally; expect to bump `@whiskeysockets/baileys` every few months. The bridge has a built-in update notifier.
- **Pairing-code identifiers.** Some `browser` identifiers cause WhatsApp to reject pairing codes. The bridge uses `Browsers.macOS('Safari')` because it's known-good — don't change it without testing.
- **History sync size.** Initial sync can pull thousands of messages. First batch usually lands within a few seconds.
- **Single device.** WhatsApp enforces a limit on linked devices per account. Pairing wa-bridge consumes one slot.

## License

[MIT](LICENSE). Do whatever you want with it; keep the copyright notice. No warranty.
