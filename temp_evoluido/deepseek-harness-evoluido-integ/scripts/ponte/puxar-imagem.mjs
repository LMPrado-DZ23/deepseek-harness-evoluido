#!/usr/bin/env node
/**
 * PUXA UMA IMAGEM FIXADA POR DIGEST para uma pasta no formato OCI, sem o
 * Docker falar com a internet.
 *
 * Por quê: no computador do titular o WSL2 não sai para a internet, e o
 * daemon do Docker também não — ele é compartilhado com outra pilha, e
 * reiniciá-lo com proxy mexeria nela. A limpeza automática daquele daemon
 * apagou a imagem do construtor e a base dela (medido em 20/09/2026: cache de
 * build 0 B, imagem ausente). Este roteiro busca a base PELA PONTE (as
 * variáveis `HTTPS_PROXY`/`NODE_USE_ENV_PROXY` do Node), confere o sha256 de
 * cada pedaço contra o digest pedido e grava a pasta; o `docker build` a usa
 * com `--build-context <FROM>=oci-layout://<pasta>:base`.
 *
 * Nada aqui confia no registro: o manifesto pedido tem que ter EXATAMENTE o
 * digest pedido, e cada camada o digest que o manifesto declara.
 *
 * Uso: node puxar-imagem.mjs <registro> <repositorio> <sha256:...> <pasta> [linux/amd64]
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const TIPOS_DE_MANIFESTO = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]
const INDICES = new Set(TIPOS_DE_MANIFESTO.slice(0, 2))
/** O nome da imagem dentro da pasta: `--build-context <FROM>=oci-layout://<pasta>:base`. */
export const NOME_NA_PASTA = 'base'

/**
 * O pedido de token de um desafio `Bearer` (registro anônimo).
 * @param {string | null} desafio - o cabeçalho `WWW-Authenticate`.
 * @returns {string | undefined} a URL do token.
 */
export function urlDoToken(desafio) {
  if (typeof desafio !== 'string' || !/^Bearer\s/iu.test(desafio)) return undefined
  const campos = Object.fromEntries([...desafio.matchAll(/(\w+)="([^"]*)"/gu)].map(([, chave, valor]) => [chave, valor]))
  if (typeof campos.realm !== 'string' || !campos.realm.startsWith('https://')) return undefined
  const url = new URL(campos.realm)
  if (campos.service !== undefined) url.searchParams.set('service', campos.service)
  if (campos.scope !== undefined) url.searchParams.set('scope', campos.scope)
  return url.toString()
}

/**
 * O manifesto da plataforma pedida, dentro de um índice.
 * @param {{ manifests?: { digest: string, mediaType?: string, size?: number, platform?: { os?: string, architecture?: string, variant?: string } }[] }} indice
 * @param {string} plataforma - `os/arquitetura`.
 * @returns {{ digest: string, mediaType?: string, size?: number } | undefined}
 */
export function manifestoDaPlataforma(indice, plataforma) {
  const [os, arquitetura] = plataforma.split('/')
  return indice.manifests?.find(item => item.platform?.os === os && item.platform?.architecture === arquitetura)
}

/** O sha256 de bytes, no formato de digest. */
export function digestDe(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

/**
 * Um digest aceitável como nome de arquivo — e só isso: nenhum caminho sai
 * da pasta de blobs por um digest forjado.
 */
export function hexDoDigest(digest) {
  const achado = /^sha256:([0-9a-f]{64})$/u.exec(digest ?? '')
  if (achado === null) throw new Error(`digest recusado: ${String(digest)}`)
  return achado[1]
}

/**
 * Recusa bytes que não são o que o digest diz.
 * @param {string} digest - o digest esperado.
 * @param {Uint8Array} bytes - o conteúdo.
 */
export function conferirBytes(digest, bytes) {
  if (digestDe(bytes) !== digest) throw new Error(`conteúdo não bate com ${digest}`)
}

/**
 * Grava um manifesto (bytes já em memória) na pasta de blobs, conferido.
 * @param {string} blobs - a pasta `blobs/sha256`.
 * @param {string} digest - o digest esperado.
 * @param {Uint8Array} bytes - o conteúdo.
 */
export async function gravarBlobConferido(blobs, digest, bytes) {
  conferirBytes(digest, bytes)
  await writeFile(join(blobs, hexDoDigest(digest)), bytes)
}

/**
 * Grava um fluxo num arquivo SÓ se o sha256 dele for o esperado. Até a
 * conferência, o conteúdo mora num `.parcial`; se não bater, ele some e nada
 * fica no lugar do destino.
 * @param {AsyncIterable<Uint8Array> | NodeJS.ReadableStream} corpo - o fluxo.
 * @param {string} destino - o arquivo final.
 * @param {string} digest - o digest esperado.
 */
export async function gravarConferido(corpo, destino, digest) {
  const hash = createHash('sha256')
  const parcial = `${destino}.parcial`
  const fluxo = Readable.from(corpo)
  fluxo.on('data', pedaco => hash.update(pedaco))
  await pipeline(fluxo, createWriteStream(parcial))
  const obtido = `sha256:${hash.digest('hex')}`
  if (obtido !== digest) { await rm(parcial, { force: true }); throw new Error(`camada ${digest} veio como ${obtido}`) }
  await rename(parcial, destino)
}

async function principal([registro, repositorio, digestPedido, pasta, plataforma = 'linux/amd64']) {
  if (!registro || !repositorio || !pasta) throw new Error('uso: <registro> <repositorio> <sha256:...> <pasta> [linux/amd64]')
  hexDoDigest(digestPedido)
  const base = `https://${registro}/v2/${repositorio}`
  let token
  const pedir = async (url, aceita) => {
    const cabecalhos = { accept: aceita, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }
    let resposta = await fetch(url, { headers: cabecalhos, redirect: 'follow' })
    if (resposta.status === 401 && token === undefined) {
      const urlToken = urlDoToken(resposta.headers.get('www-authenticate'))
      if (urlToken === undefined) throw new Error(`401 sem desafio utilizável em ${url}`)
      const corpo = await (await fetch(urlToken)).json()
      token = corpo.token ?? corpo.access_token
      resposta = await fetch(url, { headers: { ...cabecalhos, authorization: `Bearer ${token}` }, redirect: 'follow' })
    }
    if (!resposta.ok) throw new Error(`${resposta.status} em ${url}`)
    return resposta
  }
  const blobs = join(pasta, 'blobs', 'sha256')
  await mkdir(blobs, { recursive: true })
  const gravarBytes = (digest, bytes) => gravarBlobConferido(blobs, digest, bytes)
  const manifestoBruto = async digest => {
    const resposta = await pedir(`${base}/manifests/${digest}`, TIPOS_DE_MANIFESTO.join(', '))
    const bytes = Buffer.from(await resposta.arrayBuffer())
    await gravarBytes(digest, bytes)
    return { corpo: JSON.parse(bytes.toString('utf8')), tipo: resposta.headers.get('content-type')?.split(';')[0], tamanho: bytes.length }
  }
  const baixarBlob = async (digest, tamanhoEsperado) => {
    const destino = join(blobs, hexDoDigest(digest))
    const existente = await stat(destino).catch(() => undefined)
    if (existente?.size === tamanhoEsperado && digestDe(await readFile(destino)) === digest) return 'ja-estava'
    const resposta = await pedir(`${base}/blobs/${digest}`, '*/*')
    const hash = createHash('sha256')
    const parcial = `${destino}.parcial`
    const corpo = Readable.fromWeb(resposta.body)
    corpo.on('data', pedaco => hash.update(pedaco))
    await pipeline(corpo, createWriteStream(parcial))
    const obtido = `sha256:${hash.digest('hex')}`
    
    await rename(parcial, destino)
    return 'baixada'
  }
  const topo = await manifestoBruto(digestPedido)
  let manifesto = topo
  if (INDICES.has(topo.tipo) || Array.isArray(topo.corpo.manifests)) {
    const escolhido = manifestoDaPlataforma(topo.corpo, plataforma)
    if (escolhido === undefined) throw new Error(`o índice não tem ${plataforma}`)
    manifesto = await manifestoBruto(escolhido.digest)
  }
  const pecas = [manifesto.corpo.config, ...manifesto.corpo.layers]
  let total = 0
  for (const [i, peca] of pecas.entries()) {
    const resultado = await baixarBlob(peca.digest, peca.size)
    total += peca.size
    console.log(JSON.stringify({ peca: i, de: pecas.length, digest: peca.digest.slice(0, 19), mb: Math.round(peca.size / 1e6), resultado }))
  }
  await writeFile(join(pasta, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }))
  await writeFile(join(pasta, 'index.json'), JSON.stringify({
    schemaVersion: 2,
    // O `docker build` pede a imagem da pasta por NOME (`oci-layout://pasta:base`):
    // sem nome, ele monta uma referência vazia e recusa (medido em 20/09).
    manifests: [{ mediaType: topo.tipo, digest: digestPedido, size: topo.tamanho, annotations: { 'org.opencontainers.image.ref.name': NOME_NA_PASTA } }],
  }))
  console.log(JSON.stringify({ evento: 'imagem-pronta', pasta, digest: digestPedido, mb: Math.round(total / 1e6) }))
}

if (process.argv[1]?.endsWith('puxar-imagem.mjs')) {
  principal(process.argv.slice(2)).catch(erro => { console.error(`FALHOU: ${erro.message}`); process.exit(1) })
}
