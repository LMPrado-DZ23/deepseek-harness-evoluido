import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { openDirectory, referenceOf } from '@dz23-studio/integration-hub'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

/**
 * OS ARQUIVOS DA PASTA DE TRABALHO do agente geral: mandar, listar e baixar.
 *
 * Pedido do titular em 19/09/2026 ("não tem opção de anexar arquivo"). O agente
 * lê e escreve na pasta do espaço (`pastaDoEspaco`), mas a pessoa não tinha
 * como pôr um arquivo lá nem levar embora o que ele produziu. Aqui:
 *
 * - QUALQUER tipo de arquivo entra (PDF, planilha, zip…), até 50 MB, em
 *   `enviados/` — nunca por cima de outro, e nunca fora da pasta;
 * - a lista mostra o que existe na pasta, sem seguir atalhos (links);
 * - o download sai como ANEXO (`application/octet-stream`), para o navegador
 *   nunca interpretar um HTML que o agente escreveu como página do FRIGG.
 */

export const ASSISTANT_FILES_PATH = '/studio/assistant/files'
export const ASSISTANT_FILES_DOWNLOAD_PATH = '/studio/assistant/files/baixar'
export const ARQUIVO_MAXIMO_BYTES = 50 * 1024 * 1024
export const PASTA_DOS_ENVIADOS = 'enviados'
const MAXIMO_NA_LISTA = 500
const PROFUNDIDADE_MAXIMA = 4

export class ArquivoRecusado extends Error {
  constructor(readonly code: 'NOME' | 'GRANDE' | 'FORA' | 'AUSENTE', message: string) { super(message) }
}

/**
 * Um nome de arquivo que não vira caminho: sem barras, sem controle, sem `..`.
 * @param nome - o que o navegador mandou.
 * @returns o nome limpo.
 */
export function nomeSeguro(nome: string): string {
  const limpo = basename(nome.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f/:*?"<>|]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 120)
  if (limpo === '') throw new ArquivoRecusado('NOME', 'nome')
  return limpo
}

export interface ArquivoDaPasta {
  readonly caminho: string
  readonly bytes: number
  readonly alterado_em: string
}

/**
 * O que existe na pasta, sem seguir links, até 500 itens.
 * @param pasta - a pasta de trabalho (absoluta).
 * @returns os arquivos, do mais novo para o mais velho.
 */
export async function listarArquivos(pasta: string): Promise<{ readonly arquivos: readonly ArquivoDaPasta[]; readonly cortada: boolean }> {
  const achados: ArquivoDaPasta[] = []
  let cortada = false
  const visitar = async (diretorio: FileHandle, atual: string, relativo: string, profundidade: number): Promise<void> => {
    if (profundidade > PROFUNDIDADE_MAXIMA || cortada) return
    const entradas = await readdir(referenceOf(diretorio, atual), { withFileTypes: true })
    for (const entrada of entradas) {
      if (achados.length >= MAXIMO_NA_LISTA) { cortada = true; return }
      if (entrada.name.startsWith('.parcial-')) continue
      const completo = join(referenceOf(diretorio, atual), entrada.name)
      const caminho = relativo === '' ? entrada.name : `${relativo}/${entrada.name}`
      if (entrada.isSymbolicLink()) continue
      if (entrada.isDirectory()) {
        const filho = await openDirectory(completo)
        if (filho !== undefined) {
          try { await visitar(filho, completo, caminho, profundidade + 1) } finally { await filho.close() }
        }
        continue
      }
      if (!entrada.isFile()) continue
      let info: Awaited<ReturnType<typeof lstat>>
      try { info = await lstat(completo) } catch (erro) {
        if ((erro as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw erro
      }
      if (!info.isFile()) continue
      achados.push({ caminho, bytes: Number(info.size), alterado_em: info.mtime.toISOString() })
    }
  }
  const raiz = await openDirectory(pasta)
  if (raiz === undefined) throw new ArquivoRecusado('FORA', 'fora')
  try { await visitar(raiz, pasta, '', 0) } finally { await raiz.close() }
  achados.sort((a, b) => b.alterado_em.localeCompare(a.alterado_em) || a.caminho.localeCompare(b.caminho))
  return { arquivos: achados, cortada }
}

/**
 * Grava um arquivo enviado em `enviados/`, sem sobrescrever nada.
 *
 * Os bytes vão primeiro para um arquivo PARCIAL; só um envio inteiro e dentro
 * do teto ganha o nome final. Um envio grande demais é interrompido e o parcial
 * — que só este envio criou — sai.
 * @param pasta - a pasta de trabalho.
 * @param nome - o nome pedido.
 * @param corpo - os bytes.
 * @param limite - o teto.
 * @returns o caminho relativo gravado.
 */
export async function gravarEnviado(pasta: string, nome: string, corpo: NodeJS.ReadableStream, limite = ARQUIVO_MAXIMO_BYTES): Promise<string> {
  const limpo = nomeSeguro(nome)
  const raiz = await openDirectory(pasta)
  if (raiz === undefined) throw new ArquivoRecusado('FORA', 'fora')
  let diretorio: Awaited<ReturnType<typeof openDirectory>>
  let parcial: string | undefined
  let criouParcial = false
  let total = 0
  const teto = new Transform({
    transform(pedaco: Buffer, _codificacao, pronto) {
      total += pedaco.length
      if (total > limite) { pronto(new ArquivoRecusado('GRANDE', 'grande')); return }
      pronto(null, pedaco)
    },
  })
  try {
    const destino = join(referenceOf(raiz, pasta), PASTA_DOS_ENVIADOS)
    try { await mkdir(destino, { mode: 0o700 }) } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== 'EEXIST') throw erro
    }
    diretorio = await openDirectory(destino)
    if (diretorio === undefined) throw new ArquivoRecusado('FORA', 'fora')
    const identidade = await diretorio.stat()
    const conferirPasta = async (): Promise<void> => {
      const atual = await lstat(join(pasta, PASTA_DOS_ENVIADOS))
      if (!atual.isDirectory() || atual.dev !== identidade.dev || atual.ino !== identidade.ino) {
        throw new ArquivoRecusado('FORA', 'fora')
      }
    }
    await conferirPasta()
    const destinoFixado = referenceOf(diretorio, destino)
    parcial = join(destinoFixado, `.parcial-${randomUUID()}`)
    const saida = createWriteStream(parcial, { mode: 0o600, flags: 'wx' })
    saida.once('open', () => { criouParcial = true })
    await pipeline(corpo, teto, saida)
    await conferirPasta()
    const final = await publicarSemSobrescrever(parcial, destinoFixado, limpo)
    await conferirPasta()
    return `${PASTA_DOS_ENVIADOS}/${final}`
  } finally {
    try {
      if (criouParcial && parcial !== undefined) await rm(parcial, { force: true })
    } finally {
      try { await diretorio?.close() } finally { await raiz.close() }
    }
  }
}

/** link publica sem substituir: a existência e a reserva são uma operação. */
async function publicarSemSobrescrever(parcial: string, pasta: string, nome: string): Promise<string> {
  const ponto = nome.lastIndexOf('.')
  const base = ponto > 0 ? nome.slice(0, ponto) : nome
  const extensao = ponto > 0 ? nome.slice(ponto) : ''
  for (let n = 0; n < 1000; n++) {
    const candidato = n === 0 ? nome : `${base} (${String(n + 1)})${extensao}`
    try { await link(parcial, join(pasta, candidato)); return candidato } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== 'EEXIST') throw erro
    }
  }
  const candidato = `${base}-${randomUUID()}${extensao}`
  await link(parcial, join(pasta, candidato))
  return candidato
}

/**
 * Abre o arquivo dentro da pasta, sem seguir links em seus componentes.
 * No Linux/WSL cada acesso parte do descritor da pasta já aberto. Nas outras
 * plataformas valem as limitações de referenceOf/openDirectory: a comparação
 * de identidade não substitui openat contra um escritor local hostil.
 * @param pasta - a pasta de trabalho.
 * @param relativo - o caminho pedido.
 * @returns o descritor validado e o nome; o consumidor deve fechar o descritor.
 */
export async function arquivoParaBaixar(pasta: string, relativo: string): Promise<{ readonly arquivo: FileHandle; readonly nome: string }> {
  if (relativo === '' || relativo.includes('\u0000')) throw new ArquivoRecusado('AUSENTE', 'ausente')
  const partes = relativo.replaceAll('\\', '/').split('/')
  if (partes.some(p => p === '' || p === '.' || p === '..' || (process.platform === 'win32' && p.includes(':')))) throw new ArquivoRecusado('FORA', 'fora')
  const nome = partes.pop()!
  const abertos: FileHandle[] = []
  let arquivo: FileHandle | undefined
  try {
    let caminho = pasta
    let diretorio = await openDirectory(caminho)
    if (diretorio === undefined) throw new ArquivoRecusado('FORA', 'fora')
    abertos.push(diretorio)
    for (const parte of partes) {
      caminho = join(referenceOf(diretorio, caminho), parte)
      diretorio = await openDirectory(caminho)
      if (diretorio === undefined) throw new ArquivoRecusado('FORA', 'fora')
      abertos.push(diretorio)
    }
    const alvo = join(referenceOf(diretorio, caminho), nome)
    const antes = await lstat(alvo)
    if (antes.isSymbolicLink()) throw new ArquivoRecusado('FORA', 'fora')
    if (!antes.isFile()) throw new ArquivoRecusado('AUSENTE', 'ausente')
    arquivo = await open(alvo, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const aberto = await arquivo.stat()
    if (!aberto.isFile() || aberto.dev !== antes.dev || aberto.ino !== antes.ino) throw new ArquivoRecusado('FORA', 'fora')
    // O consumidor lê ESTE descritor, nunca reabre o caminho conferido.
    return { arquivo, nome }
  } catch (erro) {
    await arquivo?.close()
    if ((erro as NodeJS.ErrnoException).code === 'ENOENT') throw new ArquivoRecusado('AUSENTE', 'ausente')
    if ((erro as NodeJS.ErrnoException).code === 'ELOOP') throw new ArquivoRecusado('FORA', 'fora')
    throw erro
  } finally {
    await Promise.all(abertos.map(handle => handle.close()))
  }
}
