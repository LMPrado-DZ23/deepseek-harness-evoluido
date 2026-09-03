export type HealthState = { state: 'OK' | 'ATTENTION'; route: string | null; builder: 'OK' | 'BLOCKED_EXTERNAL'; disk: 'OK' | 'ATTENTION' }
export type ProjectSummary = { project_id: string; name: string; state: string }

function csrf(): string {
  const row = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dz23_studio_csrf='))
  return row === undefined ? '' : decodeURIComponent(row.slice(row.indexOf('=') + 1))
}

export async function api<T>(path: string, init: RequestInit = {}, acceptDeclaredResult = false): Promise<T> {
  const bodyHeaders = init.body === undefined ? {} : typeof init.body === 'string'
    ? { 'content-type': 'application/json', 'x-dz23-csrf': csrf() }
    : { 'x-dz23-csrf': csrf() }
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
