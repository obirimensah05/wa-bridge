import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const ENV_PATH = '.env'

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return
  const content = readFileSync(ENV_PATH, 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

function ensureToken(): string {
  if (process.env.API_TOKEN && process.env.API_TOKEN.length >= 32) {
    return process.env.API_TOKEN
  }

  const token = randomBytes(32).toString('hex')
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  if (content && !content.endsWith('\n')) content += '\n'
  content += `API_TOKEN=${token}\n`
  writeFileSync(ENV_PATH, content)
  process.env.API_TOKEN = token
  console.log(`[env] generated new API_TOKEN, saved to ${ENV_PATH}`)
  return token
}

export const API_TOKEN = ensureToken()
export const PORT = Number(process.env.PORT ?? 8080)
export const HOST = process.env.HOST ?? '127.0.0.1'
export const WEBHOOK_URL = process.env.WEBHOOK_URL?.trim() || null
export const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN?.trim() || null
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || null
