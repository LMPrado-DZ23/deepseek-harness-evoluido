#!/usr/bin/env node
/**
 * PONTE DE SAÍDA — lado do WSL2.
 *
 * Por quê: no computador do titular o WSL2 não abre conexão nenhuma para fora
 * (medido em 19/09/2026: DNS responde, TCP e ping não saem; o adaptador
 * "Topaz Loopback" do módulo de segurança bancária quebra o NAT do WSL, e o
 * modo espelhado não espelha o Wi-Fi). O Windows sai normalmente.
 *
 * Como: este processo escuta SÓ em 127.0.0.1 do WSL, em duas portas.
 * - `PORTA_PROXY` é um proxy HTTP CONNECT para os programas do WSL
 *   (HTTPS_PROXY). Ele não disca para fora: pede ao agente do Windows.
 * - `PORTA_AGENTE` é onde o agente do Windows se liga (pelo repasse de
 *   localhost do WSL, que já funciona) — primeiro um canal de controle, depois
 *   um canal de dados por conexão pedida.
 * Só hosts da LISTA saem; o resto recebe 403. O conteúdo é TLS de ponta a
 * ponta: a ponte não vê chave, pedido nem resposta.
 */
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'

export const PORTA_PROXY = Number(process.env.FRIGG_PONTE_PROXY ?? 18080)
export const PORTA_AGENTE = Number(process.env.FRIGG_PONTE_AGENTE ?? 18081)
export const HOSTS_PERMITIDOS = new Set((process.env.FRIGG_PONTE_HOSTS ?? [
  'api.deepseek.com', 'api.mistral.ai', 'openrouter.ai', 'api.groq.com', 'api.cerebras.ai',
  'api.together.xyz', 'api.fireworks.ai', 'api.x.ai', 'api.sambanova.ai', 'integrate.api.nvidia.com',
  'generativelanguage.googleapis.com', 'api.openai.com', 'api.anthropic.com',
  'duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com',
  // Para (re)construir a imagem do construtor: a base fixada por digest, o
  // Node e o pnpm fixados por sha256 no Dockerfile. As camadas da MCR vêm de
  // um host regional (`<regiao>.data.mcr.microsoft.com`): a entrada com ponto
  // no começo aceita os subdomínios, e SÓ eles.
  'mcr.microsoft.com', '.data.mcr.microsoft.com', 'nodejs.org', 'registry.npmjs.org',
].join(',')).split(',').map(h => h.trim().toLowerCase()).filter(Boolean))
const TOKEN = process.env.FRIGG_PONTE_TOKEN ?? randomBytes(24).toString('hex')

/**
 * O destino de um CONNECT, se ele pode sair.
 * @param {string} alvo - `host:porta`.
 * @param {ReadonlySet<string>} permitidos - a lista.
 * @returns {{ host: string, porta: number } | undefined}
 */
export function destinoPermitido(alvo, permitidos) {
  const achado = /^([a-z0-9.-]+):(\d{1,5})$/iu.exec(alvo ?? '')
  if (achado === null) return undefined
  const host = achado[1].toLowerCase(); const porta = Number(achado[2])
  if (porta !== 443 || !hostNaLista(host, permitidos)) return undefined
  return { host, porta }
}

/**
 * O host está na lista? Uma entrada `.dominio` aceita qualquer subdomínio
 * dele, e não o próprio domínio nem um nome que só TERMINE igual
 * (`xdata.mcr.microsoft.com` não passa por `.data.mcr.microsoft.com`).
 * @param {string} host - o host, em minúsculas.
 * @param {ReadonlySet<string>} permitidos - a lista.
 * @returns {boolean}
 */
export function hostNaLista(host, permitidos) {
  if (permitidos.has(host)) return true
  for (const entrada of permitidos) {
    if (entrada.startsWith('.') && host.endsWith(entrada) && host.length > entrada.length && /^[a-z0-9-]+$/u.test(host.slice(0, -entrada.length))) return true
  }
  return false
}

let controle = null
const esperando = new Map()

const agente = createServer(socket => {
  socket.once('data', primeiro => {
    const linha = primeiro.toString('utf8').split('\n')[0]
    const [tipo, token, id] = linha.trim().split(' ')
    if (token !== TOKEN) { socket.destroy(); return }
    if (tipo === 'CONTROLE') {
      controle?.destroy(); controle = socket
      socket.on('close', () => { if (controle === socket) controle = null })
      console.log(JSON.stringify({ evento: 'agente-ligado' }))
      return
    }
    if (tipo === 'DADOS' && esperando.has(id)) {
      const cliente = esperando.get(id); esperando.delete(id)
      const resto = primeiro.subarray(Buffer.byteLength(linha) + 1)
      cliente.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (resto.length > 0) cliente.write(resto)
      cliente.pipe(socket); socket.pipe(cliente)
      cliente.on('error', () => socket.destroy()); socket.on('error', () => cliente.destroy())
      return
    }
    socket.destroy()
  })
})

const proxy = createServer(cliente => {
  cliente.once('data', pedido => {
    const cabecalho = pedido.toString('latin1')
    const achado = /^CONNECT (\S+) HTTP\/1\.[01]\r\n/u.exec(cabecalho)
    const destino = achado === null ? undefined : destinoPermitido(achado[1], HOSTS_PERMITIDOS)
    if (destino === undefined) { cliente.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    if (controle === null) { cliente.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
    const id = randomBytes(8).toString('hex')
    esperando.set(id, cliente)
    setTimeout(() => { if (esperando.delete(id)) cliente.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n') }, 20_000)
    controle.write(`ABRIR ${id} ${destino.host} ${destino.porta}\n`)
  })
  cliente.on('error', () => {})
})

if (process.argv[1]?.endsWith('ponte-wsl.mjs')) {
  // Anuncia só depois de as DUAS portas estarem ouvindo: quem lê o anúncio
  // (o roteiro de subida, o teste) conecta em seguida.
  const ouvir = (servidor, porta) => new Promise((pronto, falhou) => { servidor.once('error', falhou); servidor.listen(porta, '127.0.0.1', pronto) })
  await Promise.all([ouvir(agente, PORTA_AGENTE), ouvir(proxy, PORTA_PROXY)])
  console.log(JSON.stringify({ evento: 'ponte-de-pe', proxy: PORTA_PROXY, agente: PORTA_AGENTE, hosts: HOSTS_PERMITIDOS.size }))
}
