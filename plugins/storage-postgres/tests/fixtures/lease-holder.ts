import { PostgresStorageBackend } from '../../src/backend.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const schema = process.env.DZ23_POSTGRES_TEST_SCHEMA
const unitName = process.env.DZ23_POSTGRES_TEST_UNIT
if (dsn === undefined || schema === undefined || unitName === undefined) process.exit(2)

const backend = new PostgresStorageBackend({
  connectionString: dsn,
  schema,
  ssl: false,
  poolMax: 1,
  heartbeatMs: 100,
})
await backend.kv!.open({ name: unitName, version: 1, tables: ['records'], hasGlobal: false })
process.stdout.write('READY\n')
setInterval(() => undefined, 1_000)
