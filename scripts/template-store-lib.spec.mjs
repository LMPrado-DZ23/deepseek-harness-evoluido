import { mkdtemp, mkdir, readdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizarStoreDoPnpm } from './template-store-lib.mjs'

const raizes = []
afterEach(async () => { await Promise.all(raizes.splice(0).map(r => rm(r, { recursive: true, force: true }))) })

async function store() {
  const raiz = await mkdtemp(join(tmpdir(), 'frigg-store-'))
  raizes.push(raiz)
  await mkdir(join(raiz, 'v11', 'files', 'ab'), { recursive: true })
  await writeFile(join(raiz, 'v11', 'files', 'ab', 'cd'), 'conteudo')
  await writeFile(join(raiz, 'v11', 'index.db'), 'db')
  await mkdir(join(raiz, 'v11', 'projects'))
  await symlink('/tmp/dz23-template-fetch-sumiu/template-0', join(raiz, 'v11', 'projects', 'p1'))
  await symlink('/tmp/dz23-template-fetch-sumiu/template-1', join(raiz, 'v11', 'projects', 'p2'))
  return raiz
}

describe('normalizarStoreDoPnpm', () => {
  it('tira SÓ o registro de projetos, e mantém files/ e index.db', async () => {
    const raiz = await store()
    expect(await normalizarStoreDoPnpm(raiz)).toBe(2)
    expect((await readdir(join(raiz, 'v11'))).sort()).toEqual(['files', 'index.db'])
    expect(await readdir(join(raiz, 'v11', 'files', 'ab'))).toEqual(['cd'])
  })

  it('é idempotente: sem registro, não faz nada', async () => {
    const raiz = await store()
    await normalizarStoreDoPnpm(raiz)
    expect(await normalizarStoreDoPnpm(raiz)).toBe(0)
  })

  it('recusa, SEM apagar nada, quando o registro tem algo que não é link', async () => {
    const raiz = await store()
    await writeFile(join(raiz, 'v11', 'projects', 'arquivo-de-verdade'), 'x')
    await expect(normalizarStoreDoPnpm(raiz)).rejects.toThrow('não é link')
    expect((await readdir(join(raiz, 'v11', 'projects'))).sort()).toEqual(['arquivo-de-verdade', 'p1', 'p2'])
  })

  it('não toca pastas que não são de versão do store', async () => {
    const raiz = await store()
    await mkdir(join(raiz, 'outra', 'projects'), { recursive: true })
    await symlink('/tmp/x', join(raiz, 'outra', 'projects', 'l'))
    await normalizarStoreDoPnpm(raiz)
    expect(await readdir(join(raiz, 'outra', 'projects'))).toEqual(['l'])
  })
})
