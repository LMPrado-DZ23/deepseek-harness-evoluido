import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishValidatedDockerArchive } from '../../builder-supervisor/src/export-artifact.ts'
import { createVerifiedRuntimeArchive } from '../../preview-supervisor/src/artifact-stage.ts'
import { importarExportacao } from '../src/importar-exportacao.ts'
import { hashTree } from '../src/runner.ts'

const pastas: string[] = []
afterEach(async () => { await Promise.all(pastas.splice(0).map(pasta => rm(pasta, { recursive: true, force: true }))) })

function entrada(nome: string, conteudo: string): Buffer {
  const dados = Buffer.from(conteudo); const cabecalho = Buffer.alloc(512); cabecalho.write(nome)
  const octal = (inicio: number, tamanho: number, valor: number) => cabecalho.write(`${valor.toString(8).padStart(tamanho - 1, '0')}\0`, inicio, tamanho, 'ascii')
  octal(100, 8, 0o600); octal(108, 8, 10_001); octal(116, 8, 10_001); octal(124, 12, dados.length); octal(136, 12, 0)
  cabecalho.fill(0x20, 148, 156); cabecalho[156] = '0'.charCodeAt(0); cabecalho.write('ustar', 257); cabecalho.write('00', 263)
  octal(148, 8, cabecalho.reduce((soma, byte) => soma + byte, 0))
  return Buffer.concat([cabecalho, dados, Buffer.alloc((512 - dados.length % 512) % 512)])
}

/** Uma exportação publicada PELO LEITOR DO CONSTRUTOR, a partir de um arquivo como o do Docker. */
async function publicada() {
  const raiz = await mkdtemp(join(tmpdir(), 'dz23-import-')); pastas.push(raiz)
  const exportRoot = join(raiz, 'construtor'); await mkdir(exportRoot, { mode: 0o700 }); await chmod(exportRoot, 0o700)
  const arquivo = join(raiz, 'export.tar'); const ref = `build_${'c'.repeat(32)}`
  await writeFile(arquivo, Buffer.concat([
    entrada('.next/standalone/server.js', 'server'), entrada('.next/standalone/node_modules/react/index.js', 'react'),
    entrada('.next/static/chunk.js', 'chunk'), entrada('public/Logo.svg', 'logo'),
    entrada('evidence/appspec-report.json', '{"checks":[{"id":"a","status":"PASSED"}]}'), Buffer.alloc(1024),
  ]))
  const artefato = await publishValidatedDockerArchive(exportRoot, ref, arquivo, new AbortController().signal)
  const execucoes = join(raiz, 'execucoes'); const execucao = join(execucoes, 'run-1'); await mkdir(join(execucao, 'evidence'), { recursive: true })
  await writeFile(join(execucao, 'evidence', 'appspec-report.json'), '{"checks":[{"id":"a","status":"PENDING"}]}')
  return { origem: join(exportRoot, artefato.relative_path), sha256: artefato.sha256, execucoes, execucao }
}

describe('importarExportacao', () => {
  it('traz a exportação, e a PRÉVIA aceita o que chegou (o hash confere dos dois lados)', async () => {
    const p = await publicada()
    const resultado = await importarExportacao(p.origem, p.execucao, p.sha256)
    expect(resultado.sha256).toBe(await hashTree(resultado.caminho))
    expect(await readFile(join(p.execucao, 'evidence', 'appspec-report.json'), 'utf8')).toContain('"PASSED"')
    expect(await readdir(resultado.caminho)).not.toContain('.dz23-artifact.json')
    const prevista = await createVerifiedRuntimeArchive(p.execucoes, relative(p.execucoes, resultado.caminho), resultado.sha256)
    expect(prevista.runtimeFiles).toBeGreaterThan(0)
  })

  it('uma exportação adulterada é recusada, e nada chega à pasta da execução', async () => {
    const p = await publicada()
    await writeFile(join(p.origem, '.next', 'static', 'chunk.js'), 'adulterado')
    await expect(importarExportacao(p.origem, p.execucao, p.sha256)).rejects.toThrow('EXPORT_IMPORT_HASH_MISMATCH')
    await expect(readdir(join(p.execucao, '.dz23'))).rejects.toThrow()
    expect(await readFile(join(p.execucao, 'evidence', 'appspec-report.json'), 'utf8')).toContain('"PENDING"')
  })

  it('importar de novo guarda a anterior ao lado, e não a apaga', async () => {
    const p = await publicada()
    await importarExportacao(p.origem, p.execucao, p.sha256)
    await importarExportacao(p.origem, p.execucao, p.sha256)
    const nomes = await readdir(join(p.execucao, '.dz23'))
    expect(nomes.filter(nome => nome === 'preview-artifact-v1')).toHaveLength(1)
    expect(nomes.filter(nome => nome.startsWith('preview-artifact-v1.anterior-'))).toHaveLength(1)
  })
})
