import { recentMessages } from './db.js'

const session = process.argv[2] ?? 'main'
const limit = Number(process.argv[3] ?? 20)

const rows = recentMessages(session, limit)

if (rows.length === 0) {
  console.log(`(no messages yet for session "${session}")`)
  process.exit(0)
}

for (const r of rows.reverse()) {
  const time = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19)
  const arrow = r.direction === 'in' ? '<-' : '->'
  const body = r.body ?? `[${r.type}]`
  console.log(`${time}  ${arrow}  ${r.chat_jid}  |  ${body}`)
}
