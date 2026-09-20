export const CURRENT_SESSION_ENDPOINT = '/api/studio/identity/session'

export type CurrentSessionMode = 'authenticated' | 'personal' | 'unavailable'

/** O escopo vem do servidor; nao e inferido de cookie, nome ou ultimo projeto. */
export async function currentSessionScope(
  fetchSession: (input: string, init: RequestInit) => Promise<Response> = (input, init) => window.fetch(input, init),
): Promise<readonly [string, string, string] | null> {
  try {
    const response = await fetchSession(CURRENT_SESSION_ENDPOINT, { method: 'GET', credentials: 'same-origin' })
    if (!response.ok) return null
    const body = await response.json() as { principal?: { userId?: unknown; orgId?: unknown; tenantId?: unknown } }
    const principal = body?.principal
    if (typeof principal?.userId !== 'string' || principal.userId === ''
      || typeof principal.orgId !== 'string' || principal.orgId === ''
      || typeof principal.tenantId !== 'string' || principal.tenantId === '') return null
    return [principal.userId, principal.orgId, principal.tenantId]
  } catch { return null }
}

/**
 * Quem está na sessão, para o rodapé do trilho.
 *
 * É o `userId` que o servidor devolve, e NADA além dele: o endpoint de sessão
 * não carrega nome nem e-mail, e acrescentar um deles ao contrato para deixar
 * o avatar mais bonito seria uma decisão de privacidade tomada por conta de um
 * detalhe visual. `null` quando não há sessão ou a leitura falhou.
 * @param fetchSession - injetável para o teste não depender de `window`.
 * @returns o identificador de quem está na sessão, ou `null`.
 */
export async function currentSessionPrincipal(
  fetchSession: (input: string, init: RequestInit) => Promise<Response> = (input, init) => window.fetch(input, init),
): Promise<string | null> {
  try {
    const response = await fetchSession(CURRENT_SESSION_ENDPOINT, { method: 'GET', credentials: 'same-origin' })
    if (!response.ok) return null
    const body = await response.json().catch(() => null) as { readonly principal?: { readonly userId?: unknown } } | null
    const userId = body?.principal?.userId
    return typeof userId === 'string' && userId !== '' ? userId : null
  } catch {
    return null
  }
}

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
