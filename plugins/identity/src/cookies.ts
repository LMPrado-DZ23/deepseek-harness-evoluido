export const SESSION_COOKIE = 'dz23_studio_session'

/**
 * O nome do cookie de sessão quando há TLS — com o prefixo `__Host-`.
 *
 * O prefixo não é enfeite: o navegador RECUSA gravar um cookie `__Host-` que
 * traga `Domain`, que não traga `Secure` ou cujo `Path` não seja `/`. É
 * exatamente isso que fecha o ataque de cookie sombra: sem ele, quem controlar
 * um subdomínio irmão (ou conseguir injetar num HTTP em texto claro) grava
 * `dz23_studio_session=<token dele>; Domain=.dominio.exemplo`, o navegador da
 * vítima passa a mandar DOIS cookies com o mesmo nome, e a vítima acaba
 * navegando dentro da sessão do atacante — e registrando a chave de acesso do
 * próprio dispositivo na conta dele.
 *
 * O nome SEM prefixo continua existindo porque em modo pessoal o Studio serve
 * em `http://127.0.0.1`, e ali o navegador recusaria o `__Host-` (não há
 * `Secure`). Nesse modo não existe subdomínio irmão de onde atacar, então o
 * nome fraco é proporcional. Os dois NUNCA são aceitos ao mesmo tempo: aceitar
 * o nome fraco quando há TLS reabriria o buraco inteiro.
 */
export const SECURE_SESSION_COOKIE = '__Host-dz23_studio_session'

/**
 * O nome do cookie de sessão para esta configuração.
 * @param secure - se os cookies são emitidos com `Secure`.
 * @returns o nome a emitir e a aceitar — um só, nunca os dois.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE
}
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
