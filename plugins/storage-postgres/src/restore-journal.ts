import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { link, lstat, open, opendir, rename, rm } from 'node:fs/promises'
import { assertPinnedDirectory, openNewPinnedFile, pinnedChildPath, pinParent, syncPinnedDirectory } from './safe-path.js'

export type RestoreJournalState = 'verified' | 'safety_published' | 'staging_created' | 'staged_verified' | 'swap_started' | 'committed' | 'cleanup_complete'

export interface RestoreJournal {
  v: 1
  attemptId: string
  targetSchema: string
  targetFingerprint: string
  inputSha256: string
  safetyDestination: string
  state: RestoreJournalState
  stagingSchema: string | null
  safety: { path: string; sha256: string; bytes: number } | null
  result: Record<string, unknown> | null
  updatedAt: string
}

const ORDER: readonly RestoreJournalState[] = ['verified', 'safety_published', 'staging_created', 'staged_verified', 'swap_started', 'committed', 'cleanup_complete']

export function journalReached(current: RestoreJournal, state: RestoreJournalState): boolean {
  return ORDER.indexOf(current.state) >= ORDER.indexOf(state)
}

export function assertJournalIdentity(journal: RestoreJournal, expected: Pick<RestoreJournal, 'attemptId' | 'targetSchema' | 'targetFingerprint' | 'inputSha256' | 'safetyDestination'>): void {
  if (journal.attemptId !== expected.attemptId || journal.targetSchema !== expected.targetSchema || journal.targetFingerprint !== expected.targetFingerprint || journal.inputSha256 !== expected.inputSha256 || journal.safetyDestination !== expected.safetyDestination) {
    throw new Error('O attempt-id já pertence a outra restauração, esquema ou cópia. Use outro attempt-id.')
  }
}

export function advanceJournal(current: RestoreJournal, state: RestoreJournalState, patch: Partial<Pick<RestoreJournal, 'stagingSchema' | 'safety' | 'result'>> = {}): RestoreJournal {
  if (ORDER.indexOf(state) < ORDER.indexOf(current.state)) throw new Error('O journal de restauração não pode retroceder.')
  return { ...current, ...patch, state, updatedAt: new Date().toISOString() }
}

export async function loadRestoreJournal(path: string): Promise<RestoreJournal | undefined> {
  const parent = await pinParent(path, true)
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    let file
    const journalPath = pinnedChildPath(parent.directory, parent.name)
    await recoverInterruptedReservation(parent.directory, parent.name)
    let before: BigIntStats
    try { before = await lstat(journalPath, { bigint: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n) throw new Error('Journal de restauração inválido.')
    try { file = await open(journalPath, constants.O_RDONLY | noFollow) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stats = await file.stat({ bigint: true })
      if (!stats.isFile() || stats.nlink !== 1n || stats.size > 64n * 1024n || stats.dev !== before.dev || stats.ino !== before.ino || stats.size !== before.size || stats.mtimeNs !== before.mtimeNs) {
        throw new Error('Journal de restauração inválido.')
      }
      const contents = await file.readFile('utf8')
      const after = await file.stat({ bigint: true })
      if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeNs !== stats.mtimeNs) throw new Error('Journal de restauração mudou durante a leitura.')
      const parsed: unknown = JSON.parse(contents)
      return validateJournal(parsed)
    } finally { await file.close() }
  } finally { await parent.directory.handle.close() }
}

async function recoverInterruptedReservation(
  directory: Awaited<ReturnType<typeof pinParent>>['directory'],
  name: string,
): Promise<void> {
  const destination = pinnedChildPath(directory, name)
  const final = await lstat(destination, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (final === undefined || final.nlink === 1n) return
  if (!final.isFile() || final.isSymbolicLink()) throw new Error('Journal de restauração inválido.')
  if (final.nlink !== 2n) throw new Error('Journal de restauração inválido: hardlink não autenticado.')
  await assertPinnedDirectory(directory)
  const entries = await opendir(directory.path)
  let inspected = 0
  let ownedTemporary: string | undefined
  try {
    for await (const entry of entries) {
      inspected += 1
      if (inspected > 256) throw new Error('Diretório do journal excede o limite de recuperação segura.')
      if (!entry.name.startsWith(`.${name}.`) || !entry.name.endsWith('.reserve')) continue
      const candidate = await lstat(pinnedChildPath(directory, entry.name), { bigint: true })
      if (candidate.isFile() && !candidate.isSymbolicLink() && candidate.dev === final.dev && candidate.ino === final.ino &&
          candidate.size === final.size && candidate.mtimeNs === final.mtimeNs && candidate.nlink === 2n) {
        if (ownedTemporary !== undefined) throw new Error('Journal de restauração possui publicação ambígua.')
        ownedTemporary = entry.name
      }
    }
  } finally { await entries.close().catch(() => undefined) }
  if (ownedTemporary === undefined) throw new Error('Journal de restauração inválido: hardlink não autenticado.')
  await rm(pinnedChildPath(directory, ownedTemporary))
  await syncPinnedDirectory(directory)
  const recovered = await lstat(destination, { bigint: true })
  if (!recovered.isFile() || recovered.isSymbolicLink() || recovered.nlink !== 1n || recovered.dev !== final.dev || recovered.ino !== final.ino || recovered.size !== final.size || recovered.mtimeNs !== final.mtimeNs) {
    throw new Error('Journal de restauração não pôde concluir a publicação interrompida.')
  }
}

export async function writeRestoreJournal(path: string, journal: RestoreJournal): Promise<void> {
  validateJournal(journal)
  const parent = await pinParent(path, true)
  const temporary = `.${parent.name}.${randomBytes(6).toString('hex')}.tmp`
  const serialized = `${JSON.stringify(journal)}\n`
  try {
    const destination = pinnedChildPath(parent.directory, parent.name)
    const existing = await lstat(destination, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)) {
      throw new Error('Journal de restauração existente não é um arquivo privado estável.')
    }
    const file = await openNewPinnedFile(parent.directory, temporary)
    try {
      await file.writeFile(serialized, 'utf8')
      await file.sync()
    } finally { await file.close() }
    await assertPinnedDirectory(parent.directory)
    await rename(pinnedChildPath(parent.directory, temporary), destination)
    await syncPinnedDirectory(parent.directory)
    const published = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await published.stat({ bigint: true })
      const contents = await published.readFile('utf8')
      const after = await published.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || contents !== serialized || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw new Error('Journal de restauração publicado não permaneceu estável.')
      }
    } finally { await published.close() }
  } catch (error) {
    await rm(pinnedChildPath(parent.directory, temporary), { force: true }).catch(() => undefined)
    throw error
  } finally { await parent.directory.handle.close() }
}

/**
 * Claim one instance-scoped attempt without replacing a journal another
 * PostgreSQL database may have created concurrently. The permanent path is the
 * serialization point; callers must reload and compare its identity when this
 * returns false.
 */
export async function reserveRestoreJournal(path: string, journal: RestoreJournal): Promise<boolean> {
  validateJournal(journal)
  const parent = await pinParent(path, true)
  const temporary = `.${parent.name}.${randomBytes(6).toString('hex')}.reserve`
  const serialized = `${JSON.stringify(journal)}\n`
  try {
    const file = await openNewPinnedFile(parent.directory, temporary)
    try {
      await file.writeFile(serialized, 'utf8')
      await file.sync()
    } finally { await file.close() }
    await assertPinnedDirectory(parent.directory)
    try {
      await link(pinnedChildPath(parent.directory, temporary), pinnedChildPath(parent.directory, parent.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    await rm(pinnedChildPath(parent.directory, temporary))
    await syncPinnedDirectory(parent.directory)
    return true
  } finally {
    await rm(pinnedChildPath(parent.directory, temporary), { force: true }).catch(() => undefined)
    await parent.directory.handle.close()
  }
}

function validateJournal(value: unknown): RestoreJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Journal de restauração inválido.')
  const journal = value as Partial<RestoreJournal>
  const safeAttempt = typeof journal.attemptId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/u.test(journal.attemptId)
  const safeSchema = typeof journal.targetSchema === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(journal.targetSchema)
  const safeTarget = typeof journal.targetFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(journal.targetFingerprint)
  const safeHash = typeof journal.inputSha256 === 'string' && /^[a-f0-9]{64}$/u.test(journal.inputSha256)
  const safeDestination = typeof journal.safetyDestination === 'string' && journal.safetyDestination !== ''
  const safeStaging = journal.stagingSchema === null || (typeof journal.stagingSchema === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(journal.stagingSchema))
  const safety = journal.safety as Partial<NonNullable<RestoreJournal['safety']>> | null | undefined
  const safeSafety = safety === null || (typeof safety === 'object' && safety !== undefined && typeof safety.path === 'string' && safety.path === journal.safetyDestination &&
    typeof safety.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(safety.sha256) && Number.isSafeInteger(safety.bytes) && (safety.bytes ?? 0) > 0)
  const safeResult = journal.result === null || isRestoreResult(journal.result, journal.safetyDestination)
  const safeDate = typeof journal.updatedAt === 'string' && Number.isFinite(Date.parse(journal.updatedAt))
  const stateIndex = ORDER.indexOf(journal.state as RestoreJournalState)
  const safeStatePayload = stateIndex >= 0 && (stateIndex < ORDER.indexOf('swap_started') ? journal.result === null : journal.result !== null)
  if (journal.v !== 1 || !safeAttempt || !safeSchema || !safeTarget || !safeHash || !safeDestination || !ORDER.includes(journal.state as RestoreJournalState) ||
      !safeStaging || !safeSafety || !safeResult || !safeDate || !safeStatePayload) {
    throw new Error('Journal de restauração inválido.')
  }
  return journal as RestoreJournal
}

function isRestoreResult(value: unknown, safetyDestination: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const stringArray = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.every(item => typeof item === 'string')
  const hash = result.safetyBackupSha256
  return result.mode === 'write' && Number.isSafeInteger(result.domains) && (result.domains as number) >= 1 &&
    (result.safetyBackup === null || result.safetyBackup === safetyDestination) &&
    (result.safetyBackupStatus === 'created' || result.safetyBackupStatus === 'not-needed-empty-target') &&
    (hash === null || (typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash))) &&
    stringArray(result.replacedDomains) && stringArray(result.droppedDomains) && stringArray(result.reapedStaging) && result.readyToStart === true
}
