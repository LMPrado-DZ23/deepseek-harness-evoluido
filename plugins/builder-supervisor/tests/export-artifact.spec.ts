import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import { assertExportPathBeneath, cleanupManagedExportResources, currentExportIdentity, enforceExportRetention, listManagedExportArchives, openManagedExportArchive, publishValidatedDockerArchive, readValidatedPublishedArtifact, type ExportRuntime } from '../src/export-artifact.js'

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))
describe('validated Docker export publication', () => {
  it('revalidates tar, publishes by fresh rename with SHA and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const expected = await hashExportTree()
    const artifact = await createVerifiedBuildArchive(root, 'source', expected); const archive = artifact.archivePath
    expect(artifact.wireSha256).toBe(createHash('sha256').update(await readFile(archive)).digest('hex'))
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
  it('uses a canonical tree hash independent of tar entry order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-order-')); roots.push(root); const archive = join(root, 'reverse.tar'); const exports = join(root, 'published')
    const rows: Array<[string, string]> = [['public/logo.svg', 'logo'], ['evidence/appspec-report.json', '{}'], ['.next/static/chunk.js', 'chunk'], ['.next/standalone/server.js', 'server']]
    await writeFile(archive, Buffer.concat([...rows.map(([name, value]) => tarEntry(name, value)), Buffer.alloc(1024)]))
    const ref = `build_${'8'.repeat(32)}`
    const result = await publishValidatedDockerArchive(exports, ref, archive, new AbortController().signal)
    expect(result.sha256).toBe(await hashExportTree())
    await expect(publishValidatedDockerArchive(exports, ref, archive, new AbortController().signal)).resolves.toEqual(result)
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
    await enforceExportRetention(exports, refs[2]!, new Set(), 2, 1_024 * 1_024, new AbortController().signal)
    await expect(access(join(exports, 'exports', refs[0]!))).rejects.toThrow(); await expect(access(join(exports, 'exports', refs[1]!))).resolves.toBeUndefined(); await expect(access(join(exports, 'exports', refs[2]!))).resolves.toBeUndefined(); await artifact.dispose()
  })
  it('never evicts a publication pinned by an uncommitted journal record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-pinned-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const refs = ['1', '2', '3'].map(value => `build_${value.repeat(32)}`); const signal = new AbortController().signal
    for (const ref of refs) { await publishValidatedDockerArchive(exports, ref, artifact.archivePath, signal); await new Promise(resolve => setTimeout(resolve, 2)) }
    await expect(enforceExportRetention(exports, refs[2]!, new Set([refs[0]!]), 1, 1_000_000, signal)).rejects.toThrow('CAPACITY_EXCEEDED')
    await expect(access(join(exports, 'exports', refs[0]!))).resolves.toBeUndefined(); await expect(access(join(exports, 'exports', refs[1]!))).rejects.toThrow(); await expect(access(join(exports, 'exports', refs[2]!))).resolves.toBeUndefined()
    await expect(enforceExportRetention(exports, refs[2]!, new Set(), 1, 1_000_000, signal)).resolves.toBeUndefined(); await expect(access(join(exports, 'exports', refs[0]!))).rejects.toThrow(); await artifact.dispose()
  })
  it.runIf(process.platform !== 'win32')('fsyncs the manifest and every real staging directory bottom-up before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-durable-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const events: string[] = []; const ref = `build_${'4'.repeat(32)}`
    const runtime = exportRuntime({ open: (async (path, flags, mode) => {
      const handle = await open(path, flags, mode); const name = String(path)
      return new Proxy(handle, { get(target, property) { if (property === 'sync') return async () => { events.push(name); await target.sync() }; const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value } })
    }) as typeof open })
    await publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal, runtime)
    const stage = join(exports, 'exports', `.stage-${ref}-${'f'.repeat(16)}`); const manifest = join(stage, '.dz23-artifact.json'); const nested = join(stage, '.next', 'standalone'); const parent = join(stage, '.next')
    expect(events.indexOf(manifest)).toBeGreaterThanOrEqual(0); expect(events.indexOf(nested)).toBeGreaterThan(events.indexOf(manifest)); expect(events.indexOf(parent)).toBeGreaterThan(events.indexOf(nested)); expect(events.indexOf(stage)).toBeGreaterThan(events.indexOf(parent))
    await artifact.dispose()
  })
  it.runIf(process.platform !== 'win32')('fails closed if the staged tree changes during the durability walk and covers the Windows durability contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-durability-race-')); roots.push(root); const source = join(root, 'source'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal; let index = 0
    const attempt = async (kind: 'link' | 'other') => {
      const output = join(root, `out-${kind}`); let durabilityWalk = false
      const runtime = exportRuntime({ open: (async (path, flags, mode) => { const handle = await open(path, flags, mode); if (String(path).endsWith('.dz23-artifact.json') && (Number(flags) & constants.O_WRONLY) !== 0) durabilityWalk = true; return handle }) as typeof open, lstat: (async path => {
        const stat = await lstat(path); const value = String(path); const stageAt = value.indexOf('.stage-')
        if (durabilityWalk && stageAt >= 0) {
          if (kind === 'link' && value.endsWith(`${pathSeparator()}public`)) return statProxy(stat, { isSymbolicLink: () => true })
          if (kind === 'other' && value.endsWith(`${pathSeparator()}logo.svg`)) return statProxy(stat, { isFile: () => false })
        }
        return stat
      }) as typeof lstat })
      await expect(publishValidatedDockerArchive(output, `build_${(++index).toString(16).padStart(32, '0')}`, artifact.archivePath, signal, runtime)).rejects.toThrow('EXPORT_INVALID')
    }
    await attempt('link'); await attempt('other')
    await expect(publishValidatedDockerArchive(join(root, 'win'), `build_${(++index).toString(16).padStart(32, '0')}`, artifact.archivePath, signal, exportRuntime({ platform: 'win32', uid: undefined }))).resolves.toMatchObject({ files: 4 })
    await artifact.dispose()
  })
  it('quarantines every orphan staging directory before retention accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-stage-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const ref = `build_${'7'.repeat(32)}`; await publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)
    const stale = join(exports, 'exports', `.stage-build_${'6'.repeat(32)}-${'a'.repeat(16)}`); const fresh = join(exports, 'exports', `.stage-build_${'5'.repeat(32)}-${'b'.repeat(16)}`)
    const orphan = join(exports, 'exports', `.orphan-${'c'.repeat(16)}`); await mkdir(stale, { mode: 0o700 }); await mkdir(fresh, { mode: 0o700 }); await mkdir(orphan, { mode: 0o700 })
    await enforceExportRetention(exports, ref, new Set(), 1, 1_024 * 1_024, new AbortController().signal)
    await expect(access(stale)).rejects.toThrow(); await expect(access(fresh)).rejects.toThrow(); await expect(access(orphan)).rejects.toThrow(); await artifact.dispose()
  })

  it('owns archive descriptors and discovers, quarantines and fsyncs every managed export residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-managed-')); roots.push(root); const firstRef = `build_${'1'.repeat(32)}`; const secondRef = `build_${'2'.repeat(32)}`; const runtime = exportRuntime(); const signal = new AbortController().signal
    const first = await openManagedExportArchive(root, firstRef, runtime); const second = await openManagedExportArchive(root, secondRef, runtime); await first.handle.close(); await second.handle.close()
    const stage = join(root, 'exports', `.stage-${firstRef}-${'a'.repeat(16)}`); const otherStage = join(root, 'exports', `.stage-${secondRef}-${'b'.repeat(16)}`); const orphan = join(root, 'exports', `.orphan-${'c'.repeat(16)}`); await mkdir(stage, { mode: 0o700 }); await mkdir(otherStage, { mode: 0o700 }); await mkdir(orphan, { mode: 0o700 })
    await expect(listManagedExportArchives(root, runtime)).resolves.toEqual([firstRef, secondRef])
    await cleanupManagedExportResources(root, firstRef, signal, runtime)
    await expect(access(first.path)).rejects.toThrow(); await expect(access(stage)).rejects.toThrow(); await expect(access(orphan)).rejects.toThrow(); await expect(access(second.path)).resolves.toBeUndefined(); await expect(access(otherStage)).resolves.toBeUndefined()
    await cleanupManagedExportResources(root, undefined, signal, runtime); await expect(listManagedExportArchives(root, runtime)).resolves.toEqual([])
    await expect(openManagedExportArchive(root, 'bad', runtime)).rejects.toThrow('EXPORT_INVALID'); await expect(readValidatedPublishedArtifact(root, 'bad', runtime)).rejects.toThrow('EXPORT_INVALID'); await expect(cleanupManagedExportResources(root, 'bad', signal, runtime)).rejects.toThrow('EXPORT_INVALID')
    const badArchive = join(root, `.archive-${firstRef}-${'d'.repeat(16)}.tar`); await mkdir(badArchive); await expect(listManagedExportArchives(root, runtime)).rejects.toThrow('EXPORT_INVALID'); await rm(badArchive, { recursive: true })
    const badStage = join(root, 'exports', `.stage-${firstRef}-${'e'.repeat(16)}`); await writeFile(badStage, 'bad'); await expect(listManagedExportArchives(root, runtime)).rejects.toThrow('EXPORT_INVALID'); await rm(badStage)
    const badOrphan = join(root, 'exports', `.orphan-${'f'.repeat(16)}`); await writeFile(badOrphan, 'bad'); await expect(cleanupManagedExportResources(root, undefined, signal, runtime)).rejects.toThrow('EXPORT_INVALID'); await rm(badOrphan)
    const invalidDescriptor = exportRuntime({ open: (async (path, flags, mode) => { const handle = await open(path, flags, mode); if (!String(path).includes('.archive-')) return handle; return new Proxy(handle, { get(target, property) { if (property === 'stat') return async () => statProxy(await target.stat(), { isFile: () => false }); const member = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member } }) }) as typeof open })
    await expect(openManagedExportArchive(root, `build_${'3'.repeat(32)}`, invalidDescriptor)).rejects.toThrow('EXPORT_INVALID')
    const ignoredCleanup = exportRuntime({ open: invalidDescriptor.open, remove: (async () => { throw new Error('cannot remove') }) as typeof rm })
    await expect(openManagedExportArchive(root, `build_${'4'.repeat(32)}`, ignoredCleanup)).rejects.toThrow('EXPORT_INVALID')
    const windowsRuntime = exportRuntime({ platform: 'win32', uid: undefined }); const win = await openManagedExportArchive(join(root, 'win'), `build_${'5'.repeat(32)}`, windowsRuntime); await win.handle.close(); await cleanupManagedExportResources(join(root, 'win'), undefined, signal, windowsRuntime)
  })

  it('binds publication to the downloaded archive identity, size and digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-binding-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const stat = await lstat(artifact.archivePath); const ref = `build_${'8'.repeat(32)}`
    await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal, undefined, { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: '0'.repeat(64) })).rejects.toThrow('ARTIFACT_CHANGED_DURING_STAGE')
    await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal, undefined, { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: createHash('sha256').update(await readFile(artifact.archivePath)).digest('hex') })).resolves.toMatchObject({ relative_path: `exports/${ref}` }); await artifact.dispose()
  })

  it('rejects malformed tar structure, paths, types, checksums and incomplete exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-corpus-')); roots.push(root); const exports = join(root, 'published'); let sequence = 0
    const reject = async (bytes: Buffer) => {
      const archive = join(root, `bad-${sequence++}.tar`); await writeFile(archive, bytes)
      await expect(publishValidatedDockerArchive(exports, `build_${sequence.toString(16).padStart(32, '0')}`, archive, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    }
    const valid = [tarEntry('.next/standalone/server.js', 'server'), tarEntry('.next/static/chunk.js', 'chunk'), tarEntry('evidence/appspec-report.json', '{}')]
    await reject(Buffer.concat(valid)) // no two-block terminator
    await reject(Buffer.concat([...valid, Buffer.alloc(512)]))
    await reject(Buffer.concat([...valid, Buffer.alloc(1024), Buffer.from('x')]))
    await reject(Buffer.concat([tarEntry('/absolute', 'x'), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public\\bad', 'x'), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public/../bad', 'x'), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public//bad', 'x'), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public/link', '', { type: '2' }), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public', 'x', { type: '5' }), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public', '', { type: '0' }), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('./', '', { type: '0' }), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('./', 'x', { type: '5' }), Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public/A', 'x'), tarEntry('public/a', 'x'), ...valid, Buffer.alloc(1024)]))
    await reject(Buffer.concat([tarEntry('public/huge', '', { declaredSize: 512 * 1024 * 1024 + 1 }), Buffer.alloc(1024)]))
    const checksum = tarEntry('public/x', 'x'); checksum[0] = checksum[0]! ^ 1; await reject(Buffer.concat([checksum, Buffer.alloc(1024)]))
    const octal = tarEntry('public/x', 'x'); octal.fill(0x78, 124, 136); await reject(Buffer.concat([octal, Buffer.alloc(1024)]))
    await reject(Buffer.alloc(1024))
    await expect(publishValidatedDockerArchive(exports, '../bad', join(root, 'bad-0.tar'), new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
  })

  it('fails closed for invalid retention inputs, unknown entries, missing current and byte pressure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-retention-bad-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const ref = `build_${'1'.repeat(32)}`; await publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)
    await expect(enforceExportRetention(exports, ref, new Set(), 0, 100, new AbortController().signal)).rejects.toThrow('INVALID_EXPORT_RETENTION')
    await expect(enforceExportRetention(exports, ref, new Set(), 1, 0, new AbortController().signal)).rejects.toThrow('INVALID_EXPORT_RETENTION')
    await expect(enforceExportRetention(exports, '../bad', new Set(), 1, 100, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    await expect(enforceExportRetention(exports, `build_${'2'.repeat(32)}`, new Set(), 1, 100, new AbortController().signal)).rejects.toThrow('CAPACITY_EXCEEDED')
    await expect(enforceExportRetention(exports, ref, new Set(), 1, 1, new AbortController().signal)).rejects.toThrow('CAPACITY_EXCEEDED')
    const badOrphan = join(exports, 'exports', `.orphan-${'a'.repeat(16)}`); await writeFile(badOrphan, 'x'); await expect(enforceExportRetention(exports, ref, new Set(), 1, 100, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID'); await rm(badOrphan)
    await writeFile(join(exports, 'exports', 'alien'), 'x')
    await expect(enforceExportRetention(exports, ref, new Set(), 1, 100, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })

  it.runIf(process.platform !== 'win32')('rejects unsafe filesystem objects and permissions in published trees and retention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-fs-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const ref = `build_${'3'.repeat(32)}`; await publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)
    const published = join(exports, 'exports', ref)
    await symlink('/tmp', join(published, 'public', 'unsafe'))
    await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    await rm(join(published, 'public', 'unsafe'))
    await link(join(published, 'public', 'logo.svg'), join(published, 'public', 'hard.svg'))
    await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    await rm(join(published, 'public', 'hard.svg')); await writeFile(join(published, 'evidence', 'extra.txt'), 'x')
    await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    await chmod(exports, 0o755)
    await expect(enforceExportRetention(exports, ref, new Set(), 1, 100, new AbortController().signal)).rejects.toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })

  it('uses injected filesystem boundaries to fail closed on races and cleanup faults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-runtime-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal; let index = 0
    const attempt = async (overrides: Partial<ExportRuntime>, expected = 'EXPORT_INVALID') => {
      const ref = `build_${(++index).toString(16).padStart(32, '0')}`
      await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, signal, exportRuntime(overrides))).rejects.toThrow(expected)
    }
    await attempt({ readdir: (async (path: Parameters<typeof readdir>[0]) => {
      const rows = await readdir(path, { withFileTypes: true })
      return String(path).includes('.stage-') ? rows.filter(row => row.name !== 'public') : rows
    }) as unknown as typeof readdir })
    await attempt({ rename: (async () => { const error = new Error('race') as NodeJS.ErrnoException; error.code = 'EEXIST'; throw error }) as typeof rename, remove: (async () => { throw new Error('cleanup failed') }) as typeof rm })
    await attempt({ rename: (async () => { const error = new Error('race') as NodeJS.ErrnoException; error.code = 'EEXIST'; throw error }) as typeof rename })
    const archiveStat = await lstat(artifact.archivePath)
    await attempt({ lstat: (async path => String(path).endsWith(`${pathSeparator()}.next`) ? archiveStat : lstat(path)) as typeof lstat })
    await attempt({ lstat: (async path => { if (String(path).endsWith(`${pathSeparator()}.next`)) { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error } return lstat(path) }) as typeof lstat }, 'denied')
    await artifact.dispose()
  })

  it('detects short I/O and archive/tree TOCTOU through deterministic filesystem seams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-io-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal; let index = 0
    const attempt = async (openOverride: typeof open, expected = 'EXPORT_INVALID') => {
      const ref = `build_${(++index + 20).toString(16).padStart(32, '0')}`
      await expect(publishValidatedDockerArchive(exports, ref, artifact.archivePath, signal, exportRuntime({ open: openOverride }))).rejects.toThrow(expected)
    }
    await attempt(interceptOpen(artifact.archivePath, { read: async (_target, buffer, _offset, length) => ({ bytesRead: length - 1, buffer }) }))
    let statCalls = 0
    await attempt(interceptOpen(artifact.archivePath, { stat: async target => { const stat = await target.stat(); statCalls += 1; return statCalls === 2 ? { ...stat, mtimeMs: stat.mtimeMs + 1 } as never : stat } }), 'ARTIFACT_CHANGED_DURING_STAGE')
    await attempt(interceptOpen(undefined, { write: async (_target, buffer) => ({ bytesWritten: 0, buffer }) }, (_path, flags) => (flags & constants.O_WRONLY) !== 0))
    await attempt(interceptOpen(undefined, { stat: async target => { const stat = await target.stat(); return { ...stat, isFile: () => false } as never } }, (path, flags) => flags === (constants.O_RDONLY | constants.O_NOFOLLOW) && path.includes('.stage-') && !path.endsWith('.dz23-artifact.json')))
    const archiveStat = await lstat(artifact.archivePath); const archiveSha = createHash('sha256').update(await readFile(artifact.archivePath)).digest('hex')
    await expect(publishValidatedDockerArchive(exports, `build_${(++index + 20).toString(16).padStart(32, '0')}`, artifact.archivePath, signal, exportRuntime({ open: interceptOpen(artifact.archivePath, { read: async (_target, buffer) => ({ bytesRead: 0, buffer }) }) }), { dev: archiveStat.dev, ino: archiveStat.ino, size: archiveStat.size, sha256: archiveSha })).rejects.toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })

  it('rejects malformed existing publication metadata, required entries and empty trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-existing-corpus-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal; const refs = ['a', 'b', 'c', 'd'].map(value => `build_${value.repeat(32)}`)
    await publishValidatedDockerArchive(exports, refs[0]!, artifact.archivePath, signal); await rm(join(exports, 'exports', refs[0]!, '.dz23-artifact.json'))
    await expect(enforceExportRetention(exports, refs[0]!, new Set(), 1, 100, signal)).rejects.toThrow('EXPORT_INVALID')
    await rm(join(exports, 'exports', refs[0]!), { recursive: true })
    for (const [position, invalidManifest] of [
      { build_ref: refs[1], relative_path: `exports/${refs[1]}`, sha256: 'bad', files: 1, bytes: 0 },
      { build_ref: refs[2], relative_path: `exports/${refs[2]}`, sha256: '0'.repeat(64), files: 0, bytes: -1 },
    ].entries()) {
      const final = join(exports, 'exports', refs[position + 1]!); await mkdir(final, { recursive: true }); await writeFile(join(final, '.dz23-artifact.json'), JSON.stringify(invalidManifest))
      await expect(publishValidatedDockerArchive(exports, refs[position + 1]!, artifact.archivePath, signal)).rejects.toThrow('EXPORT_INVALID')
      await rm(final, { recursive: true })
    }
    const archive = join(root, 'missing-required.tar'); await writeFile(archive, Buffer.concat([tarEntry('.next/standalone/server.js', 'server'), tarEntry('evidence/appspec-report.json', '{}'), Buffer.alloc(1024)]))
    await expect(publishValidatedDockerArchive(exports, refs[3]!, archive, signal)).rejects.toThrow('EXPORT_INVALID')
    const wrongKind = join(root, 'wrong-kind.tar'); await writeFile(wrongKind, Buffer.concat([tarEntry('.next/standalone/server.js', '', { type: '5' }), tarEntry('.next/static/chunk.js', 'chunk'), tarEntry('evidence/appspec-report.json', '{}'), Buffer.alloc(1024)]))
    await expect(publishValidatedDockerArchive(exports, `build_${'e'.repeat(32)}`, wrongKind, signal)).rejects.toThrow('EXPORT_INVALID')
    const empty = join(exports, 'exports', `build_${'f'.repeat(32)}`); await mkdir(empty); await writeFile(join(empty, '.dz23-artifact.json'), JSON.stringify({ build_ref: `build_${'f'.repeat(32)}`, relative_path: `exports/build_${'f'.repeat(32)}`, sha256: '0'.repeat(64), files: 1, bytes: 0 }))
    await expect(publishValidatedDockerArchive(exports, `build_${'f'.repeat(32)}`, artifact.archivePath, signal)).rejects.toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })

  it.runIf(process.platform !== 'win32')('rejects hardlinked archives, symlinked roots and occupied final paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-paths-')); roots.push(root); const source = join(root, 'source'); await validExportTree(source); const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal
    const hard = join(root, 'hard.tar'); await link(artifact.archivePath, hard)
    await expect(publishValidatedDockerArchive(join(root, 'hard-out'), `build_${'1'.repeat(32)}`, hard, signal)).rejects.toThrow('EXPORT_INVALID')
    const target = join(root, 'real-out'); await mkdir(target, { mode: 0o700 }); const symbolic = join(root, 'symbolic-out'); await symlink(target, symbolic)
    await expect(publishValidatedDockerArchive(symbolic, `build_${'2'.repeat(32)}`, artifact.archivePath, signal)).rejects.toThrow('EXPORT_INVALID')
    const occupied = join(root, 'occupied-out'); const ref = `build_${'3'.repeat(32)}`; await mkdir(join(occupied, 'exports'), { recursive: true, mode: 0o700 }); await writeFile(join(occupied, 'exports', ref), 'file')
    await expect(publishValidatedDockerArchive(occupied, ref, artifact.archivePath, signal)).rejects.toThrow('EXPORT_INVALID')
    const stageFile = join(occupied, 'exports', `.stage-build_${'4'.repeat(32)}-${'a'.repeat(16)}`); await writeFile(stageFile, 'stage')
    await expect(enforceExportRetention(occupied, ref, new Set(), 1, 100, signal)).rejects.toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })

  it('validates retention staging and final directories again immediately before mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-retention-runtime-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const refs = ['4', '5'].map(value => `build_${value.repeat(32)}`); const signal = new AbortController().signal
    for (const ref of refs) await publishValidatedDockerArchive(exports, ref, artifact.archivePath, signal)
    const stale = join(exports, 'exports', `.stage-build_${'6'.repeat(32)}-${'a'.repeat(16)}`); await mkdir(stale)
    const stageStat = await lstat(stale); let stageSeen = 0
    await expect(enforceExportRetention(exports, refs[1]!, new Set(), 2, 1_000, signal, exportRuntime({ lstat: (async path => { if (path === stale && ++stageSeen === 1) return { ...stageStat, isDirectory: () => false } as never; return lstat(path) }) as typeof lstat }))).rejects.toThrow('EXPORT_INVALID')
    await rm(stale, { recursive: true, force: true }); const old = join(exports, 'exports', refs[0]!); const oldStat = await lstat(old); let oldSeen = 0
    await expect(enforceExportRetention(exports, refs[1]!, new Set(), 1, 1_000_000, signal, exportRuntime({ lstat: (async path => { if (path === old && ++oldSeen === 3) return { ...oldStat, isDirectory: () => false } as never; return lstat(path) }) as typeof lstat }))).rejects.toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })

  it('covers canonical tar header variants and fails closed on short payload and trailer reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-header-')); roots.push(root); const exports = join(root, 'published'); const signal = new AbortController().signal; let index = 100
    const required = [tarEntry('.next/static/chunk.js', 'chunk'), tarEntry('evidence/appspec-report.json', '{}')]
    const prefixed = tarEntry('server.js', 'server'); prefixed.fill(0, 345, 500); prefixed.write('.next/standalone', 345); checksumHeader(prefixed)
    const nulType = tarEntry('public/logo.svg', 'logo'); nulType[156] = 0; checksumHeader(nulType)
    const noNulSize = tarEntry('public/plain.txt', 'x'); noNulSize.write('000000000001', 124, 12, 'ascii'); checksumHeader(noNulSize)
    const directory = tarEntry('./', '', { type: '5' })
    const good = join(root, 'variants.tar'); await writeFile(good, Buffer.concat([directory, prefixed, ...required, nulType, noNulSize, Buffer.alloc(1024)]))
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, good, signal)).resolves.toMatchObject({ files: 5 })
    const padded = join(root, 'zero-trailer.tar'); await writeFile(padded, Buffer.concat([prefixed, ...required, Buffer.alloc(1024 + 9)]))
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, padded, signal)).resolves.toMatchObject({ files: 3 })

    const invalidOctal = tarEntry('public/bad.txt', 'x'); invalidOctal.fill(0x78, 124, 136); checksumHeader(invalidOctal)
    const badOctalPath = join(root, 'bad-octal.tar'); await writeFile(badOctalPath, Buffer.concat([invalidOctal, Buffer.alloc(1024)]))
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, badOctalPath, signal)).rejects.toThrow('EXPORT_INVALID')

    const payloadArchive = join(root, 'payload-short.tar'); await writeFile(payloadArchive, Buffer.concat([tarEntry('.next/standalone/server.js', 'server'), ...required, Buffer.alloc(1024)]))
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, payloadArchive, signal, exportRuntime({ open: interceptOpen(payloadArchive, { read: async (target, buffer, offset, length, position) => position === 512 ? { bytesRead: length - 1, buffer } : target.read(buffer, offset, length, position) }) }))).rejects.toThrow('EXPORT_INVALID')

    const trailerArchive = join(root, 'trailer-short.tar'); const trailerBytes = Buffer.concat([tarEntry('.next/standalone/server.js', 'server'), ...required, Buffer.alloc(1024 + 9)]); await writeFile(trailerArchive, trailerBytes)
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, trailerArchive, signal, exportRuntime({ open: interceptOpen(trailerArchive, { read: async (target, buffer, offset, length, position) => length === 9 ? { bytesRead: length - 1, buffer } : target.read(buffer, offset, length, position) }) }))).rejects.toThrow('EXPORT_INVALID')
  })

  it('revalidates tree contents across measurement, hashing and directory retention seams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-revalidate-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal; const refs = ['6', '7', '8'].map(value => `build_${value.repeat(32)}`)
    for (const ref of refs) await publishValidatedDockerArchive(exports, ref, artifact.archivePath, signal)

    const logo = join(exports, 'exports', refs[0]!, 'public', 'logo.svg'); const logoStat = await lstat(logo); let logoReads = 0
    await expect(enforceExportRetention(exports, refs[0]!, new Set(), 3, 1_000_000, signal, exportRuntime({ lstat: (async path => path === logo && ++logoReads === 2 ? statProxy(logoStat, { isSymbolicLink: () => true }) : lstat(path)) as typeof lstat }))).rejects.toThrow('EXPORT_INVALID')
    logoReads = 0
    await expect(enforceExportRetention(exports, refs[0]!, new Set(), 3, 1_000_000, signal, exportRuntime({ lstat: (async path => path === logo && ++logoReads === 2 ? statProxy(logoStat, { isFile: () => false }) : lstat(path)) as typeof lstat }))).rejects.toThrow('EXPORT_INVALID')

    const first = join(exports, 'exports', refs[0]!); await lstat(first)
    await expect(enforceExportRetention(exports, refs[2]!, new Set(), 1, 1_000_000, signal, exportRuntime({ lstat: (async path => { const stat = await lstat(path); return refs.some(ref => String(path).endsWith(ref)) ? statProxy(stat, { mtimeMs: 1 }) : stat }) as typeof lstat }))).resolves.toBeUndefined()

    const current = join(exports, 'exports', refs[2]!); const currentStat = await lstat(current)
    await expect(enforceExportRetention(exports, refs[2]!, new Set(), 1, 1_000_000, signal, exportRuntime({ lstat: (async path => path === current ? statProxy(currentStat, { isDirectory: () => false }) : lstat(path)) as typeof lstat }))).rejects.toThrow('EXPORT_INVALID')

    const extra = join(current, 'evidence', 'extra'); await mkdir(extra)
    await expect(publishValidatedDockerArchive(exports, refs[2]!, artifact.archivePath, signal)).rejects.toThrow('EXPORT_INVALID'); await rm(extra, { recursive: true })
    await artifact.dispose()
  })

  it('fails closed on zero-byte verified reads, post-read mutation and unsafe roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-export-verify-')); roots.push(root); const source = join(root, 'source'); const exports = join(root, 'published'); await validExportTree(source)
    const artifact = await createVerifiedBuildArchive(root, 'source', await hashExportTree()); const signal = new AbortController().signal; let index = 200
    const stageRead = (path: string, flags: number) => flags === (constants.O_RDONLY | constants.O_NOFOLLOW) && path.includes('.stage-') && path.endsWith('server.js')
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, artifact.archivePath, signal, exportRuntime({ open: interceptOpen(undefined, { read: async (_target, buffer) => ({ bytesRead: 0, buffer }) }, stageRead) }))).rejects.toThrow('EXPORT_INVALID')
    let stats = 0
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, artifact.archivePath, signal, exportRuntime({ open: interceptOpen(undefined, { stat: async target => { const stat = await target.stat(); return ++stats === 2 ? statProxy(stat, { mtimeMs: stat.mtimeMs + 1 }) : stat } }, stageRead) }))).rejects.toThrow('EXPORT_INVALID')
    await expect(publishValidatedDockerArchive(exports, `build_${(++index).toString(16).padStart(32, '0')}`, artifact.archivePath, signal, exportRuntime({ lstat: (async path => path === exports ? statProxy(await lstat(path), { isDirectory: () => false }) : lstat(path)) as typeof lstat }))).rejects.toThrow('EXPORT_INVALID')
    expect(currentExportIdentity('linux', () => 42)).toEqual({ platform: 'linux', uid: 42 }); expect(currentExportIdentity('win32', undefined)).toEqual({ platform: 'win32', uid: undefined })
    expect(() => assertExportPathBeneath(root, join(root, 'child'))).not.toThrow(); expect(() => assertExportPathBeneath(root, root)).toThrow('EXPORT_INVALID'); expect(() => assertExportPathBeneath(root, `${root}-sibling`)).toThrow('EXPORT_INVALID')
    await artifact.dispose()
  })
})

async function validExportTree(source: string): Promise<void> { await mkdir(join(source, '.next', 'standalone'), { recursive: true }); await mkdir(join(source, '.next', 'static'), { recursive: true }); await mkdir(join(source, 'evidence'), { recursive: true }); await mkdir(join(source, 'public'), { recursive: true }); await writeFile(join(source, '.next', 'standalone', 'server.js'), 'server'); await writeFile(join(source, '.next', 'static', 'chunk.js'), 'chunk'); await writeFile(join(source, 'evidence', 'appspec-report.json'), '{}'); await writeFile(join(source, 'public', 'logo.svg'), 'logo') }
async function hashExportTree(): Promise<string> { const hash = createHash('sha256'); const rows: Array<[string, string]> = [['.next/standalone/server.js', 'server'], ['.next/static/chunk.js', 'chunk'], ['evidence/appspec-report.json', '{}'], ['public/logo.svg', 'logo']]; for (const [name, value] of rows) hash.update(name).update('\0').update(value).update('\0'); return hash.digest('hex') }
function tarEntry(name: string, value: string, options: { readonly type?: string; readonly declaredSize?: number } = {}): Buffer { const data = Buffer.from(value); const size = options.declaredSize ?? data.length; const header = Buffer.alloc(512); header.write(name); const octal = (offset: number, length: number, number: number) => header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii'); octal(100, 8, 0o600); octal(108, 8, 10_001); octal(116, 8, 10_001); octal(124, 12, size); octal(136, 12, 0); header.fill(0x20, 148, 156); header[156] = (options.type ?? '0').charCodeAt(0); header.write('ustar', 257); header.write('00', 263); octal(148, 8, header.reduce((sum, byte) => sum + byte, 0)); return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]) }
function checksumHeader(entry: Buffer): void { const header = entry.subarray(0, 512); header.fill(0x20, 148, 156); const value = header.reduce((sum, byte) => sum + byte, 0); header.write(`${value.toString(8).padStart(7, '0')}\0`, 148, 8, 'ascii') }
function statProxy<T extends object>(stat: T, values: Partial<Record<PropertyKey, unknown>>): T { return new Proxy(stat, { get(target, property, receiver) { return Object.prototype.hasOwnProperty.call(values, property) ? values[property] : Reflect.get(target, property, receiver) } }) }
function exportRuntime(overrides: Partial<ExportRuntime> = {}): ExportRuntime { return { lstat, mkdir, open, readdir, realpath, rename, remove: rm, writeFile, noFollowFlag: constants.O_NOFOLLOW, platform: process.platform, uid: typeof process.getuid === 'function' ? process.getuid() : undefined, randomHex: () => 'f'.repeat(16), ...overrides } }
function pathSeparator(): string { return process.platform === 'win32' ? '\\' : '/' }
type OpenHandle = Awaited<ReturnType<typeof open>>
function interceptOpen(targetPath: string | undefined, overrides: { readonly read?: (target: OpenHandle, buffer: Buffer, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number; buffer: Buffer }>; readonly write?: (target: OpenHandle, buffer: Buffer) => Promise<{ bytesWritten: number; buffer: Buffer }>; readonly stat?: (target: OpenHandle) => ReturnType<OpenHandle['stat']> }, predicate: (path: string, flags: number) => boolean = () => true): typeof open {
  return (async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    const handle = await open(path, flags, mode); const numericFlags = typeof flags === 'number' ? flags : 0
    if ((targetPath !== undefined && String(path) !== targetPath) || !predicate(String(path), numericFlags)) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'read' && overrides.read !== undefined) return (buffer: Buffer, offset: number, length: number, position: number | null) => overrides.read!(target, buffer, offset, length, position)
      if (property === 'write' && overrides.write !== undefined) return (buffer: Buffer) => overrides.write!(target, buffer)
      if (property === 'stat' && overrides.stat !== undefined) return () => overrides.stat!(target)
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value
    } })
  }) as typeof open
}
