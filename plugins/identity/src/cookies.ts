export const SESSION_COOKIE = 'dz23_studio_session'
/** Legacy marker expired on logout; clients no longer read cookies for login generation. */
export const SESSION_GENERATION_COOKIE = 'dz23_studio_session_generation'
/** Legacy name retained only so existing client cookies can be expired. */
export const CSRF_COOKIE = 'dz23_studio_csrf'

export function parseCookieValues(header: string | undefined, name: string): readonly string[] {
  if (header === undefined) return []
  return header.split(';').flatMap(part => {
    const at = part.indexOf('=')
    if (at < 1 || part.slice(0, at).trim() !== name) return []
    const raw = part.slice(at + 1).trim()
    try { return [decodeURIComponent(raw)] } catch { return [] }
  })
}

export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (header === undefined) return {}
  return Object.fromEntries(header.split(';').map(part => {
    const at = part.indexOf('=')
    if (at < 1) return [part.trim(), '']
    const key = part.slice(0, at).trim()
    const raw = part.slice(at + 1).trim()
    try {
      return [key, decodeURIComponent(raw)]
    } catch {
      return [key, '']
    }
  }))
}
