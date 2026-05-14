import { recentMessages } from './db.js'
import { TIMEZONE } from './env.js'
import { formatLocal } from './time.js'

const session = process.argv[2] ?? 'main'
const limit = Number(process.argv[3] ?? 20)

const rows = recentMessages(session, limit)

if (rows.length === 0) {
  console.log(`(no messages yet for session "${session}")`)
  process.exit(0)
}

console.log(`# session=${session}  tz=${TIMEZONE}`)
for (const r of rows.reverse()) {
  const time = formatLocal(r.ts)
  const arrow = r.direction === 'in' ? '<-' : '->'
  const body = r.body ?? `[${r.type}]`
  console.log(`${time}  ${arrow}  ${r.chat_jid}  |  ${body}`)
}
