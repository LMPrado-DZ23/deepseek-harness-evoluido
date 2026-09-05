import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packagePromptTemplate } from './package-prompt-template.mjs'

const scratch = []
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
})
