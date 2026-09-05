import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { assertPinnedDirectory, openNewPinnedFile, pinnedChildPath, pinParent } from './safe-path.js'

export type RestoreJournalState = 'verified' | 'safety_published' | 'staging_created' | 'staged_verified' | 'swap_started' | 'committed' | 'cleanup_complete'

export interface RestoreJournal {
  v: 1
  attemptId: string
  targetSchema: string
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

export function assertJournalIdentity(journal: RestoreJournal, expected: Pick<RestoreJournal, 'attemptId' | 'targetSchema' | 'inputSha256' | 'safetyDestination'>): void {
  if (journal.attemptId !== expected.attemptId || journal.targetSchema !== expected.targetSchema || journal.inputSha256 !== expected.inputSha256 || journal.safetyDestination !== expected.safetyDestination) {
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

export async function writeRestoreJournal(path: string, journal: RestoreJournal): Promise<void> {
  validateJournal(journal)
  const parent = await pinParent(path, true)
  const temporary = `.${parent.name}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const file = await openNewPinnedFile(parent.directory, temporary)
    try {
      await file.writeFile(`${JSON.stringify(journal)}\n`, 'utf8')
      await file.sync()
    } finally { await file.close() }
    await assertPinnedDirectory(parent.directory)
    await rename(pinnedChildPath(parent.directory, temporary), pinnedChildPath(parent.directory, parent.name))
    await parent.directory.handle.sync()
  } catch (error) {
    await rm(pinnedChildPath(parent.directory, temporary), { force: true }).catch(() => undefined)
    throw error
  } finally { await parent.directory.handle.close() }
}

function validateJournal(value: unknown): RestoreJournal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Journal de restauração inválido.')
  const journal = value as Partial<RestoreJournal>
  const safeAttempt = typeof journal.attemptId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/u.test(journal.attemptId)
  const safeSchema = typeof journal.targetSchema === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(journal.targetSchema)
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
  if (journal.v !== 1 || !safeAttempt || !safeSchema || !safeHash || !safeDestination || !ORDER.includes(journal.state as RestoreJournalState) ||
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
