import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { hashTree, PREVIEW_ARTIFACT_RELATIVE_PATH } from './runner.js'

/** O arquivo que o construtor escreve ao lado da exportação e que NÃO faz parte dela. */
const MANIFESTO_DO_CONSTRUTOR = '.dz23-artifact.json'
const LIMITE_DE_ARQUIVOS = 20_000
const LIMITE_DE_BYTES = 512 * 1024 * 1024

/**
 * TRAZ A EXPORTAÇÃO DO CONSTRUTOR PARA A PASTA DA EXECUÇÃO.
 *
 * O construtor isolado publica o aplicativo construído — e o relatório das
 * conferências que o e2e preencheu — na pasta de exportação DELE. Nada trazia
 * isso de volta: o Studio lia `evidence/appspec-report.json` da SUA pasta, onde
 * só existia a cópia de antes da construção, e toda conferência ficava
 * `PENDING`; a atestação reprovava um aplicativo que tinha passado em tudo, e a
 * prévia procurava `.dz23/preview-artifact-v1`, que ninguém criava. Medido em
 * 20/09/2026, na primeira criação real que atravessou a exportação.
 *
 * A cópia é conferida contra o hash que o construtor publicou (o mesmo
 * algoritmo dele: nomes em ordem de código, `nome\0conteúdo\0`). O que volta
 * é o hash da pasta da prévia no algoritmo da PRÉVIA, que é o que ela confere
 * antes de abrir.
 * @param origem - a pasta publicada pelo construtor.
 * @param pastaDaExecucao - a pasta desta execução no Studio.
 * @param sha256DoConstrutor - o hash que o construtor declarou.
 * @returns o caminho e o hash da pasta da prévia.
 */
export async function importarExportacao(origem: string, pastaDaExecucao: string, sha256DoConstrutor: string): Promise<{ readonly caminho: string; readonly sha256: string }> {
  const raiz = await realpath(origem)
  const nomes = await listar(raiz, '')
  if (nomes.length < 1 || nomes.length > LIMITE_DE_ARQUIVOS) throw new Error('EXPORT_IMPORT_INVALID')
  const hash = createHash('sha256'); let bytes = 0
  const conteudos = new Map<string, Buffer>()
  for (const nome of [...nomes].sort()) {
    const conteudo = await readFile(resolve(raiz, ...nome.split('/')))
    bytes += conteudo.byteLength; if (bytes > LIMITE_DE_BYTES) throw new Error('EXPORT_IMPORT_INVALID')
    hash.update(nome).update('\0').update(conteudo).update('\0')
    conteudos.set(nome, conteudo)
  }
  if (hash.digest('hex') !== sha256DoConstrutor) throw new Error('EXPORT_IMPORT_HASH_MISMATCH')

  const execucao = await realpath(pastaDaExecucao)
  const destino = resolve(execucao, PREVIEW_ARTIFACT_RELATIVE_PATH)
  const provisorio = `${destino}.chegando-${randomBytes(6).toString('hex')}`
  await mkdir(dirname(destino), { recursive: true, mode: 0o755 })
  for (const [nome, conteudo] of conteudos) {
    const alvo = resolve(provisorio, ...nome.split('/'))
    if (!alvo.startsWith(provisorio + sep)) throw new Error('EXPORT_IMPORT_INVALID')
    await mkdir(dirname(alvo), { recursive: true, mode: 0o755 })
    await writeFile(alvo, conteudo, { mode: 0o644, flag: 'wx' })
  }
  // Uma importação anterior desta mesma pasta fica guardada ao lado, e não apagada.
  if (await lstat(destino).catch(() => undefined) !== undefined) await rename(destino, `${destino}.anterior-${randomBytes(6).toString('hex')}`)
  await rename(provisorio, destino)
  const relatorio = conteudos.get('evidence/appspec-report.json')
  if (relatorio !== undefined) {
    await mkdir(resolve(execucao, 'evidence'), { recursive: true, mode: 0o700 })
    await writeFile(resolve(execucao, 'evidence', 'appspec-report.json'), relatorio, { mode: 0o600 })
  }
  return { caminho: destino, sha256: await hashTree(destino) }
}

async function listar(raiz: string, prefixo: string): Promise<string[]> {
  const nomes: string[] = []
  for (const entrada of await readdir(prefixo === '' ? raiz : resolve(raiz, ...prefixo.split('/')), { withFileTypes: true })) {
    if (prefixo === '' && entrada.name === MANIFESTO_DO_CONSTRUTOR) continue
    const nome = prefixo === '' ? entrada.name : `${prefixo}/${entrada.name}`
    if (entrada.isSymbolicLink()) throw new Error('EXPORT_IMPORT_INVALID')
    if (entrada.isDirectory()) nomes.push(...await listar(raiz, nome))
    else if (entrada.isFile()) nomes.push(nome)
    else throw new Error('EXPORT_IMPORT_INVALID')
    if (nomes.length > LIMITE_DE_ARQUIVOS) throw new Error('EXPORT_IMPORT_INVALID')
  }
  return nomes
}
