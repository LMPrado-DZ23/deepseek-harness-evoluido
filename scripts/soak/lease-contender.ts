// Contender for scripts/prove-postgres-soak.mjs: keeps trying to open the
// same unit the running Studio holds. Every attempt must be refused while the
// Studio lives; after the Studio is SIGKILLed the open must succeed quickly.
import { PostgresStorageBackend } from '../../plugins/storage-postgres/src/backend.ts'
import { StudioStorageError } from '../../plugins/storage-postgres/src/errors.ts'

const dsn = process.env.DZ23_POSTGRES_DSN
const schema = process.env.DZ23_POSTGRES_PROOF_SCHEMA
const unitName = process.env.DZ23_SOAK_UNIT ?? 'studio_hello'
const everyMs = Number(process.env.DZ23_SOAK_CONTEND_MS ?? 2_000)
if (dsn === undefined || schema === undefined) process.exit(2)

let refused = 0
let acquiredAt: string | null = null
process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid })}\n`)
const timer = setInterval(async () => {
  if (acquiredAt !== null) return
  const backend = new PostgresStorageBackend({ connectionString: dsn, schema, ssl: false, poolMax: 1, heartbeatMs: 1_000 })
  try {
    const unit = await backend.kv!.open({ name: unitName, version: 1, tables: ['records'], hasGlobal: false })
    acquiredAt = new Date().toISOString()
    process.stdout.write(`${JSON.stringify({ event: 'acquired', at: acquiredAt, refused })}\n`)
    const snapshot = await unit.loadAll()
    process.stdout.write(`${JSON.stringify({ event: 'loaded', records: Object.keys(snapshot.tables.records ?? {}).length })}\n`)
    await unit.close()
    await backend.close()
    clearInterval(timer)
    process.exit(0)
  } catch (error) {
    await backend.close().catch(() => undefined)
    if (error instanceof StudioStorageError) {
      refused++
      if (refused % 15 === 0) process.stdout.write(`${JSON.stringify({ event: 'refused', refused, at: new Date().toISOString() })}\n`)
    } else {
      process.stdout.write(`${JSON.stringify({ event: 'error', message: error instanceof Error ? error.message : String(error) })}\n`)
    }
  }
}, everyMs)
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
