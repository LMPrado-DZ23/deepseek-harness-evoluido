import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalStagingProvider,
  definitiveCode,
  targetFolder,
  verifyArtifactFiles,
  type VerifiedFile,
} from '../src/local-provider.js'
import { artifact } from './helpers.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const TARGET = 'dz23-target:staging-main'
const signal = new AbortController().signal

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-staging-src-')); roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  const manifest: VerifiedFile[] = Object.entries(files).map(([path, content]) => ({ path, sha256: sha(content) }))
  return { root, manifest }
}

async function provider(files: Record<string, string> = { 'index.html': '<h1>oi</h1>', 'assets/app.js': 'console.log(1)' }) {
  const source = await tree(files)
  const root = await mkdtemp(join(tmpdir(), 'dz23-staging-dst-')); roots.push(root)
  const open = vi.fn(async () => ({ directory: source.root, files: source.manifest }))
  const instance = new LocalStagingProvider({
    targetRef: TARGET, root, artifacts: { open }, now: () => new Date('2026-09-08T12:00:00.000Z'),
  })
  return { provider: instance, root, source, open }
}

const publishInput = (generation = 1, operationId = 'op-1') => ({
  environment: 'staging' as const, operationId, idempotencyKey: 'f'.repeat(64),
  targetGeneration: generation, artifact: artifact(),
})

describe('conferência antes de publicar', () => {
  it('um artefato inteiro e igual ao manifesto passa', async () => {
    const source = await tree({ 'a.txt': 'um', 'b/c.txt': 'dois' })
    await expect(verifyArtifactFiles(source.root, source.manifest)).resolves.toBeUndefined()
  })

  it('arquivo TROCADO entre a verificação e a publicação reprova', async () => {
    // É exatamente entre esses dois momentos que uma troca passaria despercebida.
    const source = await tree({ 'a.txt': 'um' })
    await writeFile(join(source.root, 'a.txt'), 'outro', 'utf8')
    await expect(verifyArtifactFiles(source.root, source.manifest)).resolves.toBe('ARTIFACT_FILE_MODIFIED:a.txt')
  })

  it('arquivo a MAIS reprova, e não só o que falta', async () => {
    // Um arquivo que o manifesto não lista não foi atestado por ninguém.
    const source = await tree({ 'a.txt': 'um' })
    await writeFile(join(source.root, 'extra.js'), 'alert(1)', 'utf8')
    await expect(verifyArtifactFiles(source.root, source.manifest)).resolves.toBe('ARTIFACT_FILE_NOT_ATTESTED:extra.js')
  })

  it('arquivo que sumiu reprova', async () => {
    const source = await tree({ 'a.txt': 'um', 'b.txt': 'dois' })
    await rm(join(source.root, 'b.txt'))
    await expect(verifyArtifactFiles(source.root, source.manifest)).resolves.toBe('ARTIFACT_FILE_MISSING:b.txt')
  })

  it('link simbólico não é publicável', async () => {
    // Ele aponta para fora do que foi atestado: publicar um é publicar o que
    // estiver do outro lado.
    const source = await tree({ 'a.txt': 'um' })
    await symlink('/etc/passwd', join(source.root, 'link'))
    await expect(verifyArtifactFiles(source.root, source.manifest)).rejects.toThrow('ARTIFACT_SYMLINK:link')
  })
})

describe('publicar de verdade', () => {
  it('os arquivos ficam no destino, com recibo e ponteiro do atual', async () => {
    const f = await provider()
    const result = await f.provider.stage(publishInput(), signal)
    expect(result.kind).toBe('accepted')
    const folder = join(f.root, targetFolder(TARGET), '1')
    expect(await readFile(join(folder, 'index.html'), 'utf8')).toBe('<h1>oi</h1>')
    expect(await readFile(join(folder, 'assets/app.js'), 'utf8')).toBe('console.log(1)')
    const receipt = JSON.parse(await readFile(join(folder, 'receipt.json'), 'utf8')) as Record<string, unknown>
    expect(receipt).toMatchObject({ environment: 'staging', kind: 'PUBLISH', target_generation: 1 })
    const current = JSON.parse(await readFile(join(f.root, targetFolder(TARGET), 'current.json'), 'utf8')) as Record<string, unknown>
    expect(current).toMatchObject({ generation: 1 })
  })

  it('nenhum diretório pendente sobra depois da publicação', async () => {
    // Um `.pending-` esquecido no destino é meia aplicação ocupando lugar.
    const f = await provider()
    await f.provider.stage(publishInput(), signal)
    const entries = await readdir(join(f.root, targetFolder(TARGET)))
    expect(entries.some(entry => entry.includes('pending'))).toBe(false)
  })

  it('repetir o mesmo pedido devolve o MESMO recibo, sem copiar de novo', async () => {
    const f = await provider()
    const first = await f.provider.stage(publishInput(), signal)
    const second = await f.provider.stage(publishInput(), signal)
    expect(second).toEqual(first)
    // A segunda vez nem abriu o artefato: é isso que permite ao Studio
    // perguntar "aconteceu?" depois de uma resposta perdida.
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('outra operação na mesma geração é recusada SEM efeito', async () => {
    // Sobrescrever apagaria um efeito que outro release considera seu.
    const f = await provider()
    await f.provider.stage(publishInput(1, 'op-1'), signal)
    const other = await f.provider.stage(publishInput(1, 'op-2'), signal)
    expect(other).toEqual({ kind: 'definitive-no-effect', failureCode: 'TARGET_GENERATION_TAKEN' })
  })

  it('artefato adulterado NÃO é publicado, e a recusa é definitiva e sem efeito', async () => {
    const f = await provider()
    await writeFile(join(f.source.root, 'index.html'), '<script>roubado</script>', 'utf8')
    const result = await f.provider.stage(publishInput(), signal)
    expect(result).toEqual({ kind: 'definitive-no-effect', failureCode: 'ARTIFACT_FILE_MODIFIED' })
    await expect(readdir(join(f.root, targetFolder(TARGET))).catch(() => 'inexistente')).resolves.toBe('inexistente')
  })

  it('o código de falha não carrega caminho do computador de quem hospeda', () => {
    expect(definitiveCode('ARTIFACT_FILE_MODIFIED:/home/alguem/app/index.html')).toBe('ARTIFACT_FILE_MODIFIED')
    expect(definitiveCode('coisa estranha')).toBe('ARTIFACT_VERIFICATION_FAILED')
  })

  it('rollback republica numa geração NOVA, e a anterior continua no disco', async () => {
    const f = await provider()
    await f.provider.stage(publishInput(1), signal)
    const rolled = await f.provider.rollback({
      ...publishInput(2, 'op-2'), fromReceiptRef: 'dz23-receipt:anterior',
    }, signal)
    expect(rolled).toMatchObject({ kind: 'accepted', receipt: { kind: 'ROLLBACK', target_generation: 2 } })
    // Nada é apagado: é isso que permite voltar de novo.
    expect(await readFile(join(f.root, targetFolder(TARGET), '1', 'index.html'), 'utf8')).toBe('<h1>oi</h1>')
  })

  it('cancelado antes da cópia não deixa efeito', async () => {
    const f = await provider()
    const controller = new AbortController(); controller.abort()
    const result = await f.provider.stage(publishInput(), controller.signal)
    expect(result).toEqual({ kind: 'definitive-no-effect', failureCode: 'CANCELLED_BEFORE_COPY' })
  })
})

describe('perguntar se aconteceu', () => {
  it('depois de publicar, o estado é READY com o recibo', async () => {
    const f = await provider()
    const published = await f.provider.stage(publishInput(), signal)
    const state = await f.provider.status({
      environment: 'staging', operationId: 'op-1', idempotencyKey: 'f'.repeat(64),
      targetGeneration: 1, artifactSha256: artifact().artifact_sha256,
    }, signal)
    expect(state).toEqual({ state: 'READY', receipt: (published as { receipt: unknown }).receipt })
  })

  it('sem publicação, o estado é DESCONHECIDO — nunca "não aconteceu"', async () => {
    // `UNKNOWN` mantém o destino bloqueado; um "não aconteceu" falso liberaria
    // uma segunda publicação por cima de um efeito em voo.
    const f = await provider()
    await expect(f.provider.status({
      environment: 'staging', operationId: 'op-1', idempotencyKey: 'f'.repeat(64),
      targetGeneration: 1, artifactSha256: artifact().artifact_sha256,
    }, signal)).resolves.toEqual({ state: 'UNKNOWN' })
  })

  it('recibo de OUTRA operação ou de outro artefato não vira READY', async () => {
    const f = await provider()
    await f.provider.stage(publishInput(1, 'op-1'), signal)
    for (const query of [
      { operationId: 'op-outra', artifactSha256: artifact().artifact_sha256 },
      { operationId: 'op-1', artifactSha256: 'b'.repeat(64) },
    ]) {
      await expect(f.provider.status({
        environment: 'staging', idempotencyKey: 'f'.repeat(64), targetGeneration: 1, ...query,
      }, signal), JSON.stringify(query)).resolves.toEqual({ state: 'UNKNOWN' })
    }
  })

  it('geração que não é inteiro positivo não vira caminho, nem na leitura nem na ESCRITA', async () => {
    // Na escrita é que isso importa: uma geração absurda criaria um diretório
    // de lixo dentro da raiz de staging, e ninguém saberia de onde veio.
    const f = await provider()
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(f.provider.status({
        environment: 'staging', operationId: 'op-1', idempotencyKey: 'f'.repeat(64),
        targetGeneration: generation, artifactSha256: artifact().artifact_sha256,
      }, signal), String(generation)).resolves.toEqual({ state: 'UNKNOWN' })
      await expect(f.provider.stage(publishInput(generation), signal), String(generation))
        .resolves.toEqual({ kind: 'definitive-no-effect', failureCode: 'INVALID_TARGET_GENERATION' })
    }
    await expect(readdir(join(f.root, targetFolder(TARGET))).catch(() => 'inexistente')).resolves.toBe('inexistente')
  })
})

describe('o destino como pasta', () => {
  it('a pasta vem de um HASH, e não do texto do destino', () => {
    // `dz23-target:staging-main` tem dois-pontos, que não é nome de arquivo em
    // todo sistema, e um destino de configuração não pode virar um caminho que
    // escape da raiz.
    expect(targetFolder(TARGET)).toMatch(/^[a-f0-9]{32}$/u)
    expect(targetFolder('dz23-target:../../etc')).toMatch(/^[a-f0-9]{32}$/u)
    expect(targetFolder('a')).not.toBe(targetFolder('b'))
  })

  it('raiz relativa é recusada na montagem', () => {
    expect(() => new LocalStagingProvider({
      targetRef: TARGET, root: 'relativo', artifacts: { open: async () => ({ directory: '', files: [] }) },
    })).toThrow('STAGING_ROOT_MUST_BE_ABSOLUTE')
  })
})
