// Worker for scripts/prove-postgres-soak.mjs: boots the real Studio profile on
// PostgreSQL and keeps writing/reading Studio domains while scheduled hot
// backups run. Emits one JSON status line per report interval on stdout.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const studioRoot = resolve(process.cwd())
const dshHome = resolve(process.env.DZ23_SOAK_DSH_HOME ?? join(studioRoot, 'runtime', `postgres-soak-${randomUUID()}`))
const profile = join(studioRoot, 'dsh-home', 'profiles', 'studio')
const writeEveryMs = Number(process.env.DZ23_SOAK_WRITE_MS ?? 500)
const backupEveryMs = Number(process.env.DZ23_SOAK_BACKUP_MS ?? 30_000)
const reportEveryMs = Number(process.env.DZ23_SOAK_REPORT_MS ?? 10_000)
process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'

if (!process.env.DZ23_POSTGRES_DSN) throw new Error('DZ23_POSTGRES_DSN is required')
if (!existsSync(join(upstreamRoot, '.git'))) throw new Error(`missing upstream checkout: ${upstreamRoot}`)

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  moduleAt(`apps/cli/lib/${profileBootChunk}`),
])
await mkdir(join(dshHome, 'profiles'), { recursive: true })
await symlink(profile, join(dshHome, 'profiles', 'studio'), 'dir')

const originalLog = console.log
console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('dsh web: http://'))) originalLog(...args) }
const app = await runProfile({
  environment: loadLayeredEnv('dsh-studio-p31b-soak', studioRoot),
  profile: 'studio',
  patchFiles: [join(studioRoot, 'deploy', 'harness', 'postgres-proof.patch.yml')],
  args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
})
console.log = originalLog

const hello = app.ctx.storageDomain.get('studio_hello')
const routeHealth = app.ctx.storageDomain.get('studio_route_health')
if (!hello || !routeHealth) throw new Error('soak domains did not open')
const helloRecords = hello.table('records')
const backups = app.ctx.studioStorageBackup
const stats = { iterations: 0, errors: 0, readMismatches: 0, dbMismatches: 0, dbChecks: 0, latencies: [], backups: 0, backupFailures: 0, lastBackup: null, startedAt: new Date().toISOString() }
const schema = process.env.DZ23_POSTGRES_PROOF_SCHEMA ?? 'dz23_storage_proof'
const inspector = new pg.Client({ connectionString: process.env.DZ23_POSTGRES_DSN, application_name: 'dz23-soak:inspector' })
await inspector.connect()
let running = true

process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid, dshHome, startedAt: stats.startedAt })}\n`)

const writer = setInterval(async () => {
  if (!running) return
  const key = `soak_${String(stats.iterations).padStart(8, '0')}`
  const record = { tenant_id: 'tenant-soak', created_at: new Date().toISOString(), note: `iteration ${String(stats.iterations)}` }
  const started = process.hrtime.bigint()
  try {
    await helloRecords.put(key, record)
    const back = helloRecords.get(key)
    if (JSON.stringify(back) !== JSON.stringify(record)) stats.readMismatches++
    // keep the unit bounded: delete records older than 2000 iterations
    if (stats.iterations >= 2000) await helloRecords.delete(`soak_${String(stats.iterations - 2000).padStart(8, '0')}`)
    stats.iterations++
  } catch (error) {
    stats.errors++
    process.stderr.write(`write error: ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    stats.latencies.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (stats.latencies.length > 20_000) stats.latencies.splice(0, stats.latencies.length - 20_000)
  }
}, writeEveryMs)

const backup = setInterval(async () => {
  if (!running) return
  try {
    const result = await backups.runOnce()
    if (result.status === 'created') { stats.backups++; stats.lastBackup = { file: result.file, records: result.records, domains: result.domains, bytes: result.bytes } }
    else stats.backupFailures++
  } catch (error) {
    stats.backupFailures++
    process.stderr.write(`backup error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}, backupEveryMs)

const report = setInterval(async () => {
  // Independent read-back from PostgreSQL (not the in-memory domain map): the
  // last written key must be there with the same value, and the row count must
  // equal the bounded window.
  if (stats.iterations > 0) {
    try {
      const lastKey = `soak_${String(stats.iterations - 1).padStart(8, '0')}`
      const row = await inspector.query(`SELECT value FROM "${schema}"."records" WHERE unit = 'studio_hello' AND table_name = 'records' AND key = $1`, [lastKey])
      const count = await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."records" WHERE unit = 'studio_hello'`)
      const expectedCount = Math.min(stats.iterations, 2000)
      stats.dbChecks++
      if (row.rows.length !== 1 || row.rows[0].value.note !== `iteration ${String(stats.iterations - 1)}` || count.rows[0].n !== expectedCount) stats.dbMismatches++
    } catch (error) {
      stats.dbMismatches++
      process.stderr.write(`db check error: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  const sorted = [...stats.latencies].sort((a, b) => a - b)
  const pick = fraction => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  const memory = process.memoryUsage()
  process.stdout.write(`${JSON.stringify({
    event: 'status', at: new Date().toISOString(), iterations: stats.iterations, errors: stats.errors, readMismatches: stats.readMismatches, dbChecks: stats.dbChecks, dbMismatches: stats.dbMismatches,
    p50Ms: Number(pick(0.5).toFixed(2)), p95Ms: Number(pick(0.95).toFixed(2)), maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    rssMb: Number((memory.rss / 1048576).toFixed(1)), heapMb: Number((memory.heapUsed / 1048576).toFixed(1)),
    backups: stats.backups, backupFailures: stats.backupFailures, lastBackup: stats.lastBackup,
  })}\n`)
}, reportEveryMs)

for (const timer of [writer, backup, report]) timer.unref?.()
process.on('SIGTERM', async () => {
  running = false
  clearInterval(writer); clearInterval(backup); clearInterval(report)
  await app.shutdown.shutdown(0)
  process.exit(0)
})
setInterval(() => undefined, 60_000)
