import './env.js'
import pino from 'pino'

import { wa, scanRegisteredSessions } from './wa.js'
import { startApi } from './api.js'

const log = pino({ level: 'info' }).child({ mod: 'main' })

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
