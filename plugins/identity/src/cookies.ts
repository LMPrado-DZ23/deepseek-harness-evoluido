export const SESSION_COOKIE = 'dz23_studio_session'
export const CSRF_COOKIE = 'dz23_studio_csrf'

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
