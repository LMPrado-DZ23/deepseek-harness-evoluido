import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { arquivoParaBaixar, gravarEnviado, listarArquivos, nomeSeguro } from '../src/assistant-files.js'

const pastas: string[] = []
afterEach(async () => { await Promise.all(pastas.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function pasta() { const p = await mkdtemp(join(tmpdir(), 'frigg-arquivos-')); pastas.push(p); return p }

describe('nomeSeguro', () => {
  it.each([['../../etc/passwd', 'passwd'], ['a/b\\c.pdf', 'c.pdf'], ['.oculto', 'oculto'], ['x\u0000y.txt', 'x_y.txt'], ['nota:fiscal?.pdf', 'nota_fiscal_.pdf']])('%s → %s', (entrada, saida) => {
    expect(nomeSeguro(entrada)).toBe(saida)
  })
  it.each(['', '..', '/', '...'])('recusa %j', entrada => { expect(() => nomeSeguro(entrada)).toThrow() })
})

describe('gravarEnviado', () => {
  it('envios concorrentes preservam todos os arquivos e seus conteúdos', async () => {
    const p = await pasta()
    const caminhos = await Promise.all(Array.from({ length: 20 }, (_, i) => gravarEnviado(p, 'mesmo.txt', Readable.from([String(i)]))))
    expect(new Set(caminhos).size).toBe(20)
    for (const [i, caminho] of caminhos.entries()) expect(await readFile(join(p, caminho), 'utf8')).toBe(String(i))
    expect((await readdir(join(p, 'enviados'))).length).toBe(20)
  })

  it('não grava fora da pasta quando enviados é um link', async () => {
    const p = await pasta(); const fora = await pasta()
    await symlink(fora, join(p, 'enviados'), 'dir')
    await expect(gravarEnviado(p, 'escape.txt', Readable.from(['dados']))).rejects.toMatchObject({ code: 'FORA' })
    expect(await readdir(fora)).toEqual([])
  })

  it('trocar a pasta por um link durante o envio não redireciona a gravação', async () => {
    const p = await pasta(); const fora = await pasta()
    async function* corpo() {
      yield Buffer.from('primeiro')
      await rename(join(p, 'enviados'), join(p, 'preservada'))
      await symlink(fora, join(p, 'enviados'), 'dir')
      yield Buffer.from('segundo')
    }
    // No Linux/WSL a escrita permanece no descritor aberto. Em plataformas
    // sem /proc a identidade precisa ser recusada antes da publicação.
    await expect(gravarEnviado(p, 'escape.txt', Readable.from(corpo()))).rejects.toMatchObject({ code: 'FORA' })
    expect(await readdir(fora)).toEqual([])
    expect((await readdir(join(p, 'preservada'))).filter(n => n.startsWith('.parcial-'))).toEqual([])
  })

  it('qualquer tipo entra em enviados/, sem sobrescrever', async () => {
    const p = await pasta()
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
    expect(await gravarEnviado(p, 'contrato.pdf', Readable.from([bytes]))).toBe('enviados/contrato.pdf')
    expect(await gravarEnviado(p, 'contrato.pdf', Readable.from([bytes]))).toBe('enviados/contrato (2).pdf')
    expect(await readFile(join(p, 'enviados/contrato.pdf'))).toEqual(bytes)
  })

  it('acima do teto é recusado e o parcial some', async () => {
    const p = await pasta()
    await expect(gravarEnviado(p, 'grande.bin', Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15)).rejects.toMatchObject({ code: 'GRANDE' })
    expect(await readdir(join(p, 'enviados'))).toEqual([])
  })
})

describe('listarArquivos', () => {
  it('lista o que existe, sem seguir links e sem parciais', async () => {
    const p = await pasta()
    await mkdir(join(p, 'relatorio'), { recursive: true })
    await writeFile(join(p, 'relatorio/final.md'), '# ok')
    await writeFile(join(p, 'enviados.txt'), 'x')
    await writeFile(join(p, '.parcial-123'), 'x')
    const fora = await pasta(); await writeFile(join(fora, 'segredo'), 's')
    await symlink(join(fora, 'segredo'), join(p, 'atalho'))
    const { arquivos } = await listarArquivos(p)
    expect(arquivos.map(a => a.caminho).sort()).toEqual(['enviados.txt', 'relatorio/final.md'])
  })
})

describe('arquivoParaBaixar', () => {
  it('entrega o que está dentro da pasta', async () => {
    const p = await pasta()
    await writeFile(join(p, 'a.txt'), 'a')
    const download = await arquivoParaBaixar(p, 'a.txt')
    try {
      expect(download.nome).toBe('a.txt')
      expect(await download.arquivo.readFile('utf8')).toBe('a')
    } finally { await download.arquivo.close() }
  })

  it('trocar o caminho depois da autorização não troca os bytes baixados', async () => {
    const p = await pasta(); const fora = await pasta()
    await writeFile(join(p, 'a.txt'), 'autorizado')
    await writeFile(join(fora, 'segredo'), 'fora')
    const download = await arquivoParaBaixar(p, 'a.txt')
    try {
      await rename(join(p, 'a.txt'), join(p, 'anterior.txt'))
      await symlink(join(fora, 'segredo'), join(p, 'a.txt'))
      expect(await download.arquivo.readFile('utf8')).toBe('autorizado')
    } finally { await download.arquivo.close() }
  })

  it('recusa sair da pasta, por caminho ou por link', async () => {
    const p = await pasta()
    const fora = await pasta(); await writeFile(join(fora, 'segredo'), 's')
    await symlink(join(fora, 'segredo'), join(p, 'atalho'))
    await expect(arquivoParaBaixar(p, '../segredo')).rejects.toBeDefined()
    await expect(arquivoParaBaixar(p, 'atalho')).rejects.toMatchObject({ code: 'FORA' })
    await expect(arquivoParaBaixar(p, '')).rejects.toMatchObject({ code: 'AUSENTE' })
    await expect(arquivoParaBaixar(p, 'nao-existe')).rejects.toMatchObject({ code: 'AUSENTE' })
  })
})
