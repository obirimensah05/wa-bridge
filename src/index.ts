import './env.js'
import pino from 'pino'

import { wa, scanRegisteredSessions } from './wa.js'
import { startApi } from './api.js'
import { HOST } from './env.js'

const log = pino({ level: 'info' }).child({ mod: 'main' })

// Refuse to bind to a non-loopback address unless the operator has acknowledged
// the implications (single bearer token vs. the public internet, no rate limit).
// Set WA_ALLOW_PUBLIC=1 in .env after putting this behind a reverse proxy with TLS.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && process.env.WA_ALLOW_PUBLIC !== '1') {
  log.error(
    { host: HOST },
    'refusing to bind a non-loopback HOST without WA_ALLOW_PUBLIC=1 — put a TLS-terminating reverse proxy in front and set the flag',
  )
  process.exit(1)
}

const arg1 = process.argv[2]
const arg2 = process.argv[3]

const newSession =
  arg1 && arg2 ? { name: arg1, number: arg2.replace(/[^0-9]/g, '') } : null

const alreadyPaired = scanRegisteredSessions()
const sessionsToRestore = alreadyPaired.filter((s) => s !== newSession?.name)

if (sessionsToRestore.length === 0 && !newSession) {
  log.error(
    'no paired sessions found in ./auth — pair the first one with: npm run pair -- <name> <number>',
  )
  process.exit(1)
}

log.info(
  {
    restoring: sessionsToRestore,
    pairing: newSession ? `${newSession.name} (${newSession.number})` : null,
  },
  'boot',
)

for (const name of sessionsToRestore) {
  try {
    await wa.start(name)
  } catch (err) {
    log.error({ session: name, err }, 'failed to restore session, skipping')
  }
}

if (newSession) {
  try {
    await wa.start(newSession.name, newSession.number)
  } catch (err) {
    log.error({ session: newSession.name, err }, 'failed to start pairing session')
    process.exit(1)
  }
}

await startApi()
