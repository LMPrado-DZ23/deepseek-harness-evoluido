import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalStagingProvider, targetFolder, type VerifiedFile } from '../src/local-provider.js'
import { artifact } from './helpers.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const TARGET = 'dz23-target:staging-main'

/**
 * Um sinal que executa `duranteAJanela` no instante em que o provedor o
 * consulta — que é EXATAMENTE entre a conferência e a cópia.
 *
 * É o único ponto de injeção determinístico para essa janela. Ele não inventa
 * uma janela que não existe: o provedor lê `signal.aborted` ali porque quer
 * desistir tarde, e é nesse mesmo intervalo que outra coisa pode mexer no
 * diretório de origem.
 */
function signalQueMexeNaOrigem(duranteAJanela: () => void): AbortSignal {
  let feito = false
  return {
    get aborted() {
      if (!feito) { feito = true; duranteAJanela() }
      return false
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    reason: undefined,
    throwIfAborted: () => undefined,
    onabort: null,
    dispatchEvent: () => true,
  } as unknown as AbortSignal
}

async function cenario(files: Record<string, string>) {
  const source = await mkdtemp(join(tmpdir(), 'dz23-toctou-src-')); roots.push(source)
  for (const [path, content] of Object.entries(files)) {
    const full = join(source, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  const manifest: VerifiedFile[] = Object.entries(files).map(([path, content]) => ({ path, sha256: sha(content) }))
  const root = await mkdtemp(join(tmpdir(), 'dz23-toctou-dst-')); roots.push(root)
  const provider = new LocalStagingProvider({
    targetRef: TARGET, root,
    artifacts: { open: vi.fn(async () => ({ directory: source, files: manifest })) },
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  })
  return { provider, root, source }
}

const input = { environment: 'staging' as const, operationId: 'op-1', idempotencyKey: 'f'.repeat(64), targetGeneration: 1, artifact: artifact() }

describe('ACHADO: a conferência vale sobre a CÓPIA, e não sobre a origem', () => {
  it('link simbólico plantado DEPOIS da conferência não chega à geração publicada', async () => {
    // `verifyArtifactFiles` lia a árvore e `cp` a lia DE NOVO: duas leituras
    // diferentes, com uma janela entre elas. Nessa janela um arquivo podia ser
    // trocado por um LINK SIMBÓLICO — e como `cp` usa `dereference: false`, o
    // link ia para dentro da geração publicada. A recusa de link da PRIMEIRA
    // leitura não alcançava o que fosse plantado depois dela.
    const f = await cenario({ 'index.html': '<h1>oi</h1>' })
    const alvoSecreto = join(f.source, '..', 'segredo-fora-do-artefato')
    await writeFile(alvoSecreto, 'isto nunca pode ser publicado', 'utf8')
    roots.push(alvoSecreto)

    const resultado = await f.provider.stage(input, signalQueMexeNaOrigem(() => {
      // Troca o arquivo conferido por um link para fora do artefato.
      // Síncrono de propósito: a janela real é curta.
      // eslint-disable-next-line no-sync
      const fs = require('node:fs') as typeof import('node:fs')
      fs.unlinkSync(join(f.source, 'index.html'))
      fs.symlinkSync(alvoSecreto, join(f.source, 'index.html'))
    }))

    expect(resultado).toMatchObject({ kind: 'definitive-no-effect' })
    // Nada foi publicado, e nem sobrou diretório pela metade.
    const folder = join(f.root, targetFolder(TARGET))
    const entradas = await readdir(folder).catch(() => [] as string[])
    expect(entradas.filter(name => !name.startsWith('.'))).toEqual([])
  })

  it('conteúdo trocado DEPOIS da conferência também não é publicado', async () => {
    // A outra metade da mesma janela: bytes que nunca foram conferidos contra
    // o manifesto atestado seriam publicados como se tivessem sido.
    const f = await cenario({ 'index.html': '<h1>oi</h1>' })
    const resultado = await f.provider.stage(input, signalQueMexeNaOrigem(() => {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.writeFileSync(join(f.source, 'index.html'), '<script>outra coisa</script>', 'utf8')
    }))
    expect(resultado).toMatchObject({ kind: 'definitive-no-effect' })
  })

  it('sem ninguém mexendo, a publicação normal continua acontecendo', async () => {
    // Uma conferência que recusa tudo não é uma conferência, é um produto
    // quebrado.
    const f = await cenario({ 'index.html': '<h1>oi</h1>', 'assets/app.js': 'console.log(1)' })
    const resultado = await f.provider.stage(input, new AbortController().signal)
    expect(resultado).toMatchObject({ kind: 'accepted' })
    const publicado = join(f.root, targetFolder(TARGET), '1', 'index.html')
    expect((await lstat(publicado)).isSymbolicLink()).toBe(false)
  })
})
