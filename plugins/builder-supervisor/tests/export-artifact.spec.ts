import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import { publishValidatedDockerArchive } from '../src/export-artifact.js'

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))
describe('validated Docker export publication', () => {
  it('revalidates tar, publishes by fresh rename with SHA and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await mkdir(source); await writeFile(join(source, 'app.txt'), 'safe')
    const expected = createHash('sha256').update('app.txt').update('\0').update('safe').update('\0').digest('hex')
    const artifact = await createVerifiedBuildArchive(root, 'source', expected); const archive = join(root, 'workspace.tar'); await writeFile(archive, artifact.archive)
    const ref = `build_${'a'.repeat(32)}`; const result = await publishValidatedDockerArchive(exports, ref, archive, new AbortController().signal)
    expect(result).toEqual({ relative_path: `exports/${ref}`, sha256: expected, files: 1, bytes: 4 }); expect(await readFile(join(exports, 'exports', ref, 'app.txt'), 'utf8')).toBe('safe')
    await expect(publishValidatedDockerArchive(exports, ref, archive, new AbortController().signal)).resolves.toEqual(result)
  })
  it('rejects tampered archives before publishing any final directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-bad-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await mkdir(source); await writeFile(join(source, 'app.txt'), 'safe')
    const expected = createHash('sha256').update('app.txt').update('\0').update('safe').update('\0').digest('hex'); const artifact = await createVerifiedBuildArchive(root, 'source', expected)
    artifact.archive[156] = '2'.charCodeAt(0); const archive = join(root, 'bad.tar'); await writeFile(archive, artifact.archive)
    await expect(publishValidatedDockerArchive(exports, `build_${'b'.repeat(32)}`, archive, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
  })
})
