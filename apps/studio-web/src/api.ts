export type HealthState = { state: 'OK' | 'ATTENTION'; route: string | null; builder: 'OK' | 'BLOCKED_EXTERNAL'; disk: 'OK' | 'ATTENTION' }
export type ProjectSummary = { project_id: string; name: string; state: string }

const CSRF_STORAGE_KEY = 'dz23.studio.csrf.v1'

export type ApiResponse<T> = { status: number; body: T | null }

export async function csrfToken(): Promise<string> {
  const stored = window.sessionStorage.getItem(CSRF_STORAGE_KEY)
  if (stored !== null && stored !== '') return stored
  const response = await fetch('/api/studio/identity/csrf', { credentials: 'same-origin' })
  if (!response.ok) return ''
  const body = await response.json() as { csrf_token?: unknown }
  if (typeof body.csrf_token !== 'string' || body.csrf_token === '') return ''
  window.sessionStorage.setItem(CSRF_STORAGE_KEY, body.csrf_token)
  return body.csrf_token
}

async function request<T>(path: string, init: RequestInit): Promise<{ response: Response; body: (T & { error?: string }) | null }> {
  const csrfValue = init.body === undefined ? '' : await csrfToken()
  const bodyHeaders = init.body === undefined ? {} : typeof init.body === 'string'
    ? { 'content-type': 'application/json', 'x-dz23-csrf': csrfValue }
    : { 'x-dz23-csrf': csrfValue }
  const response = await fetch(`/api/studio/apps${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...bodyHeaders, ...init.headers },
  })
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null
  return { response, body }
}

/**
 * Request variant for protocols whose HTTP status is part of the contract.
 * Authentication, tenant and role still come exclusively from the server-side
 * session cookie; the browser contributes only the CSRF token issued by it.
 */
export async function apiResponse<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const { response, body } = await request<T>(path, init)
  return { status: response.status, body }
}

export async function api<T>(path: string, init: RequestInit = {}, acceptDeclaredResult = false): Promise<T> {
  const { response, body } = await request<T>(path, init)
  if (!response.ok && !(acceptDeclaredResult && typeof body === 'object' && body !== null && 'state' in body)) {
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  if (body === null) throw new Error(`HTTP ${response.status}`)
  return body
}
