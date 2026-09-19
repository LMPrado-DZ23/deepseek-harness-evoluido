import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
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
  const visitar = async (atual: string, profundidade: number): Promise<void> => {
    if (profundidade > PROFUNDIDADE_MAXIMA || cortada) return
    let entradas: import('node:fs').Dirent[]
    try { entradas = await readdir(atual, { withFileTypes: true }) } catch { return }
    for (const entrada of entradas) {
      if (achados.length >= MAXIMO_NA_LISTA) { cortada = true; return }
      if (entrada.name.startsWith('.parcial-')) continue
      const completo = join(atual, entrada.name)
      if (entrada.isSymbolicLink()) continue
      if (entrada.isDirectory()) { await visitar(completo, profundidade + 1); continue }
      if (!entrada.isFile()) continue
      const info = await stat(completo)
      achados.push({ caminho: relative(pasta, completo).split(sep).join('/'), bytes: info.size, alterado_em: info.mtime.toISOString() })
    }
  }
  await visitar(pasta, 0)
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
  const destino = join(pasta, PASTA_DOS_ENVIADOS)
  await mkdir(destino, { recursive: true, mode: 0o700 })
  const parcial = join(destino, `.parcial-${randomUUID()}`)
  let total = 0
  const teto = new Transform({
    transform(pedaco: Buffer, _codificacao, pronto) {
      total += pedaco.length
      if (total > limite) { pronto(new ArquivoRecusado('GRANDE', 'grande')); return }
      pronto(null, pedaco)
    },
  })
  try {
    await pipeline(corpo, teto, createWriteStream(parcial, { mode: 0o600, flags: 'wx' }))
  } catch (erro) {
    await rm(parcial, { force: true })
    throw erro
  }
  const final = await nomeLivre(destino, limpo)
  await rename(parcial, join(destino, final))
  return `${PASTA_DOS_ENVIADOS}/${final}`
}

async function nomeLivre(pasta: string, nome: string): Promise<string> {
  const ponto = nome.lastIndexOf('.')
  const base = ponto > 0 ? nome.slice(0, ponto) : nome
  const extensao = ponto > 0 ? nome.slice(ponto) : ''
  for (let n = 0; n < 1000; n++) {
    const candidato = n === 0 ? nome : `${base} (${String(n + 1)})${extensao}`
    try { await lstat(join(pasta, candidato)) } catch { return candidato }
  }
  return `${base}-${randomUUID()}${extensao}`
}

/**
 * O arquivo a baixar, conferido DENTRO da pasta (links resolvidos antes).
 * @param pasta - a pasta de trabalho.
 * @param relativo - o caminho pedido.
 * @returns o caminho absoluto real.
 */
export async function arquivoParaBaixar(pasta: string, relativo: string): Promise<string> {
  if (relativo === '' || relativo.includes('\u0000')) throw new ArquivoRecusado('AUSENTE', 'ausente')
  const raiz = await realpath(pasta)
  let real: string
  try { real = await realpath(join(raiz, relativo)) } catch { throw new ArquivoRecusado('AUSENTE', 'ausente') }
  if (real !== raiz && !real.startsWith(`${raiz}${sep}`)) throw new ArquivoRecusado('FORA', 'fora')
  if (!(await stat(real)).isFile()) throw new ArquivoRecusado('AUSENTE', 'ausente')
  return real
}
