import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPORT_SCRIPT, EXPORTACAO_PRONTA, programaDeExportacao } from '../src/export-script.ts'

function espaco() {
  const raiz = mkdtempSync(join(tmpdir(), 'export-ws-')); const destino = mkdtempSync(join(tmpdir(), 'export-out-'))
  const escrever = (caminho: string, texto: string) => { mkdirSync(join(raiz, caminho, '..'), { recursive: true }); writeFileSync(join(raiz, caminho), texto) }
  escrever('.next/standalone/server.js', 'server')
  escrever('.next/static/chunk.js', 'chunk')
  escrever('evidence/appspec-report.json', '{}')
  return { raiz, destino, escrever }
}

function rodar(raiz: string, destino: string) {
  return spawnSync(process.execPath, ['-e', programaDeExportacao(raiz, destino)], { encoding: 'utf8' })
}

describe('a exportação do aplicativo construído', () => {
  it('o programa do contêiner é o mesmo texto que o teste roda, e fica vivo depois de avisar', () => {
    expect(EXPORT_SCRIPT).toBe(programaDeExportacao('/workspace', '/export', true))
  })

  it('avisa que a cópia terminou, e só depois dela', () => {
    const { raiz, destino } = espaco()
    const saida = rodar(raiz, destino)
    expect(saida.stdout).toBe(`${EXPORTACAO_PRONTA}\n`)
    const falha = rodar(mkdtempSync(join(tmpdir(), 'vazio-')), destino)
    expect(falha.stdout).toBe('')
  })

  it('vivo, ele não sai sozinho depois de avisar', () => {
    const { raiz, destino } = espaco()
    const saida = spawnSync(process.execPath, ['-e', programaDeExportacao(raiz, destino, true)], { encoding: 'utf8', timeout: 1500 })
    expect(saida.stdout).toContain(EXPORTACAO_PRONTA)
    expect(saida.signal).toBe('SIGTERM')
  })

  it('copia os itens exigidos', () => {
    const { raiz, destino } = espaco()
    expect(rodar(raiz, destino).status).toBe(0)
    expect(readFileSync(join(destino, '.next/standalone/server.js'), 'utf8')).toBe('server')
    expect(readFileSync(join(destino, 'evidence/appspec-report.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(destino, 'public'))).toBe(false)
  })

  it('segue o link do pnpm DENTRO do standalone e copia o conteúdo: a exportação não leva link nenhum', () => {
    const { raiz, destino, escrever } = espaco()
    escrever('.next/standalone/node_modules/.pnpm/react@19/node_modules/react/index.js', 'react')
    symlinkSync('.pnpm/react@19/node_modules/react', join(raiz, '.next/standalone/node_modules/react'))
    const saida = rodar(raiz, destino)
    expect(saida.stderr).toBe('')
    const copiado = join(destino, '.next/standalone/node_modules/react')
    expect(lstatSync(copiado).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(copiado, 'index.js'), 'utf8')).toBe('react')
  })

  it('um link para FORA do item é recusado', () => {
    const { raiz, destino } = espaco()
    const fora = mkdtempSync(join(tmpdir(), 'fora-')); writeFileSync(join(fora, 'segredo'), 'x')
    symlinkSync(fora, join(raiz, '.next/standalone/vazou'))
    const saida = rodar(raiz, destino)
    expect(saida.status).not.toBe(0)
    expect(saida.stderr).toContain('EXPORT_SOURCE_INVALID')
    expect(existsSync(join(destino, '.next/standalone/vazou/segredo'))).toBe(false)
  })

  it('um link para OUTRO item exportado também é recusado', () => {
    const { raiz, destino } = espaco()
    symlinkSync(join(raiz, '.next/static'), join(raiz, '.next/standalone/estatico'))
    expect(rodar(raiz, destino).stderr).toContain('EXPORT_SOURCE_INVALID')
  })

  it('um ciclo é recusa, e não um laço sem fim', () => {
    const { raiz, destino } = espaco()
    mkdirSync(join(raiz, '.next/standalone/a'))
    symlinkSync('..', join(raiz, '.next/standalone/a/volta'))
    const saida = rodar(raiz, destino)
    expect(saida.status).not.toBe(0)
    expect(saida.stderr).toContain('EXPORT_SOURCE_CYCLE')
  })

  it('uma árvore FUNDA e legítima passa: o ciclo é detectado pelo caminho real, e não por profundidade', () => {
    const { raiz, destino, escrever } = espaco()
    escrever(`.next/standalone/${Array.from({ length: 70 }, (_, i) => `d${i}`).join('/')}/f.js`, 'fundo')
    expect(rodar(raiz, destino).status).toBe(0)
  })

  it('o item de topo continua não podendo ser link, e o exigido ausente é recusa', () => {
    const a = espaco()
    const outro = mkdtempSync(join(tmpdir(), 'pub-')); symlinkSync(outro, join(a.raiz, 'public'))
    expect(rodar(a.raiz, a.destino).stderr).toContain('EXPORT_SOURCE_INVALID')
    const b = espaco()
    const semStatic = mkdtempSync(join(tmpdir(), 'ws-')); mkdirSync(join(semStatic, '.next/standalone'), { recursive: true })
    expect(rodar(semStatic, b.destino).stderr).toContain('EXPORT_SOURCE_MISSING')
  })
})
