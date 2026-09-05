import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { packagePromptTemplate } from './package-prompt-template.mjs'
import { packageStudioWeb } from './package-studio-web.mjs'

const scratch = []
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('prompt template packager', () => {
  it('replaces an existing package and remains repeatable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-template-package-'))
    scratch.push(root)
    const source = join(root, 'source')
    const target = join(root, 'nested', 'target')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'version.txt'), 'first', 'utf8')

    await packagePromptTemplate(source, target)
    await writeFile(join(source, 'version.txt'), 'second', 'utf8')
    await writeFile(join(target, 'stale.txt'), 'must disappear', 'utf8')
    await packagePromptTemplate(source, target)

    await expect(readFile(join(target, 'version.txt'), 'utf8')).resolves.toBe('second')
    await expect(readFile(join(target, 'stale.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces previously packaged web assets instead of failing on the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-web-package-'))
    scratch.push(root)
    const source = join(root, 'dist')
    const target = join(root, 'plugin', 'lib', 'client')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'index.html'), 'v1', 'utf8')

    await packageStudioWeb(source, target)
    await writeFile(join(source, 'index.html'), 'v2', 'utf8')
    await writeFile(join(target, 'stale.js'), 'must disappear', 'utf8')
    await packageStudioWeb(source, target)

    await expect(readFile(join(target, 'index.html'), 'utf8')).resolves.toBe('v2')
    await expect(readFile(join(target, 'stale.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps packaged template assets outside source typechecking and Git', async () => {
    const tsconfig = JSON.parse(await readFile(join(repositoryRoot, 'tsconfig.json'), 'utf8'))
    const ignore = await readFile(join(repositoryRoot, '.gitignore'), 'utf8')

    expect(tsconfig.exclude).toContain('plugins/prompt-to-app/template/**')
    expect(ignore.split(/\r?\n/u)).toContain('plugins/prompt-to-app/template/')
  })
})
