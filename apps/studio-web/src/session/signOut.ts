import { CSRF_STORAGE_KEY, csrfToken } from '../api'
import { HARNESS_SELECTION_STORAGE_KEY } from '../assistant/assistantLaunch'
import { forgetSavedShell } from '../pwa/register'
import { publishSessionRevocation } from './sessionRevocation'

export const SIGN_OUT_ENDPOINT = '/api/studio/identity/logout'

interface BrowserStorage {
  removeItem(key: string): void
}

export interface SignOutPort {
  fetch(input: string, init: RequestInit): Promise<Response>
  getCsrf(): Promise<string>
  forgetShell(): Promise<unknown>
  sessionStorage: BrowserStorage
  localStorage: BrowserStorage
  notifyRevoked(): void
  redirect(path: string): void
}

function removeOwnedKey(storage: BrowserStorage, key: string): void {
  try { storage.removeItem(key) } catch { /* the server session is already revoked */ }
}

export async function clearOwnedBrowserSessionState(port: Pick<SignOutPort, 'forgetShell' | 'sessionStorage' | 'localStorage'>): Promise<void> {
  await port.forgetShell().catch(() => undefined)
  removeOwnedKey(port.sessionStorage, CSRF_STORAGE_KEY)
  removeOwnedKey(port.localStorage, HARNESS_SELECTION_STORAGE_KEY)
}

export async function signOutCurrentSession(port: SignOutPort): Promise<void> {
  const response = await port.fetch(SIGN_OUT_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-dz23-csrf': await port.getCsrf() },
  })
  const body = await response.json().catch(() => null) as { signed_out?: unknown; error?: unknown } | null
  if (!response.ok || body?.signed_out !== true) {
    throw new Error(typeof body?.error === 'string' && body.error !== '' ? body.error : `HTTP ${response.status}`)
  }

  // Server revocation is authoritative. Notify sibling tabs only after this
  // proof; cleanup remains best-effort and never widens server authority.
  try { port.notifyRevoked() } catch { /* this tab still completes sign out */ }
  await clearOwnedBrowserSessionState(port)
  port.redirect('/login')
}

export function clearOwnedBrowserSessionStateInBrowser(): Promise<void> {
  return clearOwnedBrowserSessionState({
    forgetShell: () => forgetSavedShell(),
    sessionStorage: window.sessionStorage,
    localStorage: window.localStorage,
  })
}

export function signOutInBrowser(): Promise<void> {
  return signOutCurrentSession({
    fetch: (input, init) => window.fetch(input, init),
    getCsrf: csrfToken,
    forgetShell: () => forgetSavedShell(),
    sessionStorage: window.sessionStorage,
    localStorage: window.localStorage,
    notifyRevoked: () => publishSessionRevocation(),
    redirect: path => window.location.assign(path),
  })
}
