export const CURRENT_SESSION_ENDPOINT = '/api/studio/identity/session'

export type CurrentSessionMode = 'authenticated' | 'personal' | 'unavailable'

export async function currentSessionMode(
  fetchSession: (input: string, init: RequestInit) => Promise<Response> = (input, init) => window.fetch(input, init),
): Promise<CurrentSessionMode> {
  try {
    const response = await fetchSession(CURRENT_SESSION_ENDPOINT, { method: 'GET', credentials: 'same-origin' })
    if (!response.ok) return 'unavailable'
    const body = await response.json().catch(() => null) as { readonly mode?: unknown } | null
    return body?.mode === 'authenticated' || body?.mode === 'personal' ? body.mode : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
