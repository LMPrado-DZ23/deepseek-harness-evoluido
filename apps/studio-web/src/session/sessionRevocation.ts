import type { CurrentSessionMode } from './currentSession'

export const SESSION_REVOCATION_CHANNEL = 'dz23.studio.session-revocation.v1'
export const SESSION_REVOCATION_STORAGE_KEY = 'dz23.studio.session-revocation.event.v1'
export const SESSION_GENERATION_COOKIE = 'dz23_studio_session_generation'

export type SessionRevocationSignal = {
  readonly schema_version: 1
  readonly kind: 'signed-out'
  readonly event_id: string
  readonly source_id: string
}

export interface SessionRevocationChannel {
  postMessage(value: unknown): void
  onMessage(listener: (value: unknown) => void): () => void
  close(): void
}

export interface SessionRevocationEnvironment {
  readonly sourceId: string
  createId(): string
  createChannel(name: string): SessionRevocationChannel
  store(key: string, value: string): void
  remove(key: string): void
  onStorage(listener: (key: string | null, value: string | null) => void): () => void
}

export interface RemoteRevocationPort {
  currentMode(): Promise<CurrentSessionMode>
  currentGeneration(): string
  clearOwnedState(): Promise<void>
  redirect(path: string): void
}

export function browserSessionGeneration(cookie = document.cookie): string {
  const values = cookie.split(';').flatMap(part => {
    const at = part.indexOf('=')
    if (at < 1 || part.slice(0, at).trim() !== SESSION_GENERATION_COOKIE) return []
    try {
      const value = decodeURIComponent(part.slice(at + 1).trim())
      return /^[a-f0-9]{32}$/u.test(value) ? [value] : []
    } catch { return [] }
  })
  return [...new Set(values)].sort().join('.')
}

function createBrowserId(): string {
  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
}

let browserSourceId: string | undefined

function currentBrowserSourceId(): string {
  browserSourceId ??= createBrowserId()
  return browserSourceId
}

function browserEnvironment(): SessionRevocationEnvironment {
  return {
    sourceId: currentBrowserSourceId(),
    createId: createBrowserId,
    createChannel: name => {
      const channel = new BroadcastChannel(name)
      return {
        postMessage: value => channel.postMessage(value),
        onMessage: listener => {
          const receive = (event: MessageEvent) => listener(event.data)
          channel.addEventListener('message', receive)
          return () => channel.removeEventListener('message', receive)
        },
        close: () => channel.close(),
      }
    },
    store: (key, value) => window.localStorage.setItem(key, value),
    remove: key => window.localStorage.removeItem(key),
    onStorage: listener => {
      const receive = (event: StorageEvent) => listener(event.key, event.newValue)
      window.addEventListener('storage', receive)
      return () => window.removeEventListener('storage', receive)
    },
  }
}

export function parseSessionRevocationSignal(value: unknown): SessionRevocationSignal | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<SessionRevocationSignal>
  if (candidate.schema_version !== 1 || candidate.kind !== 'signed-out') return null
  if (typeof candidate.event_id !== 'string' || !/^[a-f0-9]{32}$/u.test(candidate.event_id)) return null
  if (typeof candidate.source_id !== 'string' || !/^[a-f0-9]{32}$/u.test(candidate.source_id)) return null
  return { schema_version: 1, kind: 'signed-out', event_id: candidate.event_id, source_id: candidate.source_id }
}

function parseStoredSignal(value: string | null): SessionRevocationSignal | null {
  if (value === null || value.length > 512) return null
  try { return parseSessionRevocationSignal(JSON.parse(value)) } catch { return null }
}

export function publishSessionRevocation(
  environment: SessionRevocationEnvironment = browserEnvironment(),
): SessionRevocationSignal {
  const signal: SessionRevocationSignal = {
    schema_version: 1,
    kind: 'signed-out',
    event_id: environment.createId(),
    source_id: environment.sourceId,
  }

  try {
    const channel = environment.createChannel(SESSION_REVOCATION_CHANNEL)
    try { channel.postMessage(signal) } finally { channel.close() }
  } catch { /* localStorage remains as a browser-compatible fallback */ }

  try {
    environment.store(SESSION_REVOCATION_STORAGE_KEY, JSON.stringify(signal))
    environment.remove(SESSION_REVOCATION_STORAGE_KEY)
  } catch { /* notification is best-effort after authoritative revocation */ }

  return signal
}

export function listenForSessionRevocation(
  onRevoked: () => void | Promise<unknown>,
  environment: SessionRevocationEnvironment = browserEnvironment(),
): () => void {
  const seen: string[] = []
  let running = false
  let rerun = false
  let closed = false

  const run = () => {
    if (closed) return
    if (running) { rerun = true; return }
    running = true
    void Promise.resolve(onRevoked()).catch(() => undefined).finally(() => {
      running = false
      if (rerun) { rerun = false; run() }
    })
  }
  const accept = (value: unknown) => {
    const signal = parseSessionRevocationSignal(value)
    if (signal === null || signal.source_id === environment.sourceId || seen.includes(signal.event_id)) return
    seen.push(signal.event_id)
    if (seen.length > 16) seen.shift()
    run()
  }

  let channel: SessionRevocationChannel | undefined
  let removeChannelListener: () => void = () => undefined
  try {
    channel = environment.createChannel(SESSION_REVOCATION_CHANNEL)
    removeChannelListener = channel.onMessage(accept)
  } catch { /* storage events remain available */ }

  let removeStorageListener: () => void = () => undefined
  try {
    removeStorageListener = environment.onStorage((key, value) => {
      if (key === SESSION_REVOCATION_STORAGE_KEY) accept(parseStoredSignal(value))
    })
  } catch { /* BroadcastChannel remains available */ }

  return () => {
    closed = true
    removeChannelListener()
    removeStorageListener()
    channel?.close()
  }
}

export async function followRemoteSessionRevocation(port: RemoteRevocationPort): Promise<'kept-authenticated' | 'redirected'> {
  const generation = port.currentGeneration()
  const firstMode = await port.currentMode().catch(() => 'unavailable' as const)
  if (firstMode === 'authenticated') return 'kept-authenticated'

  // A response can belong to the cookie that was revoked just before another
  // tab completed a new login. Revalidate with the cookie current at this
  // point before touching browser state; the server remains the authority.
  const confirmedMode = await port.currentMode().catch(() => 'unavailable' as const)
  if (confirmedMode === 'authenticated') return 'kept-authenticated'
  if (port.currentGeneration() !== generation) return 'kept-authenticated'
  await port.clearOwnedState().catch(() => undefined)
  port.redirect('/login')
  return 'redirected'
}
