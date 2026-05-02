import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.WA_DB_PATH ?? './data/wa.db'

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    push_name TEXT,
    is_lid INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    from_jid TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    type TEXT NOT NULL,
    body TEXT,
    media_path TEXT,
    ts INTEGER NOT NULL,
    raw_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_chat_ts
    ON messages(session, chat_jid, ts DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_session_ts
    ON messages(session, ts DESC);

  CREATE TABLE IF NOT EXISTS jid_aliases (
    session   TEXT NOT NULL,
    alias     TEXT NOT NULL,
    canonical TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    PRIMARY KEY (session, alias)
  );

  CREATE INDEX IF NOT EXISTS idx_jid_aliases_canonical
    ON jid_aliases(session, canonical);

  CREATE TABLE IF NOT EXISTS chats (
    session       TEXT NOT NULL,
    jid           TEXT NOT NULL,
    name          TEXT,
    is_group      INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    mute_until    INTEGER,
    unread_count  INTEGER,
    last_msg_ts   INTEGER,
    raw_json      TEXT,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session, jid)
  );

  CREATE INDEX IF NOT EXISTS idx_chats_session_last_ts
    ON chats(session, last_msg_ts DESC);
`)

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (jid, push_name, is_lid, first_seen, last_seen)
  VALUES (@jid, @push_name, @is_lid, @ts, @ts)
  ON CONFLICT(jid) DO UPDATE SET
    push_name = COALESCE(excluded.push_name, contacts.push_name),
    last_seen = excluded.last_seen
`)

const insertMessageStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, session, chat_jid, from_jid, direction, type, body, media_path, ts, raw_json)
  VALUES
    (@id, @session, @chat_jid, @from_jid, @direction, @type, @body, @media_path, @ts, @raw_json)
`)

const upsertAliasStmt = db.prepare(`
  INSERT INTO jid_aliases (session, alias, canonical, ts)
  VALUES (@session, @alias, @canonical, @ts)
  ON CONFLICT(session, alias) DO UPDATE SET
    canonical = excluded.canonical,
    ts        = excluded.ts
`)

const removeAliasStmt = db.prepare(`
  DELETE FROM jid_aliases WHERE session = ? AND alias = ?
`)

const findCanonicalStmt = db.prepare(`
  SELECT canonical FROM jid_aliases WHERE session = ? AND alias = ?
`)

const findAliasesOfStmt = db.prepare(`
  SELECT alias FROM jid_aliases WHERE session = ? AND canonical = ?
`)

const listAliasesStmt = db.prepare(`
  SELECT alias, canonical, ts FROM jid_aliases
  WHERE session = ?
  ORDER BY ts DESC
`)

const upsertChatStmt = db.prepare(`
  INSERT INTO chats
    (session, jid, name, is_group, archived, pinned, mute_until,
     unread_count, last_msg_ts, raw_json, updated_at)
  VALUES
    (@session, @jid, @name, @is_group, @archived, @pinned, @mute_until,
     @unread_count, @last_msg_ts, @raw_json, @updated_at)
  ON CONFLICT(session, jid) DO UPDATE SET
    name         = COALESCE(excluded.name,         chats.name),
    is_group     = excluded.is_group,
    archived     = excluded.archived,
    pinned       = excluded.pinned,
    mute_until   = COALESCE(excluded.mute_until,   chats.mute_until),
    unread_count = COALESCE(excluded.unread_count, chats.unread_count),
    last_msg_ts  = COALESCE(
                     CASE WHEN excluded.last_msg_ts > IFNULL(chats.last_msg_ts, 0)
                          THEN excluded.last_msg_ts END,
                     chats.last_msg_ts
                   ),
    raw_json     = excluded.raw_json,
    updated_at   = excluded.updated_at
`)

export type Direction = 'in' | 'out'

export interface ContactInput {
  jid: string
  push_name: string | null
  is_lid: number
  ts: number
}

export interface MessageInput {
  id: string
  session: string
  chat_jid: string
  from_jid: string
  direction: Direction
  type: string
  body: string | null
  media_path: string | null
  ts: number
  raw_json: string | null
}

export function upsertContact(c: ContactInput): void {
  upsertContactStmt.run(c)
}

export interface ChatInput {
  session: string
  jid: string
  name: string | null
  is_group: number
  archived: number
  pinned: number
  mute_until: number | null
  unread_count: number | null
  last_msg_ts: number | null
  raw_json: string | null
}

export function upsertChat(c: ChatInput): void {
  upsertChatStmt.run({ ...c, updated_at: Date.now() })
}

export function upsertChatsBatch(chats: ChatInput[]): void {
  const tx = db.transaction((rows: ChatInput[]) => {
    for (const c of rows) upsertChat(c)
  })
  tx(chats)
}

export function insertMessage(m: MessageInput): { changes: number } {
  return insertMessageStmt.run(m)
}

export function upsertAlias(session: string, alias: string, canonical: string): void {
  if (!alias || !canonical) throw new Error('alias and canonical are required')
  if (alias === canonical) return
  upsertAliasStmt.run({ session, alias, canonical, ts: Date.now() })
}

export function removeAlias(session: string, alias: string): { changes: number } {
  return removeAliasStmt.run(session, alias)
}

export function listAliases(session: string) {
  return listAliasesStmt.all(session) as Array<{
    alias: string
    canonical: string
    ts: number
  }>
}

export function expandJidGroup(session: string, jid: string): string[] {
  const aliasRow = findCanonicalStmt.get(session, jid) as { canonical: string } | undefined
  const canonical = aliasRow?.canonical ?? jid
  const aliases = findAliasesOfStmt.all(session, canonical) as Array<{ alias: string }>
  return Array.from(new Set([canonical, ...aliases.map((a) => a.alias)]))
}

const pushNameByJidStmt = db.prepare(
  `SELECT push_name FROM contacts WHERE jid = ? AND push_name IS NOT NULL`,
)

export function pushNameFor(session: string, jid: string): string | null {
  for (const j of expandJidGroup(session, jid)) {
    const row = pushNameByJidStmt.get(j) as { push_name: string } | undefined
    if (row?.push_name) return row.push_name
  }
  return null
}

export function extractPhone(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null
  const digits = jid.split('@')[0].split(':')[0]
  if (!/^\d+$/.test(digits)) return null
  return `+${digits}`
}

export function phoneFor(session: string, jid: string): string | null {
  for (const j of expandJidGroup(session, jid)) {
    const phone = extractPhone(j)
    if (phone) return phone
  }
  return null
}

export function recentMessages(session: string, limit = 20) {
  return db
    .prepare(
      `SELECT ts, direction, chat_jid, from_jid, type, body
       FROM messages
       WHERE session = ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(session, limit) as Array<{
      ts: number
      direction: Direction
      chat_jid: string
      from_jid: string
      type: string
      body: string | null
    }>
}

export function listConversations(session: string, limit = 100) {
  return db
    .prepare(
      `WITH msg_canon AS (
         SELECT m.body, m.direction, m.type, m.ts,
                COALESCE(a.canonical, m.chat_jid) AS canonical_jid
         FROM messages m
         LEFT JOIN jid_aliases a
           ON a.session = m.session AND a.alias = m.chat_jid
         WHERE m.session = @session
       ),
       last_msg AS (
         SELECT canonical_jid, body, direction, type, ts,
                ROW_NUMBER() OVER (PARTITION BY canonical_jid ORDER BY ts DESC) AS rn
         FROM msg_canon
       ),
       chat_canon AS (
         SELECT COALESCE(a.canonical, ch.jid) AS canonical_jid,
                ch.name, ch.is_group, ch.archived, ch.pinned,
                ch.unread_count, ch.last_msg_ts
         FROM chats ch
         LEFT JOIN jid_aliases a
           ON a.session = ch.session AND a.alias = ch.jid
         WHERE ch.session = @session
       ),
       all_jids AS (
         SELECT canonical_jid FROM last_msg WHERE rn = 1
         UNION
         SELECT canonical_jid FROM chat_canon
       )
       SELECT
         j.canonical_jid                          AS chat_jid,
         cc.name                                  AS chat_name,
         COALESCE(cc.is_group, 0)                 AS is_group,
         COALESCE(cc.archived, 0)                 AS archived,
         COALESCE(cc.pinned, 0)                   AS pinned,
         cc.unread_count,
         co.push_name,
         lm.body                                  AS last_body,
         lm.direction                             AS last_direction,
         lm.type                                  AS last_type,
         COALESCE(lm.ts, cc.last_msg_ts)          AS last_ts
       FROM all_jids j
       LEFT JOIN last_msg lm
         ON lm.canonical_jid = j.canonical_jid AND lm.rn = 1
       LEFT JOIN chat_canon cc
         ON cc.canonical_jid = j.canonical_jid
       LEFT JOIN contacts co
         ON co.jid = j.canonical_jid
       WHERE COALESCE(lm.ts, cc.last_msg_ts) IS NOT NULL
       ORDER BY COALESCE(lm.ts, cc.last_msg_ts) DESC
       LIMIT @limit`,
    )
    .all({ session, limit }) as Array<{
      chat_jid: string
      chat_name: string | null
      is_group: number
      archived: number
      pinned: number
      unread_count: number | null
      push_name: string | null
      last_body: string | null
      last_direction: Direction | null
      last_type: string | null
      last_ts: number | null
    }>
}

export function listMessages(
  session: string,
  chatJid: string,
  limit = 50,
  before?: number,
) {
  const jids = expandJidGroup(session, chatJid)
  const placeholders = jids.map(() => '?').join(',')
  const sql = `
    SELECT id, ts, direction, from_jid, chat_jid, type, body
    FROM messages
    WHERE session = ?
      AND chat_jid IN (${placeholders})
      AND (? IS NULL OR ts < ?)
    ORDER BY ts DESC
    LIMIT ?
  `
  return db.prepare(sql).all(
    session,
    ...jids,
    before ?? null,
    before ?? null,
    limit,
  ) as Array<{
    id: string
    ts: number
    direction: Direction
    from_jid: string
    chat_jid: string
    type: string
    body: string | null
  }>
}
