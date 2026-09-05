#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  BACKUP_MAX_BYTES_DEFAULT,
  BACKUP_MIN_INTERVAL_MS,
  DEFAULT_STORAGE_IMPORT_LIMITS,
  OPERATOR_BUNDLE_MAX_BYTES,
  StorageBackupScheduler,
  assertTlsPolicy,
  postgresStorageStatus,
  readVerifiedStorageBundleFile,
  restorePostgresStorage,
  writeBackupBundle,
} from '@dz23-studio/storage-postgres/operator'

const COMMANDS = new Set(['backup', 'verify-backup', 'restore', 'status'])
const VALUE_FLAGS = new Set(['--dsn-ref', '--schema', '--ssl', '--out', '--input', '--backup', '--keep', '--max-bytes', '--confirm', '--attempt-id'])
const BOOL_FLAGS = new Set(['--write', '--force', '--allow-domain-loss'])

export function parseOperatorCommand(argv) {
  const [command, ...tokens] = argv
  if (!COMMANDS.has(command)) throw new Error('Comando inválido. Use backup, verify-backup, restore ou status.')
  const values = new Map()
  const booleans = new Set()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (BOOL_FLAGS.has(token)) {
      if (booleans.has(token)) throw new Error(`Opção repetida: ${token}`)
      booleans.add(token)
      continue
    }
    if (!VALUE_FLAGS.has(token)) throw new Error(`Opção desconhecida: ${String(token)}`)
    if (values.has(token)) throw new Error(`Opção repetida: ${token}`)
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Falta o valor de ${token}`)
    values.set(token, value)
    index += 1
  }
  const required = name => {
    const value = values.get(name)
    if (value === undefined || value === '') throw new Error(`Falta ${name}`)
    return value
  }
  const positiveInteger = (name, fallback) => {
    const parsed = Number(values.get(name) ?? fallback)
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} deve ser um inteiro positivo`)
    if (name === '--max-bytes' && parsed > OPERATOR_BUNDLE_MAX_BYTES) {
      throw new Error(`${name} não pode exceder ${String(OPERATOR_BUNDLE_MAX_BYTES)} bytes enquanto a importação usar JSON em memória`)
    }
    return parsed
  }
  const allowOnly = allowed => {
    for (const name of values.keys()) if (!allowed.has(name)) throw new Error(`A opção ${name} não pertence ao comando ${command}.`)
    if (booleans.size > 0 && command !== 'restore') throw new Error(`Opções de restauração não pertencem ao comando ${command}.`)
  }
  const common = { schema: values.get('--schema') ?? 'dz23_storage', ssl: assertTlsPolicy(values.get('--ssl') ?? 'verify-full') }
  if (command === 'verify-backup') {
    allowOnly(new Set(['--input', '--max-bytes']))
    return { command, input: required('--input'), maxBytes: positiveInteger('--max-bytes', BACKUP_MAX_BYTES_DEFAULT) }
  }
  const dsnRef = required('--dsn-ref')
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(dsnRef)) throw new Error('--dsn-ref deve ser o nome de uma variável de ambiente')
  if (command === 'backup') {
    allowOnly(new Set(['--dsn-ref', '--schema', '--ssl', '--out', '--keep', '--max-bytes']))
    return { command, ...common, dsnRef, out: required('--out'), keep: positiveInteger('--keep', 48), maxBytes: positiveInteger('--max-bytes', BACKUP_MAX_BYTES_DEFAULT) }
  }
  if (command === 'status') {
    allowOnly(new Set(['--dsn-ref', '--schema', '--ssl']))
    return { command, ...common, dsnRef }
  }
  allowOnly(new Set(['--dsn-ref', '--schema', '--ssl', '--input', '--backup', '--max-bytes', '--confirm', '--attempt-id']))
  const write = booleans.has('--write')
  return {
    command, ...common, dsnRef, input: required('--input'), attemptId: required('--attempt-id'), backup: write ? required('--backup') : (values.get('--backup') ?? ''),
    maxBytes: positiveInteger('--max-bytes', BACKUP_MAX_BYTES_DEFAULT), write: booleans.has('--write'),
    force: booleans.has('--force'), allowDomainLoss: booleans.has('--allow-domain-loss'),
    confirmation: values.get('--confirm') ?? '',
  }
}

export async function runOperator(command, dependencies = {}) {
  const signal = dependencies.signal
  const throwIfAborted = () => {
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada.')
  }
  throwIfAborted()
  const environment = dependencies.environment ?? process.env
  const getDsn = reference => {
    const value = environment[reference]
    if (typeof value !== 'string' || value === '') throw new Error(`Credencial '${reference}' não configurada.`)
    return value
  }
  if (command.command === 'verify-backup') {
    const verified = await (dependencies.readVerifiedStorageBundleFile ?? readVerifiedStorageBundleFile)(resolve(command.input), { ...DEFAULT_STORAGE_IMPORT_LIMITS, maxBytes: command.maxBytes }, signal)
    throwIfAborted()
    return { command: 'verify-backup', status: 'valid', file: verified.file, bytes: verified.bytes, sha256: verified.inputSha256, domains: verified.bundle.domains.length }
  }
  const dsn = getDsn(command.dsnRef)
  if (command.command === 'status') {
    const status = await (dependencies.postgresStorageStatus ?? postgresStorageStatus)({ dsn, schema: command.schema, ssl: command.ssl, signal })
    throwIfAborted()
    return { command: 'status', ...status }
  }
  if (command.command === 'backup') {
    const backupWriter = dependencies.writeBackupBundle ?? writeBackupBundle
    const runner = dependencies.backupRunner ?? { run: (target, operationSignal) => backupWriter({ dsnRef: command.dsnRef, schema: command.schema, ssl: command.ssl, out: target, maxBytes: command.maxBytes, signal: operationSignal }, dsn) }
    const scheduler = new (dependencies.StorageBackupScheduler ?? StorageBackupScheduler)({
      runner, directory: resolve(command.out), label: command.schema,
      intervalMs: BACKUP_MIN_INTERVAL_MS, keep: command.keep, signal,
    })
    const result = await scheduler.runOnce()
    throwIfAborted()
    if (result.status !== 'created') throw new Error('Não foi possível criar a cópia de segurança.')
    return { command: 'backup', status: result.status, file: result.file, sha256: result.sha256, bytes: result.bytes, records: result.records, domains: result.domains, prunedCount: result.prunedCount }
  }
  const verified = await (dependencies.readVerifiedStorageBundleFile ?? readVerifiedStorageBundleFile)(resolve(command.input), { ...DEFAULT_STORAGE_IMPORT_LIMITS, maxBytes: command.maxBytes }, signal)
  throwIfAborted()
  const stateDirectory = command.write ? environment.DZ23_OPERATOR_STATE_DIR : undefined
  if (command.write && (typeof stateDirectory !== 'string' || stateDirectory === '')) throw new Error("Credencial não secreta 'DZ23_OPERATOR_STATE_DIR' não configurada.")
  const report = await (dependencies.restorePostgresStorage ?? restorePostgresStorage)({
    verifiedInput: verified, attemptId: command.attemptId, dsn, schema: command.schema, ssl: command.ssl, write: command.write,
    safetyBackup: command.backup, force: command.force, allowDomainLoss: command.allowDomainLoss,
    confirmation: command.confirmation, signal, environment, maxBytes: command.maxBytes, stateDirectory,
  })
  return { command: 'restore', ...report }
}

export function sanitizeOperatorError(error, secrets = []) {
  let text = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) if (typeof secret === 'string' && secret !== '') text = text.replaceAll(secret, '[redacted]')
  text = text.replaceAll(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/giu, '$1[redacted]@')
  return text.slice(0, 500)
}

function credentialFragments(value) {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = new URL(value)
    return [value, parsed.password, decodeURIComponent(parsed.password)].filter(Boolean)
  } catch {
    return [value]
  }
}

export async function main(runtime = {}) {
  const argv = runtime.argv ?? process.argv.slice(2)
  const environment = runtime.environment ?? process.env
  const stdout = runtime.stdout ?? process.stdout
  const stderr = runtime.stderr ?? process.stderr
  const signals = runtime.signals ?? process
  let command
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Operação cancelada.'))
  signals.once('SIGINT', cancel)
  signals.once('SIGTERM', cancel)
  try {
    command = parseOperatorCommand(argv)
    const result = await runOperator(command, { ...runtime.dependencies, signal: controller.signal, environment })
    stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    const secret = command?.dsnRef === undefined ? [] : credentialFragments(environment[command.dsnRef])
    stderr.write(`${JSON.stringify({ status: 'failed', error: sanitizeOperatorError(error, secret) })}\n`)
    return 1
  } finally {
    signals.off('SIGINT', cancel)
    signals.off('SIGTERM', cancel)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main()
