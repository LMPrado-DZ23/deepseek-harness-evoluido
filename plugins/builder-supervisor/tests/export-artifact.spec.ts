import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import { enforceExportRetention, publishValidatedDockerArchive } from '../src/export-artifact.js'

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))
describe('validated Docker export publication', () => {
  it('revalidates tar, publishes by fresh rename with SHA and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const expected = await hashExportTree()
    const artifact = await createVerifiedBuildArchive(root, 'source', expected); const archive = artifact.archivePath
    const ref = `build_${'a'.repeat(32)}`; const result = await publishValidatedDockerArchive(exports, ref, archive, new AbortController().signal)
    expect(result).toEqual({ relative_path: `exports/${ref}`, sha256: expected, files: 4, bytes: 17 }); expect(await readFile(join(exports, 'exports', ref, '.next', 'standalone', 'server.js'), 'utf8')).toBe('server'); expect(await readFile(join(exports, 'exports', ref, 'public', 'logo.svg'), 'utf8')).toBe('logo')
    await expect(publishValidatedDockerArchive(exports, ref, archive, new AbortController().signal)).resolves.toEqual(result); await artifact.dispose()
  })
  it('rejects tampered archives before publishing any final directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-bad-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const expected = await hashExportTree(); const artifact = await createVerifiedBuildArchive(root, 'source', expected)
    const handle = await open(artifact.archivePath, 'r+'); await handle.write(Buffer.from('2'), 0, 1, 156); await handle.close()
    await expect(publishValidatedDockerArchive(exports, `build_${'b'.repeat(32)}`, artifact.archivePath, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID'); await artifact.dispose()
  })
  it('never trusts a previously published manifest without rehashing the allowlisted tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-existing-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const ref = `build_${'9'.repeat(32)}`
    await publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal); await writeFile(join(exports, 'exports', ref, '.next', 'standalone', 'server.js'), 'tampered')
    await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID'); await artifact.dispose()
  })
  it('rejects every path outside the closed deployment allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-extra-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source); await writeFile(join(source, '.env'), 'SECRET=x')
    const hash = createHash('sha256')
    const rows: Array<[string, string]> = [['.env', 'SECRET=x'], ['.next/standalone/server.js', 'server'], ['.next/static/chunk.js', 'chunk'], ['evidence/appspec-report.json', '{}'], ['public/logo.svg', 'logo']]
    for (const [name, value] of rows.sort()) hash.update(name).update('\0').update(value).update('\0')
    const artifact = await createVerifiedBuildArchive(root, 'source', hash.digest('hex'))
    await expect(publishValidatedDockerArchive(exports, `build_${'c'.repeat(32)}`, artifact.archivePath, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID'); await artifact.dispose()
  })
  it('retains only the configured number and aggregate bytes of validated exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-retention-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const refs = ['d', 'e', 'f'].map(value => `build_${value.repeat(32)}`)
    for (const ref of refs) { await publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal); await new Promise(resolve => setTimeout(resolve, 2)) }
    await enforceExportRetention(exports, refs[2]!, 2, 1_024 * 1_024, new AbortController().signal)
    await expect(access(join(exports, 'exports', refs[0]!))).rejects.toThrow(); await expect(access(join(exports, 'exports', refs[1]!))).resolves.toBeUndefined(); await expect(access(join(exports, 'exports', refs[2]!))).resolves.toBeUndefined(); await artifact.dispose()
  })
})

async function validExportTree(source: string): Promise<void> { await mkdir(join(source, '.next', 'standalone'), { recursive: true }); await mkdir(join(source, '.next', 'static'), { recursive: true }); await mkdir(join(source, 'evidence'), { recursive: true }); await mkdir(join(source, 'public'), { recursive: true }); await writeFile(join(source, '.next', 'standalone', 'server.js'), 'server'); await writeFile(join(source, '.next', 'static', 'chunk.js'), 'chunk'); await writeFile(join(source, 'evidence', 'appspec-report.json'), '{}'); await writeFile(join(source, 'public', 'logo.svg'), 'logo') }
async function hashExportTree(): Promise<string> { const hash = createHash('sha256'); const rows: Array<[string, string]> = [['.next/standalone/server.js', 'server'], ['.next/static/chunk.js', 'chunk'], ['evidence/appspec-report.json', '{}'], ['public/logo.svg', 'logo']]; for (const [name, value] of rows) hash.update(name).update('\0').update(value).update('\0'); return hash.digest('hex') }
