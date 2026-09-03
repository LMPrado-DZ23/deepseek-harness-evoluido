import { constants, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

async function executable(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' && extname(name) === '' ? `${name}${extension}` : name)
      try {
        await access(candidate, constants.X_OK)
        return true
      } catch {}
    }
  }
  return false
}

async function cliState(name, configured) {
  if (!await executable(name)) return 'NOT_PRESENT'
  return configured ? 'OK' : 'NOT_CONFIGURED'
}

function localModelsUrl(value, fallback) {
  try {
    const url = new URL(value || fallback)
    if (!ALLOWED_HOSTS.has(url.hostname)) return undefined
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

async function localRouteState(baseUrl, fallback, configured = true) {
  const url = localModelsUrl(baseUrl, fallback)
  if (url === undefined || !configured) return 'NOT_CONFIGURED'
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2_000) })
    return response.ok ? 'OK' : 'DOWN'
  } catch {
    return 'DOWN'
  }
}

const home = homedir()
const states = {
  codex: await cliState('codex', Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY
    || existsSync(join(home, '.codex', 'auth.json')))),
  claude: await cliState('claude', Boolean(process.env.ANTHROPIC_API_KEY
    || existsSync(join(home, '.claude', '.credentials.json')) || existsSync(join(home, '.claude.json')))),
  ollama: await localRouteState(process.env.DZ23_OLLAMA_BASE_URL, 'http://127.0.0.1:11434/v1'),
  omniroute: await localRouteState(
    process.env.DZ23_OMNIROUTE_BASE_URL,
    'http://127.0.0.1:20128/v1',
    Boolean(process.env.DZ23_OMNIROUTE_KEY),
  ),
}

process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), installedNothing: true, startedNothing: true, states }, null, 2)}\n`)
