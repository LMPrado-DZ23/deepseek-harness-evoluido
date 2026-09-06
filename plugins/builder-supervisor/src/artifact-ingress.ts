import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { PreparedArtifact } from './docker-adapter.js'
import type { BuilderAttestation } from './model.js'

export const ARTIFACT_UPLOAD_MAX_ENTRIES = 20_000
export const ARTIFACT_UPLOAD_MAX_LOGICAL_BYTES = 256 * 1024 * 1024
export const ARTIFACT_UPLOAD_MAX_FILE_BYTES = 64 * 1024 * 1024
export const ARTIFACT_UPLOAD_MAX_WIRE_BYTES = 320 * 1024 * 1024

export type ArtifactUploadState = 'RECEIVING' | 'READY' | 'CONSUMING' | 'CONSUMED' | 'FAILED'
export type ArtifactIngressErrorCode =
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_NOT_READY'
  | 'ARTIFACT_QUOTA_EXCEEDED'
  | 'ARTIFACT_TIMEOUT'
  | 'CLEANUP_INCOMPLETE'
  | 'INVALID_CONFIGURATION'

export class ArtifactIngressError extends Error {
  constructor(readonly code: ArtifactIngressErrorCode) {
    super(code)
    this.name = 'ArtifactIngressError'
  }
}

export interface ArtifactBeginInput {
  readonly buildId: string
  readonly contentLength: number
  readonly wireSha256: string
}

export interface ArtifactBeginResult {
  readonly uploadRef: string
  readonly state: ArtifactUploadState
  readonly idempotent: boolean
}

export interface ArtifactConsumeBinding {
  readonly buildId: string
  readonly attestation: BuilderAttestation
}

export interface ClaimedArtifact {
  readonly artifact: PreparedArtifact
  complete(): Promise<void>
  fail(): Promise<void>
}

export interface ArtifactIngressPort {
  begin(input: ArtifactBeginInput): Promise<ArtifactBeginResult>
  upload(uploadRef: string, source: AsyncIterable<Uint8Array>, contentLength: number, signal: AbortSignal): Promise<ArtifactBeginResult>
  abort(uploadRef: string): Promise<void>
  claim(uploadRef: string, binding: ArtifactConsumeBinding): Promise<ClaimedArtifact>
  sweep(): Promise<number>
}

interface ArtifactJournal {
  readonly version: 2
  readonly upload_ref: string
  readonly identity_sha256: string
  readonly binding_sha256: string
  readonly wire_bytes: number
  readonly claimed_wire_sha256: string
  readonly created_at: number
  readonly updated_at: number
  readonly state: ArtifactUploadState
  readonly settle_state: 'CONSUMED' | 'FAILED' | null
  readonly tar_sha256: string | null
  readonly manifest_sha256: string | null
  readonly entries: number | null
  readonly logical_bytes: number | null
}

export interface ArtifactIngressStoreOptions {
  readonly spoolRoot: string
  readonly scopeId: string
  readonly imageDigest: string
  readonly policySha256: string
  readonly maxReservedBytes?: number
  readonly receivingTtlMs?: number
  readonly readyTtlMs?: number
  readonly now?: () => number
  readonly createReference?: () => string
}

export class ArtifactIngressStore implements ArtifactIngressPort {
  readonly #root: string
  readonly #scopeId: string
  readonly #imageDigest: string
  readonly #policySha256: string
  readonly #maxReservedBytes: number
  readonly #receivingTtlMs: number
  readonly #readyTtlMs: number
  readonly #now: () => number
  readonly #createReference: () => string
  #initialized = false
  #initializing: Promise<void> | undefined
  readonly #locks = new Map<string, Promise<void>>()
  readonly #activeHandles = new Map<string, FileHandle>()
  #rootIdentity!: { readonly dev: number; readonly ino: number }
  #ownerUid: number | undefined

  constructor(options: ArtifactIngressStoreOptions) {
    if (!isAbsolute(options.spoolRoot) || options.spoolRoot.includes('\0')) throw new ArtifactIngressError('INVALID_CONFIGURATION')
    if (!/^s_[a-f0-9]{48}$/u.test(options.scopeId) || !/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest) || !/^[a-f0-9]{64}$/u.test(options.policySha256)) throw new ArtifactIngressError('INVALID_CONFIGURATION')
    this.#root = resolve(options.spoolRoot)
    this.#scopeId = options.scopeId
    this.#imageDigest = options.imageDigest
    this.#policySha256 = options.policySha256
    this.#maxReservedBytes = bounded(options.maxReservedBytes ?? ARTIFACT_UPLOAD_MAX_WIRE_BYTES * 2, 1, Number.MAX_SAFE_INTEGER)
    this.#receivingTtlMs = bounded(options.receivingTtlMs ?? 15 * 60_000, 1, 24 * 60 * 60_000)
    this.#readyTtlMs = bounded(options.readyTtlMs ?? 60 * 60_000, 1, 7 * 24 * 60 * 60_000)
    this.#now = options.now ?? Date.now
    this.#createReference = options.createReference ?? (() => `upload_${randomBytes(16).toString('hex')}`)
  }

  async begin(input: ArtifactBeginInput): Promise<ArtifactBeginResult> {
    await this.#initialize()
    await this.#assertRootIdentity()
    validateBuildId(input.buildId)
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > ARTIFACT_UPLOAD_MAX_WIRE_BYTES || !/^[a-f0-9]{64}$/u.test(input.wireSha256)) throw new ArtifactIngressError('ARTIFACT_INVALID')
    const identity = this.#identity(input.buildId)
    const binding = this.#binding(input)
    return this.#exclusive('quota', async () => {
      const journals = await this.#journals()
      const existing = journals.find(item => item.identity_sha256 === identity && item.state !== 'FAILED')
      if (existing !== undefined) {
        if (existing.binding_sha256 !== binding || existing.wire_bytes !== input.contentLength || existing.claimed_wire_sha256 !== input.wireSha256) throw new ArtifactIngressError('ARTIFACT_CONFLICT')
        return { uploadRef: existing.upload_ref, state: existing.state, idempotent: true }
      }
      const reserved = journals.filter(item => reserving(item.state)).reduce((sum, item) => sum + item.wire_bytes, 0) + await this.#quarantineBytes()
      if (reserved + input.contentLength > this.#maxReservedBytes) throw new ArtifactIngressError('ARTIFACT_QUOTA_EXCEEDED')
      const uploadRef = this.#createReference()
      validateUploadRef(uploadRef)
      if (journals.some(item => item.upload_ref === uploadRef) || await exists(this.#journalPath(uploadRef)) || await exists(this.#archivePath(uploadRef))) throw new ArtifactIngressError('ARTIFACT_CONFLICT')
      const now = this.#now()
      const journal: ArtifactJournal = { version: 2, upload_ref: uploadRef, identity_sha256: identity, binding_sha256: binding, wire_bytes: input.contentLength, claimed_wire_sha256: input.wireSha256, created_at: now, updated_at: now, state: 'RECEIVING', settle_state: null, tar_sha256: null, manifest_sha256: null, entries: null, logical_bytes: null }
      await this.#writeJournal(journal)
      return { uploadRef, state: 'RECEIVING', idempotent: false }
    })
  }

  async upload(uploadRef: string, source: AsyncIterable<Uint8Array>, contentLength: number, signal: AbortSignal): Promise<ArtifactBeginResult> {
    await this.#initialize()
    await this.#assertRootIdentity()
    validateUploadRef(uploadRef)
    return this.#exclusive(uploadRef, async () => {
      let journal = await this.#readJournal(uploadRef)
      if (journal.wire_bytes !== contentLength) throw new ArtifactIngressError('ARTIFACT_CONFLICT')
      if (journal.state === 'READY' || journal.state === 'CONSUMING' || journal.state === 'CONSUMED') return this.#verifyReplay(journal, source, signal)
      if (journal.state !== 'RECEIVING') throw new ArtifactIngressError('ARTIFACT_NOT_READY')
      const part = this.#partPath(uploadRef)
      let handle: FileHandle | undefined
      try {
        handle = await open(part, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
        const result = await streamAndValidate(source, handle, contentLength, signal)
        await handle.sync()
        await handle.close()
        handle = undefined
        if (result.tarSha256 !== journal.claimed_wire_sha256) throw new ArtifactIngressError('ARTIFACT_INVALID')
        await link(part, this.#archivePath(uploadRef))
        await unlink(part)
        await syncDirectory(this.#root)
        journal = { ...journal, state: 'READY', settle_state: null, updated_at: this.#now(), tar_sha256: result.tarSha256, manifest_sha256: result.manifestSha256, entries: result.entries, logical_bytes: result.logicalBytes }
        await this.#writeJournal(journal)
        return { uploadRef, state: 'READY', idempotent: false }
      } catch (error) {
        let cleanupFailed = false
        if (handle !== undefined) { try { await handle.close() } catch { cleanupFailed = true } }
        try { await this.#writeJournal({ ...journal, settle_state: 'FAILED', updated_at: this.#now() }) }
        catch { throw new ArtifactIngressError('CLEANUP_INCOMPLETE') }
        const partCleaned = await this.#quarantine(part, uploadRef)
        const archiveCleaned = await this.#quarantine(this.#archivePath(uploadRef), uploadRef)
        if (cleanupFailed || !partCleaned || !archiveCleaned) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
        try { await this.#writeJournal({ ...journal, state: 'FAILED', settle_state: null, updated_at: this.#now() }) }
        catch { throw new ArtifactIngressError('CLEANUP_INCOMPLETE') }
        if (error instanceof ArtifactIngressError) throw error
        if (signal.aborted) throw new ArtifactIngressError('ARTIFACT_TIMEOUT')
        throw new ArtifactIngressError('ARTIFACT_INVALID')
      }
    })
  }

  async abort(uploadRef: string): Promise<void> {
    await this.#initialize()
    await this.#assertRootIdentity()
    validateUploadRef(uploadRef)
    await this.#exclusive(uploadRef, async () => {
      const journal = await this.#readJournal(uploadRef)
      if (journal.state === 'CONSUMED' || journal.state === 'FAILED') return
      await this.#writeJournal({ ...journal, settle_state: 'FAILED', updated_at: this.#now() })
      const active = this.#activeHandles.get(uploadRef)
      let closeFailed = false
      if (active !== undefined) {
        this.#activeHandles.delete(uploadRef)
        try { await active.close() } catch { closeFailed = true }
      }
      const partCleaned = await this.#quarantine(this.#partPath(uploadRef), uploadRef)
      const archiveCleaned = await this.#quarantine(this.#archivePath(uploadRef), uploadRef)
      if (closeFailed || !partCleaned || !archiveCleaned) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
      await this.#writeJournal({ ...journal, state: 'FAILED', settle_state: null, updated_at: this.#now() })
    })
  }

  async claim(uploadRef: string, binding: ArtifactConsumeBinding): Promise<ClaimedArtifact> {
    await this.#initialize()
    await this.#assertRootIdentity()
    validateUploadRef(uploadRef)
    validateBuildId(binding.buildId)
    return this.#exclusive(uploadRef, async () => {
      let journal = await this.#readJournal(uploadRef)
      const expected = this.#binding({ buildId: binding.buildId, contentLength: journal.wire_bytes, wireSha256: journal.claimed_wire_sha256 })
      if (journal.binding_sha256 !== expected || binding.attestation.scope_id !== this.#scopeId || binding.attestation.image_id !== this.#imageDigest || binding.attestation.policy_sha256 !== this.#policySha256 || binding.attestation.state !== 'OK') throw new ArtifactIngressError('ARTIFACT_CONFLICT')
      if (journal.state !== 'READY' || journal.tar_sha256 === null || journal.manifest_sha256 === null || journal.entries === null || journal.logical_bytes === null) throw new ArtifactIngressError('ARTIFACT_NOT_READY')
      const manifestSha256 = journal.manifest_sha256
      const entries = journal.entries
      const logicalBytes = journal.logical_bytes
      const archiveHandle = await openRegularOwned(this.#archivePath(uploadRef))
      journal = { ...journal, state: 'CONSUMING', settle_state: null, updated_at: this.#now() }
      try { await this.#writeJournal(journal) }
      catch (error) {
        try { await archiveHandle.close() }
        catch { throw new ArtifactIngressError('CLEANUP_INCOMPLETE') }
        throw error
      }
      this.#activeHandles.set(uploadRef, archiveHandle)
      let settlement: Promise<void> | undefined
      const settle = async (state: 'CONSUMED' | 'FAILED') => {
        if (settlement !== undefined) return settlement
        const operation = (async () => {
          let closeError: unknown
          if (this.#activeHandles.get(uploadRef) === archiveHandle) {
            this.#activeHandles.delete(uploadRef)
            try { await archiveHandle.close() } catch (error) { closeError = error }
          }
          await this.#exclusive(uploadRef, async () => {
            const current = await this.#readJournal(uploadRef)
            if (current.state !== 'CONSUMING' || current.settle_state !== null && current.settle_state !== state) throw new ArtifactIngressError('ARTIFACT_CONFLICT')
            await this.#writeJournal({ ...current, settle_state: state, updated_at: this.#now() })
            const cleaned = await this.#quarantine(this.#archivePath(uploadRef), uploadRef)
            if (!cleaned || closeError !== undefined) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
            await this.#writeJournal({ ...current, state, settle_state: null, updated_at: this.#now() })
          })
        })()
        settlement = operation.catch(error => { settlement = undefined; throw error })
        return settlement
      }
      return {
        artifact: { archivePath: this.#archivePath(uploadRef), archiveHandle, archiveBytes: journal.wire_bytes, sha256: manifestSha256, files: entries, bytes: logicalBytes },
        complete: () => settle('CONSUMED'),
        fail: () => settle('FAILED'),
      }
    })
  }

  async sweep(): Promise<number> {
    await this.#initialize()
    await this.#assertRootIdentity()
    let swept = 0
    for (const journal of await this.#journals()) {
      const ttl = journal.state === 'RECEIVING' ? this.#receivingTtlMs : journal.state === 'READY' || journal.state === 'CONSUMING' ? this.#readyTtlMs : undefined
      if (ttl === undefined || this.#now() - journal.updated_at < ttl) continue
      await this.abort(journal.upload_ref)
      swept += 1
    }
    swept += await this.#collectQuarantine()
    return swept
  }

  async #verifyReplay(journal: ArtifactJournal, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<ArtifactBeginResult> {
    const replay = join(this.#root, `.${journal.upload_ref}.replay-${randomBytes(8).toString('hex')}`)
    let handle: FileHandle | undefined
    try {
      handle = await open(replay, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
      const result = await streamAndValidate(source, handle, journal.wire_bytes, signal)
      await handle.close(); handle = undefined
      if (result.tarSha256 !== journal.tar_sha256 || result.manifestSha256 !== journal.manifest_sha256) throw new ArtifactIngressError('ARTIFACT_CONFLICT')
      return { uploadRef: journal.upload_ref, state: journal.state, idempotent: true }
    } finally {
      let cleanupFailed = false
      if (handle !== undefined) { try { await handle.close() } catch { cleanupFailed = true } }
      try { await unlink(replay) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true }
      if (cleanupFailed) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
    }
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return
    this.#initializing ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      if (await realpath(this.#root) !== this.#root) throw new ArtifactIngressError('INVALID_CONFIGURATION')
      const root = await lstat(this.#root)
      const uid = process.getuid?.()
      if (!root.isDirectory() || root.isSymbolicLink() || process.platform !== 'win32' && (uid === undefined || root.uid !== uid || (root.mode & 0o077) !== 0)) throw new ArtifactIngressError('INVALID_CONFIGURATION')
      this.#rootIdentity = { dev: root.dev, ino: root.ino }
      this.#ownerUid = uid
      await chmod(this.#root, 0o700)
      const names = await readdir(this.#root)
      for (const name of names) if (!/^upload_[a-f0-9]{32}\.(?:json|tar)$/u.test(name) && !/^\.upload_[a-f0-9]{32}\.(?:part|replay-[a-f0-9]{16}|[a-f0-9]{16}\.tmp)$/u.test(name) && !/^\.quarantine-upload_[a-f0-9]{32}-[a-f0-9]{16}$/u.test(name)) throw new ArtifactIngressError('INVALID_CONFIGURATION')
      let journals = await this.#journals()
      for (const journal of journals) {
        const archiveExists = await exists(this.#archivePath(journal.upload_ref))
        if (journal.settle_state !== null) {
          const partCleaned = await this.#quarantine(this.#partPath(journal.upload_ref), journal.upload_ref)
          const archiveCleaned = await this.#quarantine(this.#archivePath(journal.upload_ref), journal.upload_ref)
          if (!partCleaned || !archiveCleaned) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
          await this.#writeJournal({ ...journal, state: journal.settle_state, settle_state: null, updated_at: this.#now() })
        } else if (journal.state === 'RECEIVING' && archiveExists) {
          await this.#normalizePublishedArchive(journal.upload_ref)
          const handle = await openRegularOwned(this.#archivePath(journal.upload_ref))
          try {
            const result = await validateStoredArchive(handle, journal.wire_bytes)
            if (result.tarSha256 !== journal.claimed_wire_sha256) throw new ArtifactIngressError('INVALID_CONFIGURATION')
            await this.#writeJournal({ ...journal, state: 'READY', settle_state: null, updated_at: this.#now(), tar_sha256: result.tarSha256, manifest_sha256: result.manifestSha256, entries: result.entries, logical_bytes: result.logicalBytes })
          } finally { await handle.close() }
        } else if (journal.state === 'CONSUMING') {
          if (archiveExists) await this.#writeJournal({ ...journal, state: 'READY', updated_at: this.#now() })
          else throw new ArtifactIngressError('INVALID_CONFIGURATION')
        }
      }
      journals = await this.#journals()
      for (const name of names) {
        const volatileRef = volatileUploadRef(name)
        if (volatileRef === undefined) continue
        if (!await this.#quarantine(join(this.#root, name), volatileRef)) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
        const journal = journals.find(item => item.upload_ref === volatileRef)
        if (journal !== undefined && journal.state === 'RECEIVING') await this.#writeJournal({ ...journal, state: 'FAILED', settle_state: null, updated_at: this.#now() })
      }
      journals = await this.#journals()
      for (const name of await readdir(this.#root)) {
        const match = /^(upload_[a-f0-9]{32})\.tar$/u.exec(name)
        if (match !== null && !journals.some(item => item.upload_ref === match[1]) && !await this.#quarantine(join(this.#root, name), match[1]!)) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
      }
      for (const journal of journals) {
        const archiveExists = await exists(this.#archivePath(journal.upload_ref))
        if ((journal.state === 'READY' || journal.state === 'CONSUMING') !== archiveExists) throw new ArtifactIngressError('INVALID_CONFIGURATION')
      }
      this.#initialized = true
    })()
    try { await this.#initializing } finally { if (!this.#initialized) this.#initializing = undefined }
  }

  async #journals(): Promise<ArtifactJournal[]> {
    const result: ArtifactJournal[] = []
    for (const name of await readdir(this.#root)) if (name.endsWith('.json')) result.push(await readJournalFile(join(this.#root, name), name.slice(0, -5)))
    return result
  }

  async #readJournal(uploadRef: string): Promise<ArtifactJournal> {
    try { return await readJournalFile(this.#journalPath(uploadRef), uploadRef) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactIngressError('ARTIFACT_NOT_FOUND'); throw error }
  }

  async #writeJournal(journal: ArtifactJournal): Promise<void> {
    await this.#assertRootIdentity()
    const temp = join(this.#root, `.${journal.upload_ref}.${randomBytes(8).toString('hex')}.tmp`)
    let handle: FileHandle | undefined
    try {
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
      await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8')
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temp, this.#journalPath(journal.upload_ref))
      await syncDirectory(this.#root)
    } finally {
      let cleanupFailed = false
      if (handle !== undefined) { try { await handle.close() } catch { cleanupFailed = true } }
      try { await unlink(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupFailed = true }
      if (cleanupFailed) throw new ArtifactIngressError('CLEANUP_INCOMPLETE')
    }
  }

  async #quarantine(path: string, uploadRef: string): Promise<boolean> {
    try {
      await this.#assertRootIdentity()
      await rename(path, join(this.#root, `.quarantine-${uploadRef}-${randomBytes(8).toString('hex')}`))
      await syncDirectory(this.#root)
      return true
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
  }

  async #assertRootIdentity(): Promise<void> {
    const expected = this.#rootIdentity
    const path = await realpath(this.#root)
    const current = await lstat(this.#root)
    if (path !== this.#root || !current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino ||
      process.platform !== 'win32' && (this.#ownerUid === undefined || current.uid !== this.#ownerUid || (current.mode & 0o077) !== 0)) {
      throw new ArtifactIngressError('INVALID_CONFIGURATION')
    }
  }

  async #quarantineBytes(): Promise<number> {
    let total = 0
    for (const name of await readdir(this.#root)) {
      if (!/^\.quarantine-upload_[a-f0-9]{32}-[a-f0-9]{16}$/u.test(name)) continue
      const info = await secureQuarantineInfo(join(this.#root, name), this.#ownerUid)
      total = Math.min(Number.MAX_SAFE_INTEGER, total + info.size)
    }
    return total
  }

  async #collectQuarantine(): Promise<number> {
    let collected = 0
    for (const name of await readdir(this.#root)) {
      if (!/^\.quarantine-upload_[a-f0-9]{32}-[a-f0-9]{16}$/u.test(name)) continue
      const target = join(this.#root, name)
      const info = await secureQuarantineInfo(target, this.#ownerUid)
      if (this.#now() - info.mtimeMs < this.#readyTtlMs) continue
      await unlink(target)
      await syncDirectory(this.#root)
      collected += 1
    }
    return collected
  }

  async #normalizePublishedArchive(uploadRef: string): Promise<void> {
    const archive = this.#archivePath(uploadRef)
    const part = this.#partPath(uploadRef)
    const archiveInfo = await lstat(archive)
    const partExists = await exists(part)
    const uid = this.#ownerUid
    const secure = (info: Stats) => info.isFile() && !info.isSymbolicLink() && (process.platform === 'win32' || uid !== undefined && info.uid === uid && (info.mode & 0o177) === 0)
    if (!secure(archiveInfo)) throw new ArtifactIngressError('INVALID_CONFIGURATION')
    if (partExists) {
      const partInfo = await lstat(part)
      if (!secure(partInfo) || archiveInfo.dev !== partInfo.dev || archiveInfo.ino !== partInfo.ino || archiveInfo.nlink !== 2 || partInfo.nlink !== 2) throw new ArtifactIngressError('INVALID_CONFIGURATION')
      await unlink(part)
      await syncDirectory(this.#root)
    } else if (archiveInfo.nlink !== 1) throw new ArtifactIngressError('INVALID_CONFIGURATION')
  }

  #identity(buildId: string): string { return digest([this.#scopeId, buildId]) }
  #binding(input: ArtifactBeginInput): string { return digest([this.#scopeId, input.buildId, this.#imageDigest, this.#policySha256, String(input.contentLength), input.wireSha256]) }
  #journalPath(uploadRef: string): string { return join(this.#root, `${uploadRef}.json`) }
  #archivePath(uploadRef: string): string { return join(this.#root, `${uploadRef}.tar`) }
  #partPath(uploadRef: string): string { return join(this.#root, `.${uploadRef}.part`) }

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const queued = previous.then(() => current)
    this.#locks.set(key, queued)
    await previous
    try { return await operation() } finally { release(); if (this.#locks.get(key) === queued) this.#locks.delete(key) }
  }
}

interface TarValidationResult { readonly tarSha256: string; readonly manifestSha256: string; readonly entries: number; readonly logicalBytes: number }

async function streamAndValidate(source: AsyncIterable<Uint8Array>, target: FileHandle, expectedBytes: number, signal: AbortSignal): Promise<TarValidationResult> {
  return consumeAndValidate(source, target, expectedBytes, signal)
}

async function validateStoredArchive(handle: FileHandle, expectedBytes: number): Promise<TarValidationResult> {
  const source = handle.createReadStream({ autoClose: false, start: 0 })
  try { return await consumeAndValidate(source, undefined, expectedBytes, new AbortController().signal) }
  finally { source.destroy() }
}

async function consumeAndValidate(source: AsyncIterable<Uint8Array>, target: FileHandle | undefined, expectedBytes: number, signal: AbortSignal): Promise<TarValidationResult> {
  const validator = new CanonicalUstarValidator()
  const tarHash = createHash('sha256')
  let bytes = 0
  const iterator = source[Symbol.asyncIterator]()
  while (true) {
    const next = await nextOrAbort(iterator, signal)
    if (next.done === true) break
    const raw = next.value
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    bytes += chunk.byteLength
    if (bytes > expectedBytes) throw new ArtifactIngressError('ARTIFACT_INVALID')
    tarHash.update(chunk)
    validator.feed(chunk)
    if (target !== undefined) await writeAll(target, chunk)
  }
  if (bytes !== expectedBytes) throw new ArtifactIngressError('ARTIFACT_INVALID')
  const validated = validator.finish()
  return { tarSha256: tarHash.digest('hex'), ...validated }
}

async function nextOrAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; observeIteratorReturn(iterator); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    void iterator.next().then(value => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(value) } }, error => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) } })
  })
}

function observeIteratorReturn<T>(iterator: AsyncIterator<T>): void {
  try {
    const pending = iterator.return?.()
    if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined)
  } catch { /* The abort reason remains authoritative. */ }
}

class CanonicalUstarValidator {
  readonly #block = Buffer.alloc(512)
  readonly #manifest = createHash('sha256')
  readonly #folded = new Set<string>()
  readonly #files = new Set<string>()
  #blockBytes = 0
  #remaining = 0
  #padding = 0
  #fileHash: ReturnType<typeof createHash> | undefined
  #fileName = ''
  #fileSize = 0
  #entries = 0
  #logicalBytes = 0
  #zeroBlocks = 0
  #phase: 'directories' | 'files' = 'directories'
  #lastDirectory = ''
  #lastFile = ''
  #ended = false

  feed(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.#ended) throw new ArtifactIngressError('ARTIFACT_INVALID')
      if (this.#remaining > 0) {
        const length = Math.min(this.#remaining, chunk.byteLength - offset)
        this.#fileHash!.update(chunk.subarray(offset, offset + length))
        this.#remaining -= length
        offset += length
        if (this.#remaining === 0) this.#completeFile()
        continue
      }
      if (this.#padding > 0) {
        const length = Math.min(this.#padding, chunk.byteLength - offset)
        if (!allZero(chunk, offset, offset + length)) throw new ArtifactIngressError('ARTIFACT_INVALID')
        this.#padding -= length
        offset += length
        continue
      }
      const length = Math.min(512 - this.#blockBytes, chunk.byteLength - offset)
      chunk.copy(this.#block, this.#blockBytes, offset, offset + length)
      this.#blockBytes += length
      offset += length
      if (this.#blockBytes === 512) { this.#consumeHeader(); this.#blockBytes = 0 }
    }
  }

  finish(): Omit<TarValidationResult, 'tarSha256'> {
    if (!this.#ended || this.#blockBytes !== 0 || this.#remaining !== 0 || this.#padding !== 0 || this.#entries === 0) throw new ArtifactIngressError('ARTIFACT_INVALID')
    return { manifestSha256: this.#manifest.digest('hex'), entries: this.#entries, logicalBytes: this.#logicalBytes }
  }

  #consumeHeader(): void {
    if (allZero(this.#block, 0, 512)) {
      this.#zeroBlocks += 1
      if (this.#zeroBlocks === 2) this.#ended = true
      return
    }
    if (this.#zeroBlocks !== 0) throw new ArtifactIngressError('ARTIFACT_INVALID')
    validateChecksum(this.#block)
    const type = String.fromCharCode(this.#block[156]!)
    if (type !== '0' && type !== '5') throw new ArtifactIngressError('ARTIFACT_INVALID')
    const name = decodeTarText(this.#block, 0, 100)
    const prefix = decodeTarText(this.#block, 345, 155)
    const path = prefix === '' ? name : `${prefix}/${name}`
    validateTarPath(path, type)
    const size = parseCanonicalOctal(this.#block, 124, 12)
    const mode = parseCanonicalOctal(this.#block, 100, 8)
    if (parseCanonicalOctal(this.#block, 108, 8) !== 10_001 || parseCanonicalOctal(this.#block, 116, 8) !== 10_001 || parseCanonicalOctal(this.#block, 136, 12) !== 0) throw new ArtifactIngressError('ARTIFACT_INVALID')
    if (!this.#block.subarray(257, 263).equals(Buffer.from('ustar\0')) || !this.#block.subarray(263, 265).equals(Buffer.from('00')) || !allZero(this.#block, 157, 257) || !allZero(this.#block, 265, 345) || !allZero(this.#block, 500, 512)) throw new ArtifactIngressError('ARTIFACT_INVALID')
    if ((type === '5' && (size !== 0 || mode !== 0o755)) || (type === '0' && mode !== 0o644)) throw new ArtifactIngressError('ARTIFACT_INVALID')
    const logical = path.endsWith('/') ? path.slice(0, -1) : path
    const folded = logical.normalize('NFC').toLocaleLowerCase('en-US')
    if (this.#folded.has(folded)) throw new ArtifactIngressError('ARTIFACT_INVALID')
    this.#folded.add(folded)
    this.#entries += 1
    if (this.#entries > ARTIFACT_UPLOAD_MAX_ENTRIES) throw new ArtifactIngressError('ARTIFACT_INVALID')
    if (type === '5') {
      if (this.#phase !== 'directories' || path <= this.#lastDirectory) throw new ArtifactIngressError('ARTIFACT_INVALID')
      this.#lastDirectory = path
      this.#manifest.update(`d\0${path}\0`)
      return
    }
    this.#phase = 'files'
    if (path <= this.#lastFile) throw new ArtifactIngressError('ARTIFACT_INVALID')
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) if (this.#files.has(segments.slice(0, index).join('/'))) throw new ArtifactIngressError('ARTIFACT_INVALID')
    this.#files.add(path)
    this.#lastFile = path
    this.#logicalBytes += size
    if (this.#logicalBytes > ARTIFACT_UPLOAD_MAX_LOGICAL_BYTES) throw new ArtifactIngressError('ARTIFACT_INVALID')
    if (size > ARTIFACT_UPLOAD_MAX_FILE_BYTES) throw new ArtifactIngressError('ARTIFACT_INVALID')
    this.#fileName = path
    this.#fileSize = size
    this.#fileHash = createHash('sha256')
    this.#remaining = size
    this.#padding = (512 - size % 512) % 512
    if (size === 0) this.#completeFile()
  }

  #completeFile(): void {
    const hash = this.#fileHash!.digest('hex')
    this.#manifest.update(`f\0${this.#fileName}\0${this.#fileSize}\0${hash}\0`)
    this.#fileHash = undefined
  }
}

function validateChecksum(header: Buffer): void {
  const declared = parseCanonicalOctal(header, 148, 8)
  let actual = 0
  for (let index = 0; index < header.byteLength; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index]!
  if (declared !== actual) throw new ArtifactIngressError('ARTIFACT_INVALID')
}

function parseCanonicalOctal(value: Buffer, offset: number, length: number): number {
  const field = value.subarray(offset, offset + length)
  if (field[length - 1] !== 0 || !/^[0-7]+$/u.test(field.subarray(0, -1).toString('ascii'))) throw new ArtifactIngressError('ARTIFACT_INVALID')
  const parsed = Number.parseInt(field.subarray(0, -1).toString('ascii'), 8)
  return parsed
}

function decodeTarText(value: Buffer, offset: number, length: number): string {
  const field = value.subarray(offset, offset + length)
  const zero = field.indexOf(0)
  const end = zero === -1 ? field.byteLength : zero
  if (zero !== -1 && !allZero(field, zero, field.byteLength)) throw new ArtifactIngressError('ARTIFACT_INVALID')
  try { return new TextDecoder('utf8', { fatal: true }).decode(field.subarray(0, end)) }
  catch { throw new ArtifactIngressError('ARTIFACT_INVALID') }
}

function validateTarPath(path: string, type: string): void {
  const directory = type === '5'
  const logical = directory && path.endsWith('/') ? path.slice(0, -1) : path
  if (logical === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.normalize('NFC') !== path || logical.split('/').some(part => part === '' || part === '.' || part === '..') || directory !== path.endsWith('/')) throw new ArtifactIngressError('ARTIFACT_INVALID')
}

function validateBuildId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value)) throw new ArtifactIngressError('ARTIFACT_INVALID') }
export function validateUploadRef(value: string): void { if (!/^upload_[a-f0-9]{32}$/u.test(value)) throw new ArtifactIngressError('ARTIFACT_INVALID') }
function bounded(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new ArtifactIngressError('INVALID_CONFIGURATION'); return value }
function reserving(state: ArtifactUploadState): boolean { return state === 'RECEIVING' || state === 'READY' || state === 'CONSUMING' }
function digest(parts: readonly string[]): string { const hash = createHash('sha256'); for (const part of parts) hash.update(part).update('\0'); return hash.digest('hex') }
function noFollow(): number { return constants.O_NOFOLLOW }
function allZero(value: Buffer, start: number, end: number): boolean { for (let index = start; index < end; index += 1) if (value[index] !== 0) return false; return true }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function openRegularOwned(path: string): Promise<FileHandle> {
  const resolved = await realpath(path)
  if (resolved !== path) throw new ArtifactIngressError('ARTIFACT_INVALID')
  const handle = await open(path, constants.O_RDONLY | noFollow())
  try {
    const info = await handle.stat()
    const uid = process.getuid?.()
    if (!info.isFile() || info.nlink !== 1 || process.platform !== 'win32' && ((info.mode & 0o177) !== 0 || uid !== undefined && info.uid !== uid)) throw new ArtifactIngressError('ARTIFACT_INVALID')
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function secureQuarantineInfo(path: string, uid: number | undefined): Promise<Stats> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && (info.uid !== uid || (info.mode & 0o177) !== 0)) throw new ArtifactIngressError('INVALID_CONFIGURATION')
  return info
}
async function readJournalFile(path: string, expectedRef: string): Promise<ArtifactJournal> {
  const handle = await open(path, constants.O_RDONLY | noFollow())
  try {
    const info = await handle.stat()
    const uid = process.getuid?.()
    if (!info.isFile() || info.nlink !== 1 || process.platform !== 'win32' && ((info.mode & 0o177) !== 0 || uid === undefined || info.uid !== uid) || info.size > 4_096) throw new ArtifactIngressError('INVALID_CONFIGURATION')
    const text = new TextDecoder('utf8', { fatal: true }).decode(await handle.readFile())
    const value = JSON.parse(text) as unknown
    if (!validJournal(value) || value.upload_ref !== expectedRef) throw new ArtifactIngressError('INVALID_CONFIGURATION')
    return value
  } catch (error) { if (error instanceof ArtifactIngressError) throw error; throw new ArtifactIngressError('INVALID_CONFIGURATION') }
  finally { await handle.close() }
}
function validJournal(value: unknown): value is ArtifactJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = ['binding_sha256', 'claimed_wire_sha256', 'created_at', 'entries', 'identity_sha256', 'logical_bytes', 'manifest_sha256', 'settle_state', 'state', 'tar_sha256', 'updated_at', 'upload_ref', 'version', 'wire_bytes']
  return Object.keys(row).sort().join('\0') === keys.sort().join('\0') && row.version === 2 && typeof row.upload_ref === 'string' && /^upload_[a-f0-9]{32}$/u.test(row.upload_ref) &&
    typeof row.identity_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.identity_sha256) && typeof row.binding_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.binding_sha256) &&
    typeof row.claimed_wire_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.claimed_wire_sha256) && Number.isSafeInteger(row.wire_bytes) && Number(row.wire_bytes) > 0 && Number(row.wire_bytes) <= ARTIFACT_UPLOAD_MAX_WIRE_BYTES &&
    Number.isSafeInteger(row.created_at) && Number.isSafeInteger(row.updated_at) && typeof row.state === 'string' && ['RECEIVING', 'READY', 'CONSUMING', 'CONSUMED', 'FAILED'].includes(row.state) &&
    (row.settle_state === null || row.settle_state === 'CONSUMED' || row.settle_state === 'FAILED') && nullableHash(row.tar_sha256) && nullableHash(row.manifest_sha256) && nullableCount(row.entries) && nullableCount(row.logical_bytes) && validJournalState(row)
}
function validJournalState(row: Record<string, unknown>): boolean {
  const values = [row.tar_sha256, row.manifest_sha256, row.entries, row.logical_bytes]
  const empty = values.every(value => value === null)
  const complete = values.every(value => value !== null)
  if (!empty && !complete) return false
  if (row.state === 'RECEIVING') return empty && (row.settle_state === null || row.settle_state === 'FAILED')
  if (row.state === 'READY') return complete && (row.settle_state === null || row.settle_state === 'FAILED')
  if (row.state === 'CONSUMING') return complete
  if (row.state === 'CONSUMED') return complete && row.settle_state === null
  return row.state === 'FAILED' && row.settle_state === null
}
function nullableHash(value: unknown): boolean { return value === null || typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function nullableCount(value: unknown): boolean { return value === null || Number.isSafeInteger(value) && Number(value) >= 0 }
function volatileUploadRef(name: string): string | undefined { const match = /^\.(upload_[a-f0-9]{32})\.(?:part|replay-[a-f0-9]{16}|[a-f0-9]{16}\.tmp)$/u.exec(name); return match?.[1] }
async function writeAll(handle: FileHandle, value: Buffer): Promise<void> { let offset = 0; while (offset < value.byteLength) { const { bytesWritten } = await handle.write(value, offset); if (bytesWritten === 0) throw new ArtifactIngressError('ARTIFACT_INVALID'); offset += bytesWritten } }
async function syncDirectory(path: string): Promise<void> { if (process.platform === 'win32') return; const handle = await open(path, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() } }
