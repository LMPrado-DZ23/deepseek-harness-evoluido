import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface Fault {
  readonly operation: string
  readonly includes?: string
  remaining: number
  readonly code?: string
  readonly replace?: unknown
  readonly transform?: (value: unknown) => unknown
}

const faultState = vi.hoisted(() => ({ faults: [] as Fault[] }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const take = (operation: string, path: unknown): Fault | undefined => {
    const rendered = String(path)
    const fault = faultState.faults.find(item => item.operation === operation && (item.includes === undefined || rendered.includes(item.includes)))
    if (fault === undefined) return undefined
    fault.remaining -= 1
    if (fault.remaining === 0) faultState.faults.splice(faultState.faults.indexOf(fault), 1)
    return fault
  }
  const apply = async <T>(operation: string, path: unknown, invoke: () => Promise<T>): Promise<T> => {
    const fault = take(operation, path)
    if (fault?.code !== undefined) {
      if (operation === 'handle.close') await invoke()
      throw Object.assign(new Error('private filesystem detail'), { code: fault.code })
    }
    if (fault !== undefined && 'replace' in fault) return fault.replace as T
    const value = await invoke()
    return fault?.transform === undefined ? value : fault.transform(value) as T
  }
  const wrap = (handle: FileHandle, path: unknown): FileHandle => new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      return (...args: readonly unknown[]) => apply(`handle.${String(property)}`, path, async () => Reflect.apply(value, target, args) as unknown)
    },
  })
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => wrap(await apply('open', args[0], async () => actual.open(...args)), args[0]),
    lstat: async (...args: Parameters<typeof actual.lstat>) => apply('lstat', args[0], async () => actual.lstat(...args)),
    realpath: async (...args: Parameters<typeof actual.realpath>) => apply('realpath', args[0], async () => actual.realpath(...args)),
    rename: async (...args: Parameters<typeof actual.rename>) => apply('rename', args[0], async () => actual.rename(...args)),
    unlink: async (...args: Parameters<typeof actual.unlink>) => apply('unlink', args[0], async () => actual.unlink(...args)),
    link: async (...args: Parameters<typeof actual.link>) => apply('link', args[0], async () => actual.link(...args)),
  }
})

import { ArtifactIngressStore, type ArtifactIngressStoreOptions } from '../src/artifact-ingress.js'

const roots: string[] = []
const scopeId = `s_${'a'.repeat(48)}`
const imageDigest = `sha256:${'b'.repeat(64)}`
const policySha256 = 'c'.repeat(64)
const uploadRef = `upload_${'d'.repeat(32)}`
const signal = new AbortController().signal

afterEach(async () => {
  faultState.faults.length = 0
  restorePlatform()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('artifact ingress filesystem fault containment', () => {
  it.each([
    ['part close', () => fault('handle.close', '.part', 'EIO'), () => failingSource()],
    ['failed journal', () => fault('handle.writeFile', '.tmp', 'EIO'), () => failingSource()],
    ['failed journal cleanup', () => { fault('handle.writeFile', '.tmp', 'EIO'); fault('handle.close', '.tmp', 'EIO') }, () => failingSource()],
    ['zero write', () => fault('handle.write', '.part', undefined, { bytesWritten: 0 }), () => tarSource(tar())],
  ])('fails closed when upload cleanup cannot prove %s', async (_name, arrange, source) => {
    const root = await temporary('upload-fault')
    const store = create(root); const bytes = tar(); await store.begin(begin(bytes)); arrange()
    await expect(store.upload(uploadRef, source(), bytes.byteLength, signal)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:ARTIFACT_INVALID|CLEANUP_INCOMPLETE)$/u) })
  })

  it('fails closed when a failed upload cannot quarantine its part', async () => {
    const root = await temporary('upload-quarantine'); const store = create(root); const bytes = tar(); await store.begin(begin(bytes))
    fault('rename', '.part', 'EACCES')
    await expect(store.upload(uploadRef, failingSource(), bytes.byteLength, signal)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('keeps the durable cleanup intent when the terminal failure journal cannot commit', async () => {
    const root = await temporary('upload-terminal-journal'); const store = create(root); const bytes = tar(); await store.begin(begin(bytes))
    fault('handle.writeFile', '.tmp', undefined, undefined, value => value)
    fault('handle.writeFile', '.tmp', 'EIO')
    await expect(store.upload(uploadRef, failingSource(), bytes.byteLength, signal)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
    expect(JSON.parse(await readFile(join(root, `${uploadRef}.json`), 'utf8'))).toMatchObject({ state: 'RECEIVING', settle_state: 'FAILED' })
  })

  it('quarantines a published archive if publication cannot remove the part', async () => {
    const root = await temporary('publication-unlink'); const store = create(root); const bytes = tar(); await store.begin(begin(bytes))
    fault('unlink', '.part', 'EACCES')
    await expect(store.upload(uploadRef, tarSource(bytes), bytes.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    const names = await import('node:fs/promises').then(fs => fs.readdir(root))
    expect(names).not.toContain(`${uploadRef}.tar`)
    expect(names.filter(name => name.startsWith(`.quarantine-${uploadRef}`))).toHaveLength(2)
  })

  it('fails closed if a published archive cannot be quarantined', async () => {
    const root = await temporary('publication-quarantine'); const store = create(root); const bytes = tar(); await store.begin(begin(bytes))
    fault('unlink', '.part', 'EACCES'); fault('rename', '.tar', 'EACCES')
    await expect(store.upload(uploadRef, tarSource(bytes), bytes.byteLength, signal)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('contains claim journal and close failures', async () => {
    const bytes = tar()
    const journalRoot = await temporary('claim-journal'); const journalStore = create(journalRoot); await ready(journalStore, bytes)
    fault('rename', '.tmp', 'EIO')
    await expect(journalStore.claim(uploadRef, binding())).rejects.toBeDefined()

    const closeRoot = await temporary('claim-close'); const closeStore = create(closeRoot); await ready(closeStore, bytes)
    fault('rename', '.tmp', 'EIO'); fault('handle.close', '.tar', 'EIO')
    await expect(closeStore.claim(uploadRef, binding())).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('contains active-handle close, quarantine and state-race failures', async () => {
    const bytes = tar()
    const abortRoot = await temporary('abort-close'); const abortStore = create(abortRoot); await ready(abortStore, bytes); await abortStore.claim(uploadRef, binding())
    fault('handle.close', '.tar', 'EIO')
    await expect(abortStore.abort(uploadRef)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })

    const quarantineRoot = await temporary('abort-quarantine'); const quarantineStore = create(quarantineRoot); await ready(quarantineStore, bytes)
    fault('rename', '.tar', 'EACCES')
    await expect(quarantineStore.abort(uploadRef)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })

    const raceRoot = await temporary('settle-race'); const raceStore = create(raceRoot); await ready(raceStore, bytes); const claim = await raceStore.claim(uploadRef, binding())
    await raceStore.abort(uploadRef)
    await expect(claim.complete()).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
  })

  it('contains settle close and quarantine failures', async () => {
    const bytes = tar()
    const closeRoot = await temporary('settle-close'); const closeStore = create(closeRoot); await ready(closeStore, bytes); const closeClaim = await closeStore.claim(uploadRef, binding())
    fault('handle.close', '.tar', 'EIO')
    await expect(closeClaim.complete()).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })

    const quarantineRoot = await temporary('settle-quarantine'); const quarantineStore = create(quarantineRoot); await ready(quarantineStore, bytes); const quarantineClaim = await quarantineStore.claim(uploadRef, binding())
    fault('rename', '.tar', 'EACCES')
    await expect(quarantineClaim.fail()).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('contains replay close and unlink failures', async () => {
    const bytes = tar()
    const closeRoot = await temporary('replay-close'); const closeStore = create(closeRoot); await ready(closeStore, bytes)
    fault('handle.close', '.replay-', 'EIO')
    await expect(closeStore.upload(uploadRef, failingSource(), bytes.byteLength, signal)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })

    const unlinkRoot = await temporary('replay-unlink'); const unlinkStore = create(unlinkRoot); await ready(unlinkStore, bytes)
    fault('unlink', '.replay-', 'EACCES')
    await expect(unlinkStore.upload(uploadRef, tarSource(bytes), bytes.byteLength, signal)).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })

    const missingRoot = await temporary('replay-missing'); const missingStore = create(missingRoot); await ready(missingStore, bytes)
    fault('unlink', '.replay-', 'ENOENT')
    await expect(missingStore.upload(uploadRef, tarSource(bytes), bytes.byteLength, signal)).resolves.toMatchObject({ idempotent: true })
  })

  it('rejects unsafe initialization and cleanup failures', async () => {
    const bytes = tar()
    const mismatchRoot = await temporary('root-realpath'); fault('realpath', mismatchRoot, undefined, `${mismatchRoot}-other`)
    await expect(create(mismatchRoot).begin(begin(bytes))).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    const unsafeRoot = await temporary('root-stat'); fault('lstat', unsafeRoot, undefined, undefined, value => stat(value, { directory: false }))
    await expect(create(unsafeRoot).begin(begin(bytes))).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    const volatileRoot = await temporary('volatile-cleanup'); await writeVolatile(volatileRoot); fault('rename', '.part', 'EACCES')
    await expect(create(volatileRoot).sweep()).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })

    const orphanRoot = await temporary('orphan-cleanup'); await import('node:fs/promises').then(fs => fs.writeFile(join(orphanRoot, `${uploadRef}.tar`), bytes)); fault('rename', '.tar', 'EACCES')
    await expect(create(orphanRoot).sweep()).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('pins the initialized spool inode across every later filesystem effect', async () => {
    const bytes = tar()
    for (const mutation of [
      { realpath: true }, { directory: false }, { symbolic: true }, { dev: 91 }, { ino: 92 },
      { linux: true, uid: 456 }, { linux: true, mode: 0o770 },
    ]) {
      if (mutation.linux === true) setPlatform('linux', 123)
      try {
        const root = await temporary('root-identity')
        let mutateRoot = false
        if (mutation.linux === true) {
          fault('lstat', root, undefined, undefined, value => stat(value, mutateRoot ? mutation : { directory: true, mode: 0o700, uid: 123 }), 20)
          fault('handle.sync', root, undefined, null, undefined, 20)
        }
        const store = create(root); await store.begin(begin(bytes))
        mutateRoot = true
        if (mutation.realpath === true) fault('realpath', root, undefined, `${root}-replacement`)
        else if (mutation.linux !== true) fault('lstat', root, undefined, undefined, value => stat(value, mutation))
        await expect(store.sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
      } finally {
        if (mutation.linux === true) restorePlatform()
      }
    }
  })

  it('rejects every unsafe physical quarantine representation before accounting or collection', async () => {
    const bytes = tar()
    const mutations = [
      { file: false }, { symbolic: true }, { nlink: 2 }, { uid: 456 }, { mode: 0o666 },
    ]
    for (const mutation of mutations) {
      setPlatform('linux', 123)
      const root = await temporary('quarantine-attestation')
      const quarantine = join(root, `.quarantine-${uploadRef}-${'1'.repeat(16)}`)
      await import('node:fs/promises').then(fs => fs.writeFile(quarantine, 'x', { mode: 0o600 }))
      fault('lstat', root, undefined, undefined, value => stat(value, { directory: true, mode: 0o700, uid: 123 }), 2)
      fault('lstat', '.quarantine-', undefined, undefined, value => stat(value, { mode: 0o600, uid: 123, ...mutation }))
      await expect(create(root).begin({ ...begin(bytes), buildId: 'second' })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
      restorePlatform()
    }
  })

  it('fails closed when crash recovery cannot quarantine a settlement intent', async () => {
    const bytes = tar(); const root = await temporary('settlement-recovery-quarantine'); const store = create(root)
    await ready(store, bytes); const claim = await store.claim(uploadRef, binding()); await claim.artifact.archiveHandle!.close()
    const journalPath = join(root, `${uploadRef}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
    await import('node:fs/promises').then(fs => fs.writeFile(journalPath, `${JSON.stringify({ ...journal, settle_state: 'CONSUMED' })}\n`, { mode: 0o600 }))
    fault('rename', '.tar', 'EACCES')
    await expect(create(root).sweep()).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('contains journal temporary close and unlink failures', async () => {
    const bytes = tar()
    const closeRoot = await temporary('journal-close'); fault('handle.writeFile', '.tmp', 'EIO'); fault('handle.close', '.tmp', 'EIO')
    await expect(create(closeRoot).begin(begin(bytes))).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
    const unlinkRoot = await temporary('journal-unlink'); fault('handle.writeFile', '.tmp', 'EIO'); fault('unlink', '.tmp', 'EACCES')
    await expect(create(unlinkRoot).begin(begin(bytes))).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' })
  })

  it('propagates unexpected existence errors and rejects archive realpath drift', async () => {
    const bytes = tar()
    const existsRoot = await temporary('exists-error'); fault('lstat', `${uploadRef}.json`, 'EACCES')
    await expect(create(existsRoot).begin(begin(bytes))).rejects.toMatchObject({ code: 'EACCES' })
    const archiveRoot = await temporary('archive-realpath'); const store = create(archiveRoot); await ready(store, bytes); fault('realpath', '.tar', undefined, `${archiveRoot}-outside`)
    await expect(store.claim(uploadRef, binding())).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
  })

  it('exercises the Unix owner/mode and directory-fsync path with controlled stat attestations', async () => {
    setPlatform('linux', 123)
    const bytes = tar(); const root = await temporary('linux-happy')
    fault('lstat', root, undefined, undefined, value => stat(value, { directory: true, mode: 0o700, uid: 123 }), 20)
    fault('handle.stat', root, undefined, undefined, value => stat(value, { mode: 0o600, uid: 123 }), 20)
    fault('handle.sync', root, undefined, null, undefined, 20)
    const store = create(root); await ready(store, bytes); const claim = await store.claim(uploadRef, binding())
    expect(claim.artifact.archivePath).toBe(join(root, `${uploadRef}.tar`))
    expect(claim.artifact.archiveHandle).toBeDefined()
    await claim.complete()
  })

  it.each([
    ['missing uid', undefined, 0o700, 0],
    ['foreign uid', 123, 0o700, 456],
    ['open mode', 123, 0o777, 123],
  ])('rejects a Unix spool root with %s', async (_name, uid, mode, statUid) => {
    setPlatform('linux', uid)
    const root = await temporary('linux-root')
    fault('lstat', root, undefined, undefined, value => stat(value, { directory: true, mode, uid: statUid }))
    await expect(create(root).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it.each([
    ['archive mode', 123, 0o666, 123],
    ['archive owner', 123, 0o600, 456],
    ['journal missing uid', undefined, 0o600, 0],
    ['journal owner', 123, 0o600, 456],
    ['journal mode', 123, 0o666, 123],
  ])('rejects unsafe Unix file attestation: %s', async (name, uid, mode, statUid) => {
    setPlatform('linux', uid)
    const bytes = tar(); const root = await temporary('linux-file')
    fault('lstat', root, undefined, undefined, value => stat(value, { directory: true, mode: 0o700, uid: uid ?? 0 }), 20)
    fault('handle.sync', root, undefined, null, undefined, 20)
    const store = create(root)
    if (name.startsWith('archive')) {
      fault('handle.stat', '.json', undefined, undefined, value => stat(value, { mode: 0o600, uid: uid ?? 0 }), 20)
      await ready(store, bytes)
      fault('handle.stat', '.tar', undefined, undefined, value => stat(value, { mode, uid: statUid }))
      await expect(store.claim(uploadRef, binding())).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    } else {
      await import('node:fs/promises').then(fs => fs.writeFile(join(root, `${uploadRef}.json`), '{}'))
      fault('handle.stat', '.json', undefined, undefined, value => stat(value, { mode, uid: statUid }))
      await expect(store.sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    }
  })
})

function fault(operation: string, includes?: string, code?: string, replace?: unknown, transform?: (value: unknown) => unknown, remaining = 1): void { faultState.faults.push({ operation, includes, remaining, ...(code === undefined ? {} : { code }), ...('replace' in { replace } && replace !== undefined ? { replace } : {}), ...(transform === undefined ? {} : { transform }) }) }
function stat(value: unknown, options: { readonly directory?: boolean; readonly file?: boolean; readonly symbolic?: boolean; readonly mode?: number; readonly uid?: number; readonly nlink?: number; readonly dev?: number; readonly ino?: number }): unknown {
  const original = value as Stats
  return new Proxy(original, { get(target, property) { if (property === 'mode' && options.mode !== undefined) return options.mode; if (property === 'uid' && options.uid !== undefined) return options.uid; if (property === 'nlink' && options.nlink !== undefined) return options.nlink; if (property === 'dev' && options.dev !== undefined) return options.dev; if (property === 'ino' && options.ino !== undefined) return options.ino; if (property === 'isDirectory' && options.directory !== undefined) return () => options.directory; if (property === 'isFile' && options.file !== undefined) return () => options.file; if (property === 'isSymbolicLink' && options.symbolic !== undefined) return () => options.symbolic; const result = Reflect.get(target, property, target) as unknown; return typeof result === 'function' ? result.bind(target) : result } })
}
function setPlatform(platform: NodeJS.Platform, uid: number | undefined): void { Object.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: platform }); Object.defineProperty(process, 'getuid', { configurable: true, value: uid === undefined ? undefined : () => uid }) }
function restorePlatform(): void { Object.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'win32' }); Reflect.deleteProperty(process, 'getuid') }
function create(root: string, overrides: Partial<ArtifactIngressStoreOptions> = {}): ArtifactIngressStore { return new ArtifactIngressStore({ spoolRoot: root, scopeId, imageDigest, policySha256, createReference: () => uploadRef, ...overrides }) }
function begin(bytes: Uint8Array) { return { buildId: 'build-one', contentLength: bytes.byteLength, wireSha256: sha(bytes) } }
function binding() { return { buildId: 'build-one', attestation: { state: 'OK' as const, protocol_version: 1 as const, scope_id: scopeId as `s_${string}`, image_id: imageDigest as `sha256:${string}`, policy_sha256: policySha256 } } }
async function ready(store: ArtifactIngressStore, bytes: Buffer): Promise<void> { await store.begin(begin(bytes)); await store.upload(uploadRef, tarSource(bytes), bytes.byteLength, signal) }
async function temporary(name: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), `dz23-ingress-fault-${name}-`)); roots.push(root); return root }
async function writeVolatile(root: string): Promise<void> { await import('node:fs/promises').then(fs => fs.writeFile(join(root, `.${uploadRef}.part`), 'partial')) }
async function* tarSource(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes }
async function* failingSource(): AsyncGenerator<Uint8Array> { throw new Error('private stream detail') }
function sha(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function tar(): Buffer {
  const body = Buffer.from('x'); const header = Buffer.alloc(512)
  text(header, 0, 100, 'a'); octal(header, 100, 8, 0o644); octal(header, 108, 8, 10_001); octal(header, 116, 8, 10_001); octal(header, 124, 12, body.byteLength); octal(header, 136, 12, 0); header.fill(0x20, 148, 156); header[156] = 0x30; text(header, 257, 6, 'ustar'); text(header, 263, 2, '00'); checksum(header)
  return Buffer.concat([header, body, Buffer.alloc(511), Buffer.alloc(1024)])
}
function checksum(header: Buffer): void { header.fill(0x20, 148, 156); octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0)) }
function text(target: Buffer, offset: number, length: number, value: string): void { Buffer.from(value).copy(target, offset, 0, length) }
function octal(target: Buffer, offset: number, length: number, value: number): void { text(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`) }
