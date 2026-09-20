#!/usr/bin/env node
/**
 * A BORDA LOCAL da prévia, para a instalação PESSOAL (`pnpm studio`).
 *
 * A prévia foi desenhada atrás de uma borda (Caddy, `deploy/caddy`): o
 * aplicativo gerado abre num host próprio, `p-<24 hex>.dz23.localhost`, e a
 * borda reescreve o caminho para `/__dz23/preview-gateway` e prova quem é com o
 * cabeçalho `X-DZ23-Edge`. Sem borda, o harness responde 404 — de propósito.
 *
 * Na instalação pessoal não havia borda: o Caddy do produto é compilado com um
 * módulo baixado do GitHub no momento da construção, e a pessoa abria o FRIGG
 * direto no harness. Resultado medido em 19/09/2026: a jornada chegava ao
 * aplicativo verificado e não havia como abri-lo.
 *
 * Esta borda faz SÓ o que a do Caddy faz para estes dois hosts, e nada mais:
 *
 * - `studio.dz23.localhost:<porta>` → o harness, com o cabeçalho de borda
 *   REMOVIDO (quem manda não é a borda). O Studio precisa morar neste host,
 *   e não em `localhost`, porque o cookie de admissão da prévia só é de
 *   primeira parte quando os dois hosts são do mesmo site (`dz23.localhost`).
 * - `p-<24 hex>.dz23.localhost:<porta>` → o portão da prévia, com o segredo.
 * - qualquer outro host → 421.
 *
 * Escuta SÓ em 127.0.0.1. Não usa 443, não mexe em `hosts` (o Chrome resolve
 * `*.localhost` para o loopback sozinho) e não tem TLS para interceptar.
 */
import { request as httpRequest, createServer } from 'node:http'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'

export const HOST_DO_STUDIO = 'studio.dz23.localhost'
const HOST_DA_PREVIA = /^p-[a-f0-9]{24}\.dz23\.localhost$/u
const PREFIXO_DO_PORTAO = '/__dz23/preview-gateway'

/** Cabeçalhos que o cliente NUNCA escolhe, nos dois destinos. */
const SEMPRE_REMOVIDOS = ['x-dz23-edge']
/** E os que a borda do Caddy tira da prévia (`dz23_preview_edge`). */
const REMOVIDOS_DA_PREVIA = ['authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']

/**
 * Para onde vai um pedido.
 * @param {string | undefined} host - o cabeçalho Host, como veio.
 * @param {string | undefined} url - o alvo do pedido.
 * @param {number} porta - a porta em que a borda escuta.
 * @returns {{ destino: 'studio' | 'previa', caminho: string } | { destino: 'recusar' }}
 */
export function rotaDaBorda(host, url, porta) {
  if (typeof host !== 'string' || typeof url !== 'string' || !url.startsWith('/')) return { destino: 'recusar' }
  const separado = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/u.exec(host.toLowerCase())
  if (separado === null) return { destino: 'recusar' }
  const [, nome, portaDoHost] = separado
  if (portaDoHost !== undefined && Number(portaDoHost) !== porta) return { destino: 'recusar' }
  if (nome === HOST_DO_STUDIO) return { destino: 'studio', caminho: url }
  if (HOST_DA_PREVIA.test(nome)) return { destino: 'previa', caminho: `${PREFIXO_DO_PORTAO}${url}` }
  return { destino: 'recusar' }
}

/**
 * Para onde o CONVITE leva depois de entrar.
 *
 * O endereço que o `pnpm studio` imprime é o convite do harness
 * (`/?token=…`), que grava o cookie e manda para `/` — a tela do HARNESS, e
 * não a do FRIGG. Medido em 19/09/2026: quem abria o endereço impresso caía
 * em "DeepSeek Harness · Choose workspace". Só esse redirecionamento, e só no
 * host do Studio, passa a levar para `/studio/`; o resto da tela do harness
 * continua onde está (a página de modelos mora lá).
 * @param {'studio' | 'previa'} destino - o destino do pedido.
 * @param {string} caminho - o caminho pedido.
 * @param {number} status - o status que o harness devolveu.
 * @param {string | string[] | undefined} local - o cabeçalho Location.
 * @returns {string | undefined} o Location novo, ou `undefined` para manter.
 */
export function destinoDoConvite(destino, caminho, status, local) {
  if (destino !== 'studio' || status < 300 || status > 399 || local !== '/') return undefined
  const url = new URL(caminho, 'http://borda.invalid')
  return url.pathname === '/' && url.searchParams.has('token') ? '/studio/' : undefined
}

/**
 * Os cabeçalhos que seguem para o harness.
 * @param {'studio' | 'previa'} destino - o destino.
 * @param {Record<string, string | string[] | undefined>} cabecalhos - os do cliente.
 * @param {string} segredo - o segredo da borda.
 * @returns {Record<string, string | string[]>} os cabeçalhos a enviar.
 */
export function cabecalhosParaOHarness(destino, cabecalhos, segredo) {
  const fora = new Set([...SEMPRE_REMOVIDOS, ...(destino === 'previa' ? REMOVIDOS_DA_PREVIA : [])])
  const saida = {}
  for (const [nome, valor] of Object.entries(cabecalhos)) {
    if (valor === undefined || fora.has(nome.toLowerCase())) continue
    saida[nome] = valor
  }
  if (destino === 'previa') saida['x-dz23-edge'] = segredo
  return saida
}

/**
 * O segredo, conferido como o harness o confere (`requiredSecret`).
 * @param {string | undefined} valor - o conteúdo.
 * @returns {string} o segredo.
 */
export function segredoValido(valor) {
  const limpo = typeof valor === 'string' ? valor.trim() : ''
  if (limpo.length < 32 || limpo.length > 512) throw new Error('DZ23_EDGE_SECRET ausente ou fora do tamanho (32 a 512).')
  return limpo
}

/**
 * Sobe a borda.
 * @param {{ porta: number, harnessHost: string, harnessPorta: number, segredo: string }} opcoes
 * @returns {Promise<import('node:http').Server>}
 */
export function iniciarBorda({ porta, harnessHost, harnessPorta, segredo }) {
  // A porta em que a borda de fato escuta (0 pede uma livre, nos testes).
  const portaReal = () => servidor.address()?.port ?? porta
  const servidor = createServer((pedido, resposta) => {
    const rota = rotaDaBorda(pedido.headers.host, pedido.url, portaReal())
    if (rota.destino === 'recusar') {
      resposta.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      resposta.end('Host inválido.')
      return
    }
    const saida = httpRequest({
      host: harnessHost, port: harnessPorta, method: pedido.method, path: rota.caminho,
      headers: cabecalhosParaOHarness(rota.destino, pedido.headers, segredo),
    }, recebida => {
      const convite = destinoDoConvite(rota.destino, rota.caminho, recebida.statusCode ?? 0, recebida.headers.location)
      resposta.writeHead(recebida.statusCode ?? 502, convite === undefined ? recebida.headers : { ...recebida.headers, location: convite })
      recebida.pipe(resposta)
    })
    saida.on('error', () => {
      if (!resposta.headersSent) resposta.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      resposta.end('O FRIGG não respondeu.')
    })
    pedido.pipe(saida)
  })
  // WebSocket do Studio: o túnel é aberto só para o host do Studio.
  servidor.on('upgrade', (pedido, soquete, cabeca) => {
    const rota = rotaDaBorda(pedido.headers.host, pedido.url, portaReal())
    if (rota.destino !== 'studio') { soquete.destroy(); return }
    const destino = connect(harnessPorta, harnessHost, () => {
      const cabecalhos = cabecalhosParaOHarness('studio', pedido.headers, segredo)
      const linhas = [`${pedido.method} ${rota.caminho} HTTP/1.1`]
      for (const [nome, valor] of Object.entries(cabecalhos)) {
        for (const item of Array.isArray(valor) ? valor : [valor]) linhas.push(`${nome}: ${item}`)
      }
      destino.write(`${linhas.join('\r\n')}\r\n\r\n`)
      if (cabeca.length > 0) destino.write(cabeca)
      destino.pipe(soquete); soquete.pipe(destino)
    })
    destino.on('error', () => { soquete.destroy() })
    soquete.on('error', () => { destino.destroy() })
  })
  return new Promise((resolver, rejeitar) => {
    servidor.once('error', rejeitar)
    servidor.listen(porta, '127.0.0.1', () => { resolver(servidor) })
  })
}

const chamadoDiretamente = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (chamadoDiretamente) {
  const porta = Number(process.env.FRIGG_EDGE_PORT ?? '8088')
  const harnessPorta = Number(process.env.FRIGG_HARNESS_PORT ?? '3080')
  await iniciarBorda({ porta, harnessHost: '127.0.0.1', harnessPorta, segredo: segredoValido(process.env.DZ23_EDGE_SECRET) })
  process.stdout.write(`borda local: http://${HOST_DO_STUDIO}:${String(porta)}\n`)
}
