# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Companion docs

- `README.md` — user-facing setup, REST API table, env vars
- `AGENTS.md` — connecting-agent contract (MCP tools, safety rules, data model). Read this if you're touching MCP tool surfaces or anything that an external agent calls.

This file deliberately does not duplicate them. Read them when the topic is in scope.

## Commands

All scripts go through `npm run`. There is no build step (tsx executes TS directly), no test suite, no linter.

```bash
npm install                                  # one-time
npm run start                                # boot daemon: restore all paired sessions, start API on 127.0.0.1:8080
npm run dev                                  # same, with tsx --watch (auto-reload on src/ changes)
npm run pair -- <name> <digits>              # pair a new number; e.g. npm run pair -- main 491761234567
npm run start -- <name> <digits>             # restore existing sessions AND pair a new one alongside
npm run history                              # CLI: dump recent messages for a session (src/history.ts)
npm run mcp                                  # spawn the MCP stdio server (usually invoked by Claude Code, not by hand)
npm run import-contacts -- --session=main    # bulk-enrich contacts from macOS Contacts.app (also: --session=personal, --refresh, --limit=N)

npx tsc --noEmit                             # type-check before declaring work done — strict mode is on
```

Useful one-liners while developing:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/health
sqlite3 data/wa.db                            # the entire data model lives in this one file
tail -f data/daemon.log                       # if the daemon was started via nohup
```

## Architecture in one screen

Single Node process. One Baileys `WASocket` per session under `auth/<name>/`. All persistence in one SQLite file at `data/wa.db` (WAL mode, foreign keys on).

```
WhatsApp ── Baileys (src/wa.ts) ── SQLite (src/db.ts)
                                       ▲
                                       │ reads
                Fastify (src/api.ts) ──┴── serves web UI + REST + media files
                       ▲
                       │ HTTP (loopback, bearer token)
                MCP stdio (src/mcp.ts)         ← spawned by Claude Code etc.
                Webhook (src/webhook.ts) ── POSTs inbound messages to WEBHOOK_URL
```

Boot sequence in `src/index.ts`: load `.env` → ensure `API_TOKEN` → instantiate `WaManager` → `manager.start(name)` for every dir under `auth/` → `startApi()`. Pairing flag (`<name> <digits>` argv) triggers a one-off pair within the same process.

## Patterns to know before editing

**Per-session everything.** Every table that's per-account has `session TEXT NOT NULL` in its primary key. New tables follow the same shape. The `?session=` query param threads through every API route.

**JIDs come in three forms** — `<digits>@s.whatsapp.net` (PN, has phone), `<id>@lid` (privacy alias, no phone), `<id>@g.us` (group). The same person can appear under both PN and LID; `jid_aliases(session, alias) → canonical` collapses them. **Always resolve through `expandJidGroup` / `pushNameFor` / `phoneFor` in `db.ts`** rather than reading a raw `from_jid` directly — these walk the alias chain bidirectionally.

**`listConversations` does the LID↔PN collapse on read** via a CTE in `db.ts`. If you add a new "list chats" query, mirror that CTE shape or names will silently regress for half the address book.

**Schema migrations are inline `try { db.exec('ALTER TABLE …') } catch {}`** at the top of `src/db.ts`. To add a column, append a line to the `migrations` array — never edit the `CREATE TABLE` body alone (existing DBs won't pick it up). There is no migrations framework and we are not adding one.

**Outbound messages get written to SQLite twice and deduped** — once by `wa.sendText`, once when Baileys echoes via `messages.upsert`. The dedup is `INSERT OR IGNORE` on the message id (`<session>:<msg_key_id>`). Don't add an UPDATE branch unless you've thought through both write paths.

**Pairing requires `Browsers.macOS('Safari')`.** WhatsApp rejects custom browser identifiers and the pairing code times out silently. Don't "clean up" the browser tuple in `wa.ts`.

**Daemon is not in watch mode by default.** `npm run start` runs `tsx src/index.ts` (no watch). After editing `src/`, `kill <pid> && npm run start` (sockets reconnect from saved auth — no re-pair needed). Use `npm run dev` if you'll be iterating heavily; it watches.

**`enrichConvo` in `src/api.ts` prefers contact `push_name` (Mac label) over chat_name for 1:1 chats**, and the opposite for groups (group subject wins). If you change name resolution, mirror this asymmetry — otherwise saved Mac labels stop showing in the sidebar.

**Don't touch `auth/`, `data/`, or `.env` from code.** `auth/` holds Baileys session keys (deleting forces a re-pair), `data/wa.db` is the entire message store, `.env` holds the bearer token. They're all gitignored. The `auto memory` feedback rules apply: ask before any destructive op against them.

## Filesystem layout

```
src/
  index.ts            boot (restore sessions, start API)
  wa.ts               WaManager — sockets, send, history sync, group meta refresh
  db.ts               schema + queries (single source of truth for SQL)
  api.ts              Fastify routes + enrichment (display_name, phone, media_url, reactions, quoted)
  mcp.ts              MCP stdio server — talks HTTP to api.ts
  webhook.ts          inbound dispatcher (1s/3s backoff, 5s timeout)
  env.ts              dotenv loader + auto-generates API_TOKEN on first boot
  history.ts          one-shot CLI: print recent messages
  import-contacts.ts  macOS Contacts → DB enrichment (osascript dump → /v1/check → upsertContact + upsertAlias for LID)
web/index.html        single-page UI; reads display_name / from_label off the API and renders verbatim
auth/<name>/          Baileys session keys (gitignored)
data/wa.db            SQLite (gitignored). data/media/<session>/ holds downloaded media.
```
