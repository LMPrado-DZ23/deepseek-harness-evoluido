export type HealthState = { state: 'OK' | 'ATTENTION'; route: string | null; builder: 'OK' | 'BLOCKED_EXTERNAL'; disk: 'OK' | 'ATTENTION' }
export type ProjectSummary = { project_id: string; name: string; state: string }

const CSRF_STORAGE_KEY = 'dz23.studio.csrf.v1'

async function csrf(): Promise<string> {
  const stored = window.sessionStorage.getItem(CSRF_STORAGE_KEY)
  if (stored !== null && stored !== '') return stored
  const response = await fetch('/api/studio/identity/csrf', { credentials: 'same-origin' })
  if (!response.ok) return ''
  const body = await response.json() as { csrf_token?: unknown }
  if (typeof body.csrf_token !== 'string' || body.csrf_token === '') return ''
  window.sessionStorage.setItem(CSRF_STORAGE_KEY, body.csrf_token)
  return body.csrf_token
}

export async function api<T>(path: string, init: RequestInit = {}, acceptDeclaredResult = false): Promise<T> {
  const csrfToken = init.body === undefined ? '' : await csrf()
  const bodyHeaders = init.body === undefined ? {} : typeof init.body === 'string'
    ? { 'content-type': 'application/json', 'x-dz23-csrf': csrfToken }
    : { 'x-dz23-csrf': csrfToken }
  const response = await fetch(`/api/studio/apps${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...bodyHeaders, ...init.headers },
  })
  const body = await response.json() as T & { error?: string }
  if (!response.ok && !(acceptDeclaredResult && typeof body === 'object' && body !== null && 'state' in body)) {
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  return body
}
