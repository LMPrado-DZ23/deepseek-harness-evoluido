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
 * `Secure`). Os dois NUNCA são aceitos ao mesmo tempo: aceitar o nome fraco
 * quando há TLS reabriria o buraco inteiro.
 *
 * ESTE COMENTÁRIO JÁ AFIRMOU ALGO FALSO, e a correção fica registrada. Ele
 * dizia que "nesse modo não existe subdomínio irmão de onde atacar". Existe: a
 * topologia local da ADR-012 serve o Studio em `studio.dz23.localhost` e cada
 * prévia em `p-<hex>.dz23.localhost`, tudo em HTTP claro — e o aplicativo
 * GERADO, que ninguém leu, roda dentro da prévia. A jornada em navegador real
 * prova a gravação do cookie sombra a partir de lá. O que impede o roubo de
 * conta continua sendo recusar a ambiguidade; o que impede a recusa de virar
 * tranca é `shadowCookieDeletions`, logo abaixo.
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

/**
 * As instruções que apagam um cookie de sessão gravado por um vizinho.
 *
 * O navegador manda os dois cookies no MESMO cabeçalho e não diz qual é o do
 * próprio host: por isso o servidor recusa a ambiguidade. Recusar e parar por
 * aí, porém, troca o roubo de conta por uma TRANCA — qualquer aplicativo
 * gerado rodando numa prévia irmã derruba a dona do Studio para fora, e ela
 * não tem gesto nenhum para se recuperar.
 *
 * A saída é apagar o cookie do vizinho e não o do host. Uma remoção com
 * `Domain` casa SÓ o cookie de domínio; o cookie host-only, que é o legítimo,
 * não é alcançado por ela. Depois disso o pedido seguinte tem um valor só e
 * volta a funcionar. O atacante pode plantar de novo, e aí paga outro pedido
 * recusado — o que ele não consegue é nem entrar na conta, nem manter a pessoa
 * de fora.
 *
 * Emite uma remoção por domínio-pai possível: quem planta pode estar num irmão
 * (`p-x.dz23.localhost` → `dz23.localhost`) ou num primo mais acima. Domínio
 * que o navegador recusar é simplesmente ignorado por ele.
 * @param host - o cabeçalho `Host` do pedido, com porta ou sem.
 * @param name - o nome do cookie de sessão desta instalação.
 * @returns os valores de `Set-Cookie`, vazio quando não há domínio-pai.
 */
export function shadowCookieDeletions(host: string | undefined, name: string): readonly string[] {
  const bare = (host ?? '').split(':')[0]!.trim().toLowerCase()
  // Endereço numérico e IPv6 não têm domínio-pai: `Domain=0.0.1` seria recusado
  // pelo navegador, e pedir isso só encheria o cabeçalho de lixo.
  if (bare === '' || bare.includes('[') || /^[0-9.]+$/u.test(bare)) return []
  const labels = bare.split('.')
  const deletions: string[] = []
  for (let index = 1; index + 1 < labels.length; index += 1) {
    deletions.push(`${name}=; Domain=${labels.slice(index).join('.')}; Path=/; Max-Age=0; SameSite=Lax`)
  }
  return deletions
}

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
