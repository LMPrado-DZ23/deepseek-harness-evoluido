import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from 'pg'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from './backend.js'
import { bundleRecordCount, canonicalJson, sha256, type StorageExportBundle } from './bundle.js'
import { postgresClientConnection, type PostgresClientConnection, type TlsPolicy } from './dsn.js'
import type { VerifiedStorageBundle } from './import-file.js'
import { t } from './i18n.js'
import { advanceJournal, assertJournalIdentity, journalReached, loadRestoreJournal, reserveRestoreJournal, writeRestoreJournal, type RestoreJournal } from './restore-journal.js'
import {
  assertDomainLossAllowed, assertForeignInstallationAllowed, assertRecordLossAllowed,
  assertReplacementAllowed, assertRestorableBundle, assertRestoreIntent,
  assertUnknownObjectsAllowed, postgresDumpInvocation, type RestoreRecordLoss,
} from './restore-policy.js'
import { assertPinnedDirectory, openNewPinnedFile, openNewPinnedReadWriteFile, pinnedChildPath, pinParent, syncPinnedDirectory } from './safe-path.js'
import { assertConfiguredSchemaName, assertIdentifier, INSTALLATION_ID_KEY, quoteIdentifier, STORAGE_POSTGRES_LAYOUT_VERSION, storageMaintenanceLockName, storageUnitLockName } from './schema.js'
import { readInstallation } from './snapshot.js'
import { OPERATOR_BUNDLE_MAX_BYTES, assertOperatorBundleLimit } from './operator-limits.js'

/**
 * Table this tool writes inside every staging schema it creates, in the same
 * transaction that creates the schema. It is the ONLY thing that authorises the
 * orphan sweep to drop a schema: a name that merely looks like ours is not
 * enough, and a `LIKE` pattern whose `_` was never escaped made "looks like
 * ours" wider still.
 */
const STAGING_MARKER_TABLE = 'dz23_import_staging'
const STAGING_MARKER_TOOL = 'dz23-studio/import-postgres-storage'
const RESTORE_RECEIPT_TABLE = 'dz23_restore_receipt'
const RESTORE_AUDIT_TABLE = 'studio_restore_audit'

const STUDIO_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  storage_meta: ['key', 'value'],
  units: ['name', 'version'],
  records: ['unit', 'table_name', 'key', 'value'],
  unit_globals: ['unit', 'value'],
  unit_leases: ['unit', 'holder', 'acquired_at', 'heartbeat_at'],
}

const STUDIO_OPTIONAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  storage_meta: ['text_value'],
  units: ['tables', 'has_global', 'descriptor_sha256'],
}
const AUDIT_REQUIRED_COLUMNS = [
  'restored_at', 'operator', 'target_schema', 'source_file', 'payload_sha256', 'bundle_created_at',
  'records_before', 'records_after', 'domains_before', 'domains_after', 'flags',
] as const
const AUDIT_ADDED_COLUMNS = ['installation_before', 'installation_after'] as const
const AUDIT_ALL_COLUMNS = [...AUDIT_REQUIRED_COLUMNS, ...AUDIT_ADDED_COLUMNS] as const
const STUDIO_KNOWN_TABLES = [...Object.keys(STUDIO_LAYOUT), RESTORE_AUDIT_TABLE, RESTORE_RECEIPT_TABLE]
const STUDIO_KNOWN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(Object.entries(STUDIO_LAYOUT).map(([table, columns]) => [table, [...columns, ...(STUDIO_OPTIONAL_COLUMNS[table] ?? [])]])),
  [RESTORE_AUDIT_TABLE]: AUDIT_ALL_COLUMNS,
  [RESTORE_RECEIPT_TABLE]: ['attempt_id', 'target_fingerprint', 'input_sha256', 'safety_sha256'],
}

export interface RestorePostgresOptions {
  verifiedInput: VerifiedStorageBundle
  attemptId: string
  dsn: string
  schema?: string
  ssl?: TlsPolicy
  write?: boolean
  safetyBackup?: string
  stateDirectory?: string
  force?: boolean
  allowDomainLoss?: boolean
  allowRecordLoss?: boolean
  allowUnknownObjects?: boolean
  allowForeignInstallation?: boolean
  confirmation?: string
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  maxBytes?: number
}

export interface RestoreInspectionReport {
  mode: 'dry-run'
  domains: number
  existingUnits: number
  targetDomains: string[]
  wouldBeLost: string[]
  targetSchemaExists: boolean
  targetHasContent: boolean
  recordsInBackup: number
  recordsInTarget: number
  recordLoss: RestoreRecordLoss[]
  unknownObjects: string[]
  unknownObjectCount: number
  orphanStaging: string[]
  layoutProblem: string | null
  backupInstallation: string | null
  targetInstallation: string | null
  installationAfter: string | null
}

export interface RestoreWriteReport {
  mode: 'write'
  domains: number
  safetyBackup: string | null
  safetyBackupStatus: 'created' | 'not-needed-empty-target'
  safetyBackupSha256: string | null
  replacedDomains: string[]
  droppedDomains: string[]
  reapedStaging: string[]
  recordsInBackup: number
  recordsInTarget: number
  recordLoss: RestoreRecordLoss[]
  unknownObjectsRemoved: string[]
  backupInstallation: string | null
  targetInstallation: string | null
  installationAfter: string | null
  readyToStart: true
}

export type RestorePostgresReport = RestoreInspectionReport | RestoreWriteReport

export interface PostgresStorageStatus {
  reachable: true
  serverVersion: string
  schema: string
  schemaExists: boolean
  ready: boolean
  layoutVersion: number | null
  domains: number
  condition: 'ready' | 'not-initialized' | 'unhealthy'
}

export interface RestorePostgresDependencies {
  resolveConnection?: typeof postgresClientConnection
  createClient?: (connection: PostgresClientConnection) => Client
  createBackend?: (connection: PostgresClientConnection, schema: string) => RestorableBackend
  createSafetyBackup?: (dsn: string, schema: string, output: string, ssl: TlsPolicy, environment: NodeJS.ProcessEnv, signal?: AbortSignal, resume?: boolean, maxBytes?: number, ownership?: SafetyBackupOwnership) => Promise<SafetyBackupInfo>
  now?: () => number
  suffix?: () => string
  loadJournal?: typeof loadRestoreJournal
  reserveJournal?: typeof reserveRestoreJournal
  writeJournal?: typeof writeRestoreJournal
  platform?: NodeJS.Platform
}

export interface SafetyBackupInfo { file: string; sha256: string; bytes: number }
export interface SafetyBackupOwnership { attemptId: string; targetSchema: string; targetFingerprint: string; inputSha256: string }

export interface RestorableBackend extends StorageBackend {
  waitUntilReady(): Promise<void>
  close(): Promise<void>
}

/**
 * Inspect or restore one logical Studio backup. The caller must keep every
 * Studio writer stopped until this function returns `readyToStart: true`.
 * It never starts a writer itself.
 */
export async function restorePostgresStorage(
  options: RestorePostgresOptions,
  dependencies: RestorePostgresDependencies = {},
): Promise<RestorePostgresReport> {
  const schema = options.schema ?? 'dz23_storage'
  const ssl = options.ssl ?? 'verify-full'
  const write = options.write ?? false
  assertConfiguredSchemaName(schema)
  assertAttemptId(options.attemptId)
  assertRestoreIntent(write, options.safetyBackup)
  if (write && (options.stateDirectory === undefined || options.stateDirectory === '')) {
    throw new Error(t('restore.canonicalStateRequired'))
  }
  if (write && (dependencies.platform ?? process.platform) !== 'linux') {
    throw new Error(t('restore.linuxWriteRequired'))
  }
  throwIfAborted(options.signal)
  const bundle = options.verifiedInput.bundle
  // A bundle with no domains restores nothing: it can only ever destroy. Refused before the database is even opened.
  assertRestorableBundle(bundle)
  throwIfAborted(options.signal)
  // One authority for TLS: the explicit policy decides, and every TLS parameter
  // in the DSN is stripped before node-postgres sees it.
  const resolveConnection = dependencies.resolveConnection ?? postgresClientConnection
  const connection = await resolveConnection(options.dsn, ssl)
  // The application name is operational evidence: if this process owns the exclusive
  // maintenance lock, a concurrent operator can distinguish it from a running Studio.
  const client = (dependencies.createClient ?? (value => new Client({ ...value, application_name: `dz23-storage:restore:${schema}` })))(connection)
  await client.connect()
  let staging: string | undefined
  // Point of no return for the physical swap. Once true, cleanup errors must
  // never be translated into "nothing changed", and no rollback/drop may run.
  let swapCommitted = false
  try {
    // Order matters: everything that can refuse runs BEFORE pg_dump, staging or DROP.
    if (write) await acquireMaintenanceLock(client, schema)
    const targetFingerprint = write ? await postgresTargetFingerprint(client, schema) : ''
    const backupPath = write ? resolve(options.safetyBackup!) : ''
    // One canonical attempt path per installation, schema and attempt-id. The
    // fingerprint lives INSIDE the atomically reserved journal: including it
    // in the filename would let the same attempt-id run concurrently against
    // two physical databases that share this filesystem state directory.
    const journalPath = write ? resolve(options.stateDirectory!, `${schema}.${options.attemptId}.restore.json`) : ''
    const loadJournal = dependencies.loadJournal ?? loadRestoreJournal
    const reserveJournal = dependencies.reserveJournal ?? reserveRestoreJournal
    const writeJournal = dependencies.writeJournal ?? writeRestoreJournal
    let journal = write ? await loadJournal(journalPath) : undefined
    let journalWasCreated = false
    if (write && journal === undefined) {
      const initial: RestoreJournal = {
        v: 1, attemptId: options.attemptId, targetSchema: schema, targetFingerprint,
        inputSha256: options.verifiedInput.inputSha256, state: 'verified',
        safetyDestination: backupPath, stagingSchema: null, safety: null, result: null, updatedAt: new Date().toISOString(),
      }
      journalWasCreated = await reserveJournal(journalPath, initial)
      journal = journalWasCreated ? initial : await loadJournal(journalPath)
      if (journal === undefined) throw new Error(t('restore.reservationDisappeared'))
    }
    if (journal !== undefined) {
      assertJournalIdentity(journal, {
        attemptId: options.attemptId, targetSchema: schema, targetFingerprint, inputSha256: options.verifiedInput.inputSha256, safetyDestination: backupPath,
      })
      if (journalReached(journal, 'swap_started')) {
        if (await hasRestoreReceipt(client, schema, options.attemptId, targetFingerprint, options.verifiedInput.inputSha256, journal.safety?.sha256 ?? null)) {
          await assertStudioLayout(client, schema)
          const replay = journal.result as unknown as RestoreWriteReport | null
          if (replay === null || replay.mode !== 'write' || replay.readyToStart !== true) throw new Error(t('restore.committedResultInvalid'))
          if (journal.state !== 'cleanup_complete') {
            journal = advanceJournal(journal, 'cleanup_complete')
            await writeJournal(journalPath, journal)
          }
          return replay
        }
        if (journal.state === 'committed' || journal.state === 'cleanup_complete') {
          throw new Error(t('restore.receiptMismatch'))
        }
      }
    }
    const namespace = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present',
      [schema],
    )
    const targetSchemaExists = namespace.rows[0]?.present === true
  // Everything in the target schema, not only a table named `units`: the check that decides whether
  // a `DROP SCHEMA` is allowed must not be gated on the very structure it is meant to verify — a
  // schema whose `units` is a VIEW, or which belongs to something else entirely, used to walk
  // straight through both guards below.
  // ANY object, not only relations: `pg_class` does not hold functions, types, domains, operators
  // or collations, so a schema belonging to another product that has only those looked EMPTY —
  // and an empty target skips the layout check and the confirmation, straight into DROP SCHEMA.
  // Hand-listing catalogues was still a partial list (`pg_ts_config`, `pg_ts_dict`, `pg_conversion`,
  // `pg_opclass`, `pg_extension`, ... were all missing), so the list is DERIVED from the catalogue.
    const targetHasContent = targetSchemaExists && await schemaHasContent(client, schema)
    let existingUnits = 0
    let targetDomains: string[] = []
    let recordsByUnit = new Map<string, number>()
    let globalUnits = new Set<string>()
    let unknown = { items: [] as string[], total: 0 }
    let targetInstallation: string | undefined
    let layoutProblem: string | null = null
    if (targetHasContent) {
      try {
        await assertStudioLayout(client, schema)
      } catch (error) {
        if (write) throw error
        layoutProblem = error instanceof Error ? error.message : String(error)
      }
      unknown = await unknownSchemaObjects(client, schema)
      if (layoutProblem === null) {
        const result = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(schema)}."units" ORDER BY name COLLATE "C"`)
        targetDomains = result.rows.map(row => row.name)
        existingUnits = targetDomains.length
        recordsByUnit = await countRecordsByUnit(client, schema)
        globalUnits = await readGlobalUnits(client, schema)
        targetInstallation = await readInstallation(client, schema)
      }
    }
    // A bundle that does not carry every domain the target holds would silently DESTROY the missing ones.
    const bundleDomains = new Set(bundle.domains.map(domain => domain.descriptor.name))
    const wouldBeLost = targetDomains.filter(name => !bundleDomains.has(name))
    const recordLoss: RestoreRecordLoss[] = []
    for (const domain of bundle.domains) {
      if (!targetDomains.includes(domain.descriptor.name)) continue
      const recordsInBackup = Object.values(domain.snapshot.tables).reduce((total, table) => total + Object.keys(table).length, 0)
      const recordsInTarget = recordsByUnit.get(domain.descriptor.name) ?? 0
      const globalWouldBeLost = globalUnits.has(domain.descriptor.name) && domain.snapshot.global === null
      if (recordsInBackup < recordsInTarget || globalWouldBeLost) {
        recordLoss.push({ domain: domain.descriptor.name, recordsInBackup, recordsInTarget, globalWouldBeLost })
      }
    }
    const recordsInBackup = bundleRecordCount(bundle)
    const recordsInTarget = [...recordsByUnit.values()].reduce((total, count) => total + count, 0)
    const backupInstallation = bundle.installation ?? null
    const targetInstallationValue = targetInstallation ?? null
    const installationAfter = backupInstallation ?? targetInstallationValue
    const orphanStaging = await findStagingSchemas(client, schema)
    if (!write) {
      return {
        mode: 'dry-run', domains: bundle.domains.length, existingUnits, targetDomains, wouldBeLost,
        targetSchemaExists, targetHasContent, recordsInBackup, recordsInTarget, recordLoss,
        unknownObjects: unknown.items, unknownObjectCount: unknown.total, orphanStaging,
        layoutProblem, backupInstallation, targetInstallation: targetInstallationValue, installationAfter,
      }
    }
    // Dry-run above is always a pure preview. Destructive confirmations apply
    // only when a write was explicitly requested.
    assertReplacementAllowed(targetHasContent, options.force === true, options.confirmation)
    assertDomainLossAllowed(wouldBeLost, options.allowDomainLoss === true, options.confirmation)
    assertRecordLossAllowed(recordLoss, options.allowRecordLoss === true, options.confirmation)
    assertUnknownObjectsAllowed(unknown.items, options.allowUnknownObjects === true, options.confirmation)
    assertForeignInstallationAllowed(backupInstallation, targetInstallationValue, options.allowForeignInstallation === true, options.confirmation)
    if (journal === undefined) throw new Error(t('restore.journalNotReserved'))

    throwIfAborted(options.signal)
    if (journalWasCreated && targetSchemaExists) await assertSafetyDestinationAvailable(backupPath)

    let safetyBackup: string | null = null
    let safetyBackupSha256: string | null = null
    let safetyBackupStatus: RestoreWriteReport['safetyBackupStatus'] = 'not-needed-empty-target'
    if (targetSchemaExists) {
      const createSafetyBackup = dependencies.createSafetyBackup ?? createPostgresSafetyBackup
      const safety = await createSafetyBackup(options.dsn, schema, backupPath, ssl, options.environment ?? process.env, options.signal, true, options.maxBytes, {
        attemptId: options.attemptId, targetSchema: schema, targetFingerprint, inputSha256: options.verifiedInput.inputSha256,
      })
      if (journal.safety !== null && (journal.safety.path !== safety.file || journal.safety.sha256 !== safety.sha256 || journal.safety.bytes !== safety.bytes)) {
        throw new Error(t('restore.safetyJournalMismatch'))
      }
      safetyBackup = safety.file
      safetyBackupSha256 = safety.sha256
      safetyBackupStatus = 'created'
      if (!journalReached(journal, 'safety_published')) {
        journal = advanceJournal(journal, 'safety_published', { safety: { path: safety.file, sha256: safety.sha256, bytes: safety.bytes } })
        await writeJournal(journalPath, journal)
      }
    } else if (journal.state === 'verified') {
      journal = advanceJournal(journal, 'safety_published')
      await writeJournal(journalPath, journal)
    }
    throwIfAborted(options.signal)
    // A run killed with SIGKILL leaves a full copy of the data in its staging schema, which nothing
    // would ever reap. Under the exclusive maintenance lock nobody else can own one, so the old ones
    // go now — before another copy is made.
    const orphans = await reapStagingSchemas(client, schema, orphanStaging)
    staging = `${schema.slice(0, 36)}_staging_${sha256(`${options.attemptId}\0${options.verifiedInput.inputSha256}`).slice(0, 12)}`
    assertIdentifier(staging, 'staging schema')
    // Created here, with its ownership marker, in ONE transaction: a staging schema that
    // exists but carries no marker can never happen, so the sweep above never has to guess.
    await client.query('BEGIN')
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(staging)}`)
      await client.query(`CREATE TABLE ${quoteIdentifier(staging)}.${quoteIdentifier(STAGING_MARKER_TABLE)} (
        tool TEXT NOT NULL, target_schema TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
      )`)
      await client.query(
        `INSERT INTO ${quoteIdentifier(staging)}.${quoteIdentifier(STAGING_MARKER_TABLE)} (tool, target_schema, created_at) VALUES ($1, $2, now())`,
        [STAGING_MARKER_TOOL, schema],
      )
      await client.query('COMMIT')
      if (!journalReached(journal, 'staging_created')) {
        journal = advanceJournal(journal, 'staging_created', { stagingSchema: staging })
        await writeJournal(journalPath, journal)
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    throwIfAborted(options.signal)
    const backend = (dependencies.createBackend ?? ((value, targetSchema) => new PostgresStorageBackend({ ...value, schema: targetSchema, poolMax: 4 })))(connection, staging)
    try {
      await backend.waitUntilReady()
      await importStorage(backend, bundle, options.signal)
      throwIfAborted(options.signal)
      if (installationAfter !== null) await writeInstallation(client, staging, installationAfter)
      const restoredInstallation = (await readInstallation(client, staging)) ?? null
      const restoredRecordCounts = await countRecordsByUnit(client, staging)
      const recordsAfter = [...restoredRecordCounts.values()].reduce((total, count) => total + count, 0)
      await createRestoreAuditTable(client, staging)
      if (!journalReached(journal, 'staged_verified')) {
        journal = advanceJournal(journal, 'staged_verified')
        await writeJournal(journalPath, journal)
      }
      const planned: RestoreWriteReport = {
        mode: 'write', domains: bundle.domains.length, safetyBackup, safetyBackupStatus, safetyBackupSha256,
        replacedDomains: targetDomains, droppedDomains: wouldBeLost, reapedStaging: orphans,
        recordsInBackup, recordsInTarget, recordLoss, unknownObjectsRemoved: unknown.items,
        backupInstallation, targetInstallation: targetInstallationValue, installationAfter: restoredInstallation,
        readyToStart: true,
      }
      journal = advanceJournal(journal, 'swap_started', { result: planned as unknown as Record<string, unknown> })
      await writeJournal(journalPath, journal)
      throwIfAborted(options.signal)
      await client.query('BEGIN')
      try {
        // The marker authorises orphan cleanup only. It is not part of the
        // restored product schema and must disappear before the atomic swap.
        await client.query(`DROP TABLE ${quoteIdentifier(staging)}.${quoteIdentifier(STAGING_MARKER_TABLE)}`)
        await client.query(`CREATE TABLE ${quoteIdentifier(staging)}.${quoteIdentifier(RESTORE_RECEIPT_TABLE)} (
          attempt_id TEXT PRIMARY KEY, target_fingerprint TEXT NOT NULL, input_sha256 TEXT NOT NULL, safety_sha256 TEXT
        )`)
        await client.query(
          `INSERT INTO ${quoteIdentifier(staging)}.${quoteIdentifier(RESTORE_RECEIPT_TABLE)} (attempt_id, target_fingerprint, input_sha256, safety_sha256) VALUES ($1, $2, $3, $4)`,
          [options.attemptId, targetFingerprint, options.verifiedInput.inputSha256, safetyBackupSha256],
        )
        await carryRestoreAudit(client, schema, staging)
        await insertRestoreAudit(client, staging, {
          targetSchema: schema, sourceFile: options.verifiedInput.file, payloadSha256: bundle.payloadSha256,
          bundleCreatedAt: bundle.createdAt, recordsBefore: recordsInTarget, recordsAfter,
          domainsBefore: targetDomains.length, domainsAfter: bundle.domains.length,
          flags: restoreFlags(options), installationBefore: targetInstallationValue,
          installationAfter: restoredInstallation,
        })
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        await client.query(`ALTER SCHEMA ${quoteIdentifier(staging)} RENAME TO ${quoteIdentifier(schema)}`)
        // Readiness is proved inside the same transaction as the swap. If it
        // fails, ROLLBACK restores the old target and the catch below removes
        // the still-named staging schema. Writers remain stopped throughout.
        await assertStudioLayout(client, schema)
        const restored = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(schema)}."units" ORDER BY name COLLATE "C"`)
        const expected = [...bundleDomains].sort()
        if (restored.rows.map(row => row.name).join('\0') !== expected.join('\0')) {
          throw new Error(t('restore.domainSetMismatch'))
        }
        throwIfAborted(options.signal)
        await client.query('COMMIT')
        swapCommitted = true
        staging = undefined
        journal = advanceJournal(journal, 'committed')
        try {
          await writeJournal(journalPath, journal)
        } catch (error) {
          throw postCommitReconciliationError(schema, options.attemptId, error)
        }
      } catch (error) {
        if (!swapCommitted) await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    } catch (error) {
      // Any failure leaves nothing behind: the half-filled staging schema is dropped before the error surfaces.
      await backend.close().catch(() => undefined)
      if (staging !== undefined) await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(staging)} CASCADE`).catch(() => undefined)
      throw error
    }
    const result = journal.result as unknown as RestoreWriteReport
    journal = advanceJournal(journal, 'cleanup_complete')
    try {
      await writeJournal(journalPath, journal)
    } catch (error) {
      throw postCommitReconciliationError(schema, options.attemptId, error)
    }
    return result
  } finally {
    await client.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
    await client.end()
  }
}

function postCommitReconciliationError(schema: string, attemptId: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(t('restore.postCommitReconciliation', { schema, detail, attemptId }), { cause })
}

/** Read-only operator health. No connection material is ever returned. */
export async function postgresStorageStatus(
  options: Pick<RestorePostgresOptions, 'dsn' | 'schema' | 'ssl' | 'signal'>,
  dependencies: Pick<RestorePostgresDependencies, 'resolveConnection' | 'createClient'> = {},
): Promise<PostgresStorageStatus> {
  const schema = options.schema ?? 'dz23_storage'
  const ssl = options.ssl ?? 'verify-full'
  assertConfiguredSchemaName(schema)
  throwIfAborted(options.signal)
  const resolveConnection = dependencies.resolveConnection ?? postgresClientConnection
  const connection = await resolveConnection(options.dsn, ssl)
  const client = (dependencies.createClient ?? (value => new Client(value)))(connection)
  await client.connect()
  try {
    throwIfAborted(options.signal)
    const version = await client.query<{ server_version: string }>('SHOW server_version')
    const namespace = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present', [schema],
    )
    if (namespace.rows[0]?.present !== true) {
      return { reachable: true, serverVersion: version.rows[0]?.server_version ?? 'unknown', schema, schemaExists: false, ready: false, layoutVersion: null, domains: 0, condition: 'not-initialized' }
    }
    try {
      await assertStudioLayout(client, schema)
    } catch {
      return { reachable: true, serverVersion: version.rows[0]?.server_version ?? 'unknown', schema, schemaExists: true, ready: false, layoutVersion: null, domains: 0, condition: 'unhealthy' }
    }
    throwIfAborted(options.signal)
    const layout = await client.query<{ value: number }>(
      `SELECT value FROM ${quoteIdentifier(schema)}."storage_meta" WHERE key = 'layout_version'`,
    )
    const domains = await client.query<{ count: string }>(`SELECT count(*) FROM ${quoteIdentifier(schema)}."units"`)
    return {
      reachable: true, serverVersion: version.rows[0]?.server_version ?? 'unknown', schema,
      schemaExists: true, ready: true, layoutVersion: layout.rows[0]?.value ?? null,
      domains: Number(domains.rows[0]?.count ?? 0), condition: 'ready',
    }
  } finally {
    await client.end()
  }
}

function assertAttemptId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{8,80}$/u.test(value)) throw new Error(t('restore.attemptIdInvalid'))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error(t('common.operationCancelled'))
}

async function importStorage(backend: StorageBackend, bundle: StorageExportBundle, signal: AbortSignal | undefined): Promise<void> {
  if (backend.kv === undefined) throw new Error('target backend has no KV facet')
  let importError: unknown
  try {
    for (const domain of bundle.domains) {
      throwIfAborted(signal)
      const unit = await backend.kv.open(domain.descriptor)
      let unitError: unknown
      try {
        const empty = await unit.loadAll()
        if (Object.values(empty.tables).some(table => Object.keys(table as Record<string, unknown>).length > 0) || empty.global !== null) {
          throw new Error(`target unit '${domain.descriptor.name}' is not empty`)
        }
        for (const [table, records] of Object.entries(domain.snapshot.tables)) {
          for (const [key, value] of Object.entries(records)) {
            throwIfAborted(signal)
            await unit.putRecord(table, key, value)
          }
        }
        if (domain.descriptor.hasGlobal && domain.snapshot.global !== null) await unit.setGlobal(domain.snapshot.global)
        const restored = await unit.loadAll()
        if (sha256(canonicalJson({ descriptor: domain.descriptor, snapshot: restored })) !== domain.sha256) {
          throw new Error(`checksum mismatch after importing '${domain.descriptor.name}'`)
        }
      } catch (error) {
        unitError = error
        throw error
      } finally {
        if (unitError === undefined) await unit.close()
        else await unit.close().catch(() => undefined)
      }
    }
  } catch (error) {
    importError = error
    throw error
  } finally {
    if (importError === undefined) await backend.close()
    else await backend.close().catch(() => undefined)
  }
}

/**
 * Exclusive maintenance lock over the WHOLE schema. A running Studio holds it
 * shared, so this fails while any Studio is up — including one whose open
 * units are not mentioned in the bundle, which is exactly the case a per-unit
 * lock used to let through straight into `DROP SCHEMA`. The per-unit locks are
 * still taken afterwards, as a second belt for a foreign writer that predates
 * the maintenance lock.
 */
async function acquireMaintenanceLock(client: Client, schema: string): Promise<void> {
  const maintenanceLock = storageMaintenanceLockName(schema)
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
    [maintenanceLock],
  )
  if (result.rows[0]?.acquired !== true) {
    throw new Error(await explainLockOwner(client, maintenanceLock))
  }
  const hasUnits = await client.query<{ count: string }>(
    `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = 'units'`,
    [schema],
  )
  const units = hasUnits.rows[0]?.count === '0'
    ? { rows: [] as { name: string }[] }
    : await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(schema)}."units"`)
  for (const row of units.rows) {
    const unit = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [storageUnitLockName(schema, row.name)],
    )
    if (unit.rows[0]?.acquired !== true) {
      throw new Error(await explainLockOwner(client, storageUnitLockName(schema, row.name)))
    }
  }
}

interface LockOwnerRow { pid: number; application_name: string; started: string }

/** Explain a contended advisory lock without telling an operator to stop the wrong process. */
async function explainLockOwner(client: Client, lockName: string): Promise<string> {
  let holders: { rows: LockOwnerRow[] }
  try {
    holders = await client.query<LockOwnerRow>(
      `SELECT a.pid, coalesce(a.application_name, '') AS application_name,
             to_char(a.backend_start, 'DD/MM/YYYY HH24:MI') AS started
       FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
        AND l.objid::bigint = (hashtext($1)::bigint & 4294967295)
        AND a.pid <> pg_backend_pid()
      ORDER BY a.backend_start`,
      [lockName],
    )
  } catch {
    // The lock is still contended; a failed inspection is not evidence that its holder vanished.
    // Give no operational advice based on an identity we could not establish.
    return t('restore.lockInspectionUnavailable')
  }
  const studios = holders.rows.filter(row => row.application_name.startsWith('dz23-storage:maintenance:'))
  if (studios.length > 0) {
    return t('restore.lockHeldByStudio', {
      pids: studios.map(row => String(row.pid)).join(', '),
      started: studios[0]!.started,
    })
  }
  const restores = holders.rows.filter(row => row.application_name.startsWith('dz23-storage:restore:'))
  if (restores.length > 0) {
    return t('restore.lockHeldByRestore', {
      pids: restores.map(row => String(row.pid)).join(', '),
      started: restores[0]!.started,
    })
  }
  if (holders.rows.length > 0) {
    return t('restore.lockHeldByOther', {
      owners: holders.rows.map(row => `${String(row.pid)}${row.application_name === '' ? '' : ` (${row.application_name})`}`).join(', '),
    })
  }
  return t('restore.lockOwnerVanished')
}

/** A schema that has a `units` table but not the rest of the layout is not a Studio schema: refuse instead of dropping it. */

async function assertStudioLayout(client: Client, schema: string): Promise<void> {
  const expected = Object.keys(STUDIO_LAYOUT)
  // Real tables only (`relkind = 'r'`): a VIEW named `units` is not this Studio's storage.
  const found = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2)`,
    [schema, expected],
  )
  const names = new Set(found.rows.map(row => row.relname))
  const missing = expected.filter(table => !names.has(table))
  if (missing.length > 0) {
    throw new Error(t('restore.layoutTablesMissing', { schema, missing: missing.join(', ') }))
  }
  // Columns too: a table with the right name and the wrong shape is not the right table.
  const columns = await client.query<{ relname: string; attname: string }>(
    `SELECT c.relname, a.attname FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2) AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, expected],
  )
  const byTable = new Map<string, Set<string>>()
  for (const row of columns.rows) {
    const set = byTable.get(row.relname) ?? new Set<string>()
    set.add(row.attname)
    byTable.set(row.relname, set)
  }
  for (const [table, required] of Object.entries(STUDIO_LAYOUT)) {
    const present = byTable.get(table) ?? new Set<string>()
    const absent = required.filter(column => !present.has(column))
    if (absent.length > 0) {
      throw new Error(t('restore.layoutColumnsMissing', { table, schema, missing: absent.join(', ') }))
    }
  }
  const layout = await client.query<{ value: number }>(
    `SELECT value FROM ${quoteIdentifier(schema)}."storage_meta" WHERE key = 'layout_version'`,
  )
  if (layout.rows[0] === undefined) {
    throw new Error(t('restore.layoutVersionMissing', { schema }))
  }
  if (layout.rows[0].value !== STORAGE_POSTGRES_LAYOUT_VERSION) {
    throw new Error(t('restore.layoutVersionMismatch', {
      schema,
      actual: String(layout.rows[0].value),
      expected: STORAGE_POSTGRES_LAYOUT_VERSION,
    }))
  }
}

export async function createPostgresSafetyBackup(
  dsn: string,
  schema: string,
  output: string,
  ssl: TlsPolicy,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  resume = false,
  maxBytes = OPERATOR_BUNDLE_MAX_BYTES,
  ownership?: SafetyBackupOwnership,
): Promise<SafetyBackupInfo> {
  if (process.platform !== 'linux') throw new Error(t('restore.safetyLinuxRequired'))
  assertOperatorBundleLimit(maxBytes, 'safety backup maxBytes')
  if (ownership === undefined) throw new Error(t('restore.safetyIdentityRequired'))
  // The connection string is handed over almost whole — decomposing it into host/port/user
  // dropped every other libpq parameter the operator had set (`hostaddr`, `options`, ...), so
  // the dump could reach a different endpoint than the import it is protecting. What IS taken
  // out of it: the password and every TLS parameter. A command line is readable by every user
  // on the machine (`ps -ef`), so the password travels in the child's environment, and the TLS
  // policy is re-supplied there too, where the stripped URI can no longer contradict it.
  const invocation = postgresDumpInvocation(dsn, schema, ssl, environment)
  const parent = await pinParent(output, true)
  const ownerKey = sha256(canonicalJson(ownership)).slice(0, 24)
  const partial = `.${parent.name}.partial-${ownerKey}`
  const partialSidecar = `${partial}.sha256`
  let destination: FileHandle | undefined
  try {
    await reserveSafetyDestination(parent.directory, parent.name, ownership)
    await collapseOwnedPublicationLink(parent.directory, parent.name, partial)
    await collapseOwnedPublicationLink(parent.directory, `${parent.name}.sha256`, partialSidecar)
    if (resume) {
      try {
        return await inspectPublishedSafetyBackup(parent.directory, parent.name, environment, signal, maxBytes)
      } catch (error) {
        if (signal?.aborted === true) throw error
        const recovered = await recoverPublishedSafetyBackup(parent.directory, parent.name, resolve(output), environment, signal, maxBytes)
        if (recovered !== undefined) return recovered
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // A sidecar without its data can only be an interrupted publication by
        // this journal-owned attempt. It is not a commit marker and is safe to
        // remove before producing a new pair.
        await assertPinnedDirectory(parent.directory)
        await rm(pinnedChildPath(parent.directory, `${parent.name}.sha256`), { force: true })
      }
    } else {
      const existing = await lstat(pinnedChildPath(parent.directory, parent.name))
        .then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        })
      if (existing) throw new Error(t('restore.backupDestinationExists', { output }))
    }
    // Only the exact owner marker above authorises reaping these deterministic
    // crash remnants. A different database/attempt cannot reach this point.
    await rm(pinnedChildPath(parent.directory, partial), { force: true })
    await rm(pinnedChildPath(parent.directory, partialSidecar), { force: true })
    await syncPinnedDirectory(parent.directory)
    destination = await openNewPinnedReadWriteFile(parent.directory, partial)
    throwIfAborted(signal)
    await runBoundedPgDump(invocation.command, invocation.args, invocation.environment, destination, maxBytes, signal)
    throwIfAborted(signal)
    await destination.sync()
    const info = await inspectSafetyHandle(destination, pinnedChildPath(parent.directory, partial), resolve(output), environment, signal, maxBytes)
    const sidecar = await openNewPinnedFile(parent.directory, partialSidecar)
    try {
      await sidecar.writeFile(`${info.sha256}  ${parent.name}\n`, { encoding: 'utf8' })
      await sidecar.sync()
    } finally {
      await sidecar.close()
    }
    await assertPinnedDirectory(parent.directory)
    await destination.close()
    destination = undefined
    await link(pinnedChildPath(parent.directory, partial), pinnedChildPath(parent.directory, parent.name))
    await rm(pinnedChildPath(parent.directory, partial))
    await syncPinnedDirectory(parent.directory)
    await link(pinnedChildPath(parent.directory, partialSidecar), pinnedChildPath(parent.directory, `${parent.name}.sha256`))
    await rm(pinnedChildPath(parent.directory, partialSidecar))
    await syncPinnedDirectory(parent.directory)
    return info
  } catch (error) {
    await destination?.close().catch(() => undefined)
    await assertPinnedDirectory(parent.directory)
    await rm(pinnedChildPath(parent.directory, partial), { force: true }).catch(() => undefined)
    await rm(pinnedChildPath(parent.directory, partialSidecar), { force: true }).catch(() => undefined)
    throw error
  } finally {
    await parent.directory.handle.close().catch(() => undefined)
  }
}

async function reserveSafetyDestination(
  directory: Awaited<ReturnType<typeof pinParent>>['directory'],
  name: string,
  ownership: SafetyBackupOwnership,
): Promise<void> {
  assertAttemptId(ownership.attemptId)
  assertIdentifier(ownership.targetSchema, 'target schema')
  if (!/^[a-f0-9]{64}$/u.test(ownership.inputSha256)) throw new Error(t('restore.safetyIdentityInvalid'))
  if (!/^[a-f0-9]{64}$/u.test(ownership.targetFingerprint)) throw new Error(t('restore.safetyTargetIdentityInvalid'))
  const ownerName = `${name}.owner.json`
  const expected = `${JSON.stringify({ v: 1, ...ownership })}\n`
  const ownerPartial = `.${ownerName}.partial-${sha256(expected).slice(0, 24)}`
  await collapseOwnedPublicationLink(directory, ownerName, ownerPartial)
  try {
    const marker = await openNewPinnedFile(directory, ownerPartial)
    try {
      await marker.writeFile(expected, 'utf8')
      await marker.sync()
    } finally { await marker.close() }
    await link(pinnedChildPath(directory, ownerPartial), pinnedChildPath(directory, ownerName))
    await rm(pinnedChildPath(directory, ownerPartial))
    await syncPinnedDirectory(directory)
    return
  } catch (error) {
    await rm(pinnedChildPath(directory, ownerPartial), { force: true }).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const markerPath = pinnedChildPath(directory, ownerName)
  const before = await lstat(markerPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n) {
    throw new Error(t('restore.safetyDestinationOwnedByOtherAttempt'))
  }
  const marker = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stats = await marker.stat({ bigint: true })
    const contents = await marker.readFile('utf8')
    const after = await marker.stat({ bigint: true })
    if (!stats.isFile() || stats.nlink !== 1n || stats.size > 1024n || stats.dev !== before.dev || stats.ino !== before.ino || stats.mtimeNs !== before.mtimeNs ||
        after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeNs !== stats.mtimeNs || contents !== expected) {
      throw new Error(t('restore.safetyDestinationOwnedByOtherAttempt'))
    }
  } finally { await marker.close() }
}

async function collapseOwnedPublicationLink(
  directory: Awaited<ReturnType<typeof pinParent>>['directory'],
  finalName: string,
  temporaryName: string,
): Promise<void> {
  const finalPath = pinnedChildPath(directory, finalName)
  const final = await lstat(finalPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (final === undefined || final.nlink === 1n) return
  if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 2n) {
    throw new Error(t('restore.safetyDestinationUnauthenticatedHardlink'))
  }
  const temporaryPath = pinnedChildPath(directory, temporaryName)
  const temporary = await lstat(temporaryPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (temporary === undefined || !temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 2n ||
      temporary.dev !== final.dev || temporary.ino !== final.ino || temporary.size !== final.size || temporary.mtimeNs !== final.mtimeNs) {
    throw new Error(t('restore.safetyDestinationUnauthenticatedHardlink'))
  }
  await rm(temporaryPath)
  await syncPinnedDirectory(directory)
  const recovered = await lstat(finalPath, { bigint: true })
  if (!recovered.isFile() || recovered.isSymbolicLink() || recovered.nlink !== 1n || recovered.dev !== final.dev || recovered.ino !== final.ino || recovered.size !== final.size || recovered.mtimeNs !== final.mtimeNs) {
    throw new Error(t('restore.safetyInterruptedPublicationFailed'))
  }
}

async function recoverPublishedSafetyBackup(
  directory: Awaited<ReturnType<typeof pinParent>>['directory'],
  name: string,
  reportedPath: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<SafetyBackupInfo | undefined> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  let file: FileHandle
  try {
    file = await openPrivatePinnedExistingFile(directory, name, maxBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const info = await inspectSafetyHandle(file, pinnedChildPath(directory, name), reportedPath, environment, signal, maxBytes)
    try {
      const existingSidecar = await openPrivatePinnedExistingFile(directory, `${name}.sha256`, 1024)
      await existingSidecar.close()
      // A present but invalid marker is not repaired silently: it may describe
      // a different operator action and needs manual inspection.
      throw new Error(t('restore.safetyExistingSidecarInvalid'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const marker = await openNewPinnedFile(directory, `${name}.sha256`)
    try {
      await marker.writeFile(`${info.sha256}  ${name}\n`, 'utf8')
      await marker.sync()
    } finally { await marker.close() }
    await syncPinnedDirectory(directory)
    return info
  } finally { await file.close() }
}

async function inspectPublishedSafetyBackup(directory: Awaited<ReturnType<typeof pinParent>>['directory'], name: string, environment: NodeJS.ProcessEnv, signal: AbortSignal | undefined, maxBytes: number): Promise<SafetyBackupInfo> {
  const file = await openPrivatePinnedExistingFile(directory, name, maxBytes)
  try {
    const info = await inspectSafetyHandle(file, pinnedChildPath(directory, name), resolve(directory.path, name), environment, signal, maxBytes)
    const sidecar = await openPrivatePinnedExistingFile(directory, `${name}.sha256`, 1024)
    try {
      const before = await sidecar.stat({ bigint: true })
      const contents = await sidecar.readFile('utf8')
      const after = await sidecar.stat({ bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw new Error(t('restore.safetySidecarChanged'))
      }
      const expected = contents.trim().split(/\s+/u)[0]
      if (expected !== info.sha256) throw new Error(t('restore.safetySidecarMismatch'))
    } finally {
      await sidecar.close()
    }
    return info
  } finally {
    await file.close()
  }
}

async function assertSafetyDestinationAvailable(output: string): Promise<void> {
  const parent = await pinParent(output, true)
  try {
    for (const name of [parent.name, `${parent.name}.sha256`, `${parent.name}.owner.json`]) {
      try {
        await lstat(pinnedChildPath(parent.directory, name))
        throw new Error(t('restore.backupDestinationExists', { output }))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
  } finally { await parent.directory.handle.close() }
}

async function openPrivatePinnedExistingFile(
  directory: Awaited<ReturnType<typeof pinParent>>['directory'],
  name: string,
  maxBytes: number,
): Promise<FileHandle> {
  const path = pinnedChildPath(directory, name)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
    throw new Error(t('restore.safetyFileInvalid'))
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const after = await file.stat({ bigint: true })
    if (!after.isFile() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      throw new Error(t('restore.safetyFileChangedWhileOpening'))
    }
    return file
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
}

async function inspectSafetyHandle(file: FileHandle, path: string, reportedPath: string, environment: NodeJS.ProcessEnv, signal: AbortSignal | undefined, maxBytes: number): Promise<SafetyBackupInfo> {
  const stats = await file.stat({ bigint: true })
  if (!stats.isFile() || stats.nlink !== 1n || stats.size === 0n) throw new Error(t('restore.pgDumpEmpty'))
  if (stats.size > BigInt(maxBytes)) throw new Error(t('restore.safetyTooLarge', { maxBytes }))
  const hash = createHash('sha256')
  const block = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  for (;;) {
    throwIfAborted(signal)
    const chunk = await file.read(block, 0, block.byteLength, offset)
    if (chunk.bytesRead === 0) break
    hash.update(block.subarray(0, chunk.bytesRead))
    offset += chunk.bytesRead
  }
  await runTool('pg_restore', ['--list', '/proc/self/fd/3'], { PATH: environment.PATH, LANG: environment.LANG, LC_ALL: environment.LC_ALL }, signal, file.fd)
  const after = await file.stat({ bigint: true })
  if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeNs !== stats.mtimeNs) {
    throw new Error(t('restore.safetyChangedWhileVerifying'))
  }
  return { file: reportedPath, sha256: hash.digest('hex'), bytes: offset }
}

async function runTool(command: string, args: string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal, inheritedFd?: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    // A saída de erro É LIDA e limitada, pela mesma razão que a do `pg_dump`:
    // "pg_restore failed with code 1" e mais nada deixava quem opera sem a
    // única linha que explica por que a verificação do backup não passou.
    const child = spawn(command, args, { env: environment, stdio: inheritedFd === undefined ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', inheritedFd], ...(signal === undefined ? {} : { signal }) })
    let diagnostic = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (diagnostic.length < PG_DUMP_DIAGNOSTIC_LIMIT) {
        diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(0, PG_DUMP_DIAGNOSTIC_LIMIT)
      }
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) { resolvePromise(); return }
      const detail = pgDumpDiagnostic(diagnostic)
      reject(new Error(`${command} failed with code ${String(code)}${detail === '' ? '' : `: ${detail}`}`))
    })
  })
}

/** Teto do diagnóstico do pg_dump: o suficiente para entender, longe de um dreno. */
const PG_DUMP_DIAGNOSTIC_LIMIT = 2_000

/**
 * Última linha útil do erro do pg_dump, sem caminho absoluto e sem quebra de
 * linha. É diagnóstico, não conteúdo: a mensagem do pg_dump não cita dado da
 * base, e o que ela cita de ambiente é reduzido ao nome do arquivo.
 */
function pgDumpDiagnostic(raw: string): string {
  const lines = raw.split('\n').map(line => line.trim()).filter(line => line !== '')
  const last = lines.at(-1)
  if (last === undefined) return ''
  return last.replace(/(\/[^\s:]+)+/gu, match => match.slice(match.lastIndexOf('/') + 1)).slice(0, 300)
}

async function runBoundedPgDump(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  destination: FileHandle,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const child = spawn(command, args, {
    env: environment,
    // A saída de erro do pg_dump é lida e LIMITADA. Antes ela era descartada, e
    // quem operava recebia "pg_dump failed with code 1" e mais nada - um beco
    // sem saída na hora exata em que a pessoa precisa entender por que o
    // backup de segurança não saiu.
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(signal === undefined ? {} : { signal }),
  })
  let diagnostic = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (diagnostic.length < PG_DUMP_DIAGNOSTIC_LIMIT) {
      diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(0, PG_DUMP_DIAGNOSTIC_LIMIT)
    }
  })
  const exited = new Promise<{ code: number | null; error?: Error }>(resolvePromise => {
    let settled = false
    child.once('error', error => {
      if (!settled) { settled = true; resolvePromise({ code: null, error }) }
    })
    child.once('exit', code => {
      if (!settled) { settled = true; resolvePromise({ code }) }
    })
  })
  let bytes = 0
  try {
    if (child.stdout === null) throw new Error(t('restore.pgDumpStdoutUnavailable'))
    for await (const chunk of child.stdout) {
      throwIfAborted(signal)
      const buffer = chunk as Buffer
      bytes += buffer.byteLength
      if (bytes > maxBytes) {
        child.kill('SIGKILL')
        throw new Error(t('restore.safetyTooLarge', { maxBytes }))
      }
      await destination.write(buffer)
    }
    const outcome = await exited
    if (outcome.error !== undefined) throw outcome.error
    if (outcome.code !== 0) {
      const detail = pgDumpDiagnostic(diagnostic)
      throw new Error(`pg_dump failed with code ${String(outcome.code)}${detail === '' ? '' : `: ${detail}`}`)
    }
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

export { postgresDumpInvocation } from './restore-policy.js'

/**
 * Does the schema hold ANYTHING? The answer decides whether `DROP SCHEMA` may
 * run without the spoken confirmation, so a partial answer is a data-loss bug:
 * a schema holding only a TEXT SEARCH CONFIGURATION, a conversion, an operator
 * class or an extension looked empty to a hand-written list of catalogues.
 *
 * So the catalogues are not hand-written: every `pg_catalog` table with an
 * `oid` column named `*namespace` IS, by definition, a catalogue whose rows
 * belong to a schema. Their names come from the catalogue itself and are still
 * checked against a strict identifier pattern before being interpolated.
 */
async function schemaHasContent(client: Client, schema: string): Promise<boolean> {
  const catalogs = await client.query<{ relname: string; attname: string }>(
    `SELECT c.relname, a.attname
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'pg_catalog' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.atttypid = 'oid'::regtype AND a.attname LIKE '%namespace'`,
  )
  if (catalogs.rows.length === 0) {
    throw new Error(t('restore.catalogInspectionFailed'))
  }
  const safe = /^[a-z][a-z0-9_]*$/u
  const clauses = catalogs.rows.map(row => {
    if (!safe.test(row.relname) || !safe.test(row.attname)) {
      throw new Error(t('restore.unexpectedCatalogName', { name: `${row.relname}.${row.attname}` }))
    }
    return `EXISTS (SELECT 1 FROM pg_catalog."${row.relname}" WHERE "${row.attname}" = target.oid)`
  })
  const present = await client.query<{ present: boolean }>(
    `SELECT COALESCE((SELECT ${clauses.join(' OR ')} FROM pg_catalog.pg_namespace target WHERE target.nspname = $1), false) AS present`,
    [schema],
  )
  return present.rows[0]?.present === true
}

async function postgresTargetFingerprint(client: Client, schema: string): Promise<string> {
  const identity = await client.query<{ system_identifier: string; database_oid: string; database_name: string }>(
    `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
            d.oid::text AS database_oid,
            d.datname AS database_name
       FROM pg_catalog.pg_database d
      WHERE d.datname = current_database()`,
  )
  const row = identity.rows[0]
  if (row === undefined || !/^\d+$/u.test(row.system_identifier) || !/^\d+$/u.test(row.database_oid) || row.database_name === '') {
    throw new Error(t('restore.physicalIdentityFailed'))
  }
  return sha256(canonicalJson({
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    schema,
    systemIdentifier: row.system_identifier,
  }))
}

async function hasRestoreReceipt(client: Client, schema: string, attemptId: string, targetFingerprint: string, inputSha256: string, safetySha256: string | null): Promise<boolean> {
  const present = await client.query<{ present: boolean }>(
    'SELECT to_regclass(format(\'%I.%I\', $1, $2)) IS NOT NULL AS present',
    [schema, RESTORE_RECEIPT_TABLE],
  )
  if (present.rows[0]?.present !== true) return false
  const receipt = await client.query<{ target_fingerprint: string; input_sha256: string; safety_sha256: string | null }>(
    `SELECT target_fingerprint, input_sha256, safety_sha256 FROM ${quoteIdentifier(schema)}.${quoteIdentifier(RESTORE_RECEIPT_TABLE)} WHERE attempt_id = $1`,
    [attemptId],
  )
  return receipt.rows[0]?.target_fingerprint === targetFingerprint && receipt.rows[0]?.input_sha256 === inputSha256 && receipt.rows[0]?.safety_sha256 === safetySha256
}

interface UnknownObjects { items: string[]; total: number }
const INVENTORY_SAMPLE = 3
const CATALOG_LABELS: Readonly<Record<string, string>> = {
  pg_proc: t('catalog.function'), pg_type: t('catalog.type'), pg_operator: t('catalog.operator'), pg_opclass: t('catalog.operatorClass'),
  pg_opfamily: t('catalog.operatorFamily'), pg_conversion: t('catalog.conversion'), pg_collation: t('catalog.collation'),
  pg_ts_config: t('catalog.textSearchConfiguration'), pg_ts_dict: t('catalog.textSearchDictionary'),
  pg_ts_parser: t('catalog.textSearchParser'), pg_ts_template: t('catalog.textSearchTemplate'),
  pg_statistic_ext: t('catalog.extendedStatistic'), pg_extension: t('catalog.extension'), pg_default_acl: t('catalog.defaultPrivilege'),
}
const CATALOG_BYPRODUCTS: Readonly<Record<string, string>> = {
  pg_class: 'false',
  pg_type: `typrelid = 0 AND NOT (typtype = 'b' AND typcategory = 'A')`,
  pg_constraint: 'false',
}

/** Every schema-scoped object this build cannot preserve across DROP SCHEMA. */
async function unknownSchemaObjects(client: Client, schema: string): Promise<UnknownObjects> {
  const found: Array<{ kind: string; name: string }> = []
  const relations = await client.query<{ relname: string; relkind: string }>(
    `SELECT c.relname, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind NOT IN ('i', 'I', 't') AND NOT (c.relname = ANY($2))
      ORDER BY c.relname COLLATE "C"`,
    [schema, STUDIO_KNOWN_TABLES],
  )
  const relationKinds: Readonly<Record<string, string>> = {
    r: t('catalog.table'), p: t('catalog.partitionedTable'), v: t('catalog.view'), m: t('catalog.materializedView'),
    S: t('catalog.sequence'), f: t('catalog.foreignTable'), c: t('catalog.compositeType'),
  }
  for (const row of relations.rows) found.push({ kind: relationKinds[row.relkind] ?? t('catalog.object'), name: row.relname })

  const catalogs = await client.query<{ catalog: string; nsattr: string; nameattr: string | null }>(
    `SELECT c.relname AS catalog,
            (SELECT a.attname FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 AND a.atttypid = 'oid'::regtype AND a.attname LIKE '%namespace' ORDER BY a.attnum LIMIT 1) AS nsattr,
            (SELECT a.attname FROM pg_catalog.pg_attribute a
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 AND a.atttypid = 'name'::regtype ORDER BY a.attnum LIMIT 1) AS nameattr
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pg_catalog' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                       AND a.atttypid = 'oid'::regtype AND a.attname LIKE '%namespace')
      ORDER BY c.relname COLLATE "C"`,
  )
  if (catalogs.rows.length === 0) throw new Error(t('restore.objectInspectionFailed'))
  const safe = /^[a-z][a-z0-9_]*$/u
  for (const catalog of catalogs.rows) {
    const filter = CATALOG_BYPRODUCTS[catalog.catalog] ?? 'true'
    if (filter === 'false') continue
    if (!safe.test(catalog.catalog) || !safe.test(catalog.nsattr) || (catalog.nameattr !== null && !safe.test(catalog.nameattr))) {
      throw new Error(t('restore.unexpectedCatalogName', { name: catalog.catalog }))
    }
    const naming = catalog.nameattr === null ? 'oid::text' : `"${catalog.nameattr}"::text`
    const rows = await client.query<{ name: string }>(
      `SELECT ${naming} AS name FROM pg_catalog."${catalog.catalog}"
        WHERE "${catalog.nsattr}" = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1) AND (${filter})
        ORDER BY (${naming}) COLLATE "C"`,
      [schema],
    )
    const label = CATALOG_LABELS[catalog.catalog] ?? t('catalog.objectOf', { catalog: catalog.catalog })
    for (const row of rows.rows) found.push({ kind: label, name: row.name })
  }

  const columns = await client.query<{ relname: string; attname: string }>(
    `SELECT c.relname, a.attname FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2)
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname COLLATE "C", a.attnum`,
    [schema, Object.keys(STUDIO_KNOWN_COLUMNS)],
  )
  const auditColumns = new Set<string>()
  for (const row of columns.rows) {
    if (row.relname === RESTORE_AUDIT_TABLE) auditColumns.add(row.attname)
    if (!(STUDIO_KNOWN_COLUMNS[row.relname] ?? []).includes(row.attname)) found.push({ kind: t('catalog.column'), name: `${row.relname}.${row.attname}` })
  }
  const summary = summariseUnknown(found)
  if (auditColumns.size > 0) {
    const missing = AUDIT_REQUIRED_COLUMNS.filter(column => !auditColumns.has(column))
    if (missing.length > 0) {
      summary.items.push(t('restore.auditTableUnrecognized', { table: RESTORE_AUDIT_TABLE, missing: missing.join(', ') }))
      summary.total += 1
    }
  }
  return summary
}

function summariseUnknown(found: readonly { kind: string; name: string }[]): UnknownObjects {
  const grouped = new Map<string, string[]>()
  for (const item of found) grouped.set(item.kind, [...(grouped.get(item.kind) ?? []), item.name])
  const items: string[] = []
  for (const [kind, names] of grouped) {
    if (names.length <= INVENTORY_SAMPLE) items.push(...names.map(name => t('restore.unknownItem', { kind, name })))
    else items.push(t('restore.unknownSummary', {
      kind,
      count: names.length,
      sample: names.slice(0, INVENTORY_SAMPLE).map(name => `"${name}"`).join(', '),
      remaining: names.length - INVENTORY_SAMPLE,
    }))
  }
  return { items, total: found.length }
}

async function countRecordsByUnit(client: Client, schema: string): Promise<Map<string, number>> {
  const rows = await client.query<{ unit: string; count: string }>(
    `SELECT unit, count(*)::text AS count FROM ${quoteIdentifier(schema)}."records" GROUP BY unit`,
  )
  return new Map(rows.rows.map(row => [row.unit, Number(row.count)]))
}

async function readGlobalUnits(client: Client, schema: string): Promise<Set<string>> {
  const rows = await client.query<{ unit: string }>(`SELECT unit FROM ${quoteIdentifier(schema)}."unit_globals"`)
  return new Set(rows.rows.map(row => row.unit))
}

async function writeInstallation(client: Client, schema: string, installation: string): Promise<void> {
  await client.query(
    `INSERT INTO ${quoteIdentifier(schema)}."storage_meta" (key, value, text_value) VALUES ($1, 0, $2)
       ON CONFLICT (key) DO UPDATE SET text_value = EXCLUDED.text_value`,
    [INSTALLATION_ID_KEY, installation],
  )
}

async function createRestoreAuditTable(client: Client, schema: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schema)}.${quoteIdentifier(RESTORE_AUDIT_TABLE)} (
    restored_at TIMESTAMPTZ NOT NULL, operator TEXT NOT NULL, target_schema TEXT NOT NULL,
    source_file TEXT NOT NULL, payload_sha256 TEXT NOT NULL, bundle_created_at TEXT NOT NULL,
    records_before INTEGER NOT NULL, records_after INTEGER NOT NULL,
    domains_before INTEGER NOT NULL, domains_after INTEGER NOT NULL, flags TEXT NOT NULL,
    installation_before TEXT, installation_after TEXT
  )`)
}

async function auditTableColumns(client: Client, schema: string): Promise<Set<string> | null> {
  const rows = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = $2
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, RESTORE_AUDIT_TABLE],
  )
  return rows.rows.length === 0 ? null : new Set(rows.rows.map(row => row.attname))
}

async function carryRestoreAudit(client: Client, from: string, to: string): Promise<void> {
  const present = await auditTableColumns(client, from)
  if (present === null || AUDIT_REQUIRED_COLUMNS.some(column => !present.has(column))) return
  const target = AUDIT_ALL_COLUMNS.map(column => quoteIdentifier(column)).join(', ')
  const source = AUDIT_ALL_COLUMNS.map(column => present.has(column) ? quoteIdentifier(column) : `NULL::text AS ${quoteIdentifier(column)}`).join(', ')
  await client.query(
    `INSERT INTO ${quoteIdentifier(to)}.${quoteIdentifier(RESTORE_AUDIT_TABLE)} (${target})
     SELECT ${source} FROM ${quoteIdentifier(from)}.${quoteIdentifier(RESTORE_AUDIT_TABLE)}`,
  )
}

async function insertRestoreAudit(client: Client, schema: string, entry: {
  targetSchema: string; sourceFile: string; payloadSha256: string; bundleCreatedAt: string
  recordsBefore: number; recordsAfter: number; domainsBefore: number; domainsAfter: number
  flags: string; installationBefore: string | null; installationAfter: string | null
}): Promise<void> {
  await client.query(
    `INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(RESTORE_AUDIT_TABLE)} (${AUDIT_ALL_COLUMNS.map(column => quoteIdentifier(column)).join(', ')})
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    ['dz23-studio-operator', entry.targetSchema, entry.sourceFile, entry.payloadSha256, entry.bundleCreatedAt,
      entry.recordsBefore, entry.recordsAfter, entry.domainsBefore, entry.domainsAfter, entry.flags,
      entry.installationBefore, entry.installationAfter],
  )
}

function restoreFlags(options: RestorePostgresOptions): string {
  return [
    options.force === true ? '--force' : '', options.allowDomainLoss === true ? '--allow-domain-loss' : '',
    options.allowRecordLoss === true ? '--allow-record-loss' : '',
    options.allowUnknownObjects === true ? '--allow-unknown-objects' : '',
    options.allowForeignInstallation === true ? '--allow-foreign-installation' : '',
  ].filter(Boolean).join(' ')
}

/**
 * Drop the staging schemas THIS tool left behind for THIS target, and nothing
 * else. Two independent conditions, both required:
 *
 *  - the name is exactly `<schema>_staging_<suffix>` — matched by a regular
 *    expression here, not by a `LIKE` whose unescaped `_` is a wildcard: with
 *    `dz23_storage_staging_%`, the pattern also matched a foreign
 *    `dz23xstorage_staging_...`, and that was dropped with CASCADE;
 *  - the schema carries the marker table this tool writes when it creates one,
 *    naming this tool and this exact target schema.
 */
async function findStagingSchemas(client: Client, schema: string): Promise<string[]> {
  const escaped = `${schema.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%')}\\_staging\\_%`
  const candidates = await client.query<{ nspname: string }>(
    `SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE $1 ESCAPE '\\'`,
    [escaped],
  )
  const shape = new RegExp(`^${schema.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}_staging_[a-z0-9]+$`, 'u')
  const found: string[] = []
  for (const candidate of candidates.rows) {
    if (!shape.test(candidate.nspname)) continue
    assertIdentifier(candidate.nspname, 'staging schema')
    const marker = await client.query<{ tool: string; target_schema: string }>(
      `SELECT m.tool, m.target_schema FROM ${quoteIdentifier(candidate.nspname)}.${quoteIdentifier(STAGING_MARKER_TABLE)} m
        WHERE m.tool = $1 AND m.target_schema = $2`,
      [STAGING_MARKER_TOOL, schema],
    ).catch(() => ({ rows: [] as { tool: string; target_schema: string }[] }))
    if (marker.rows.length === 0) continue
    found.push(candidate.nspname)
  }
  return found
}

async function reapStagingSchemas(client: Client, schema: string, candidates?: readonly string[]): Promise<string[]> {
  const owned = candidates ?? await findStagingSchemas(client, schema)
  for (const staging of owned) await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(staging)} CASCADE`)
  return [...owned]
}
