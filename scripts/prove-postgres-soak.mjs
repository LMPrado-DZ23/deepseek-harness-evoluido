// P31-B prolonged-operation proof: the real Studio profile on PostgreSQL under
// continuous writes, with scheduled hot backups, a second process contending
// for the writer lease the whole time, and a SIGKILL takeover at the end.
//
//   DZ23_POSTGRES_DSN=postgresql://... node scripts/prove-postgres-soak.mjs --minutes 30
//
// Writes docs/proofs/P31-B-postgres-soak-proof.md with the measured numbers.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import pg from 'pg'

const args = process.argv.slice(2)
const minutes = Number(args[args.indexOf('--minutes') + 1] || 30)
assert.ok(Number.isFinite(minutes) && minutes >= 1, '--minutes must be >= 1')
const dsn = process.env.DZ23_POSTGRES_DSN
assert.ok(dsn, 'DZ23_POSTGRES_DSN is required')
const studioRoot = resolve(process.cwd())
const runId = randomUUID().slice(0, 8)
const schema = `dz23_storage_soak_${runId}`
const workDir = join(studioRoot, 'runtime', `postgres-soak-${runId}`)
const backupDir = join(workDir, 'backups')
await mkdir(backupDir, { recursive: true })

const env = {
  ...process.env,
  DZ23_POSTGRES_PROOF_SCHEMA: schema,
  DZ23_POSTGRES_BACKUP_DIR: backupDir,
  DZ23_SOAK_DSH_HOME: join(workDir, 'dsh-home'),
}
const statuses = []
const contenderEvents = []
const stderrTail = []

const worker = spawn(process.execPath, ['scripts/soak/postgres-soak-worker.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
worker.stdout.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { try { const event = JSON.parse(line); if (event.event === 'status') { statuses.push(event); process.stderr.write(`[worker] ${line}\n`) } } catch { /* non-JSON noise */ } } })
worker.stderr.on('data', chunk => { stderrTail.push(String(chunk)); if (stderrTail.length > 50) stderrTail.shift() })
await waitFor(() => statuses.length > 0 || worker.exitCode !== null, 120_000, 'worker did not report within 2 minutes')
assert.equal(worker.exitCode, null, `worker exited early:\n${stderrTail.join('')}`)

const contender = spawn(process.execPath, ['--import', 'tsx', 'scripts/soak/lease-contender.ts'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
contender.stdout.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { try { contenderEvents.push(JSON.parse(line)) } catch { /* noise */ } } })

const startedAt = Date.now()
const deadline = startedAt + minutes * 60_000
while (Date.now() < deadline) {
  await sleep(5_000)
  assert.equal(worker.exitCode, null, `worker died during the soak:\n${stderrTail.join('')}`)
  assert.ok(!contenderEvents.some(event => event.event === 'acquired'), 'contender acquired the writer lease while the Studio was alive')
}
const last = statuses.at(-1)
assert.ok(last, 'no status collected')

// SIGKILL: no graceful shutdown. The advisory lock dies with the session and the contender must take over.
const killedAt = Date.now()
worker.kill('SIGKILL')
await waitFor(() => contenderEvents.some(event => event.event === 'acquired'), 60_000, 'contender did not acquire the lease within 60 s of SIGKILL')
const acquired = contenderEvents.find(event => event.event === 'acquired')
const takeoverMs = Date.parse(acquired.at) - killedAt
await waitFor(() => contender.exitCode !== null, 30_000, 'contender did not exit')
const loaded = contenderEvents.find(event => event.event === 'loaded')

// Backups written during the soak must validate and be restorable-shaped.
const { validateBundle } = await import('../plugins/storage-postgres/lib/bundle.js')
const { verifyBackupFile } = await import('../plugins/storage-postgres/lib/backup.js')
const backupFiles = (await readdir(backupDir)).filter(name => /^studio-backup-.*\.json$/u.test(name)).sort()
assert.ok(backupFiles.length >= 1, 'no backup file was written during the soak')
const newest = join(backupDir, backupFiles.at(-1))
const verified = await verifyBackupFile(newest)
assert.ok(verified.matches, 'newest backup does not match its sidecar digest')
const bundle = JSON.parse(await readFile(newest, 'utf8'))
validateBundle(bundle)
const ledgerLines = (await readFile(join(backupDir, 'backups.jsonl'), 'utf8')).trim().split('\n').length

const inspector = new pg.Client({ connectionString: dsn })
await inspector.connect()
const units = await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."units"`)
const records = await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."records" WHERE unit = 'studio_hello'`)
await inspector.query(`DROP SCHEMA "${schema}" CASCADE`)
await inspector.end()

const first = statuses[0]
const result = {
  decision: last.errors === 0 && last.readMismatches === 0 && last.backupFailures === 0 && takeoverMs <= 15_000 ? 'GO' : 'NO-GO',
  minutes, schema, iterations: last.iterations, errors: last.errors, readMismatches: last.readMismatches,
  latency: { p50Ms: last.p50Ms, p95Ms: last.p95Ms, maxMs: last.maxMs },
  memory: { rssStartMb: first.rssMb, rssEndMb: last.rssMb, heapStartMb: first.heapMb, heapEndMb: last.heapMb },
  backups: { created: last.backups, failed: last.backupFailures, files: backupFiles.length, ledgerLines, newestRecords: bundle.domains.reduce((t, d) => t + Object.values(d.snapshot.tables).reduce((s, x) => s + Object.keys(x).length, 0), 0), newestDomains: bundle.domains.length },
  singleWriter: { refusedAttempts: acquired.refused, takeoverMs, recordsSeenByTakeover: loaded?.records ?? null },
  unitsOnPostgres: units.rows[0].n, helloRecordsAtEnd: records.rows[0].n,
}
const proof = `# P31-B — Prova de operação prolongada em PostgreSQL

- Resultado: **${result.decision}**
- Duração: ${String(minutes)} min; escritas: ${String(result.iterations)}; erros: ${String(result.errors)}; leituras divergentes: ${String(result.readMismatches)}.
- Latência de escrita+leitura (ms): p50 ${String(result.latency.p50Ms)}, p95 ${String(result.latency.p95Ms)}, máx ${String(result.latency.maxMs)}.
- Memória do processo Studio (RSS MB): início ${String(result.memory.rssStartMb)}, fim ${String(result.memory.rssEndMb)}; heap ${String(result.memory.heapStartMb)} → ${String(result.memory.heapEndMb)}.
- Backups a quente durante a carga: ${String(result.backups.created)} criados, ${String(result.backups.failed)} falhas, ${String(result.backups.files)} arquivos retidos, ${String(result.backups.ledgerLines)} linhas no ledger; o mais recente valida (formato + SHA-256) com ${String(result.backups.newestDomains)} domínios e ${String(result.backups.newestRecords)} registros.
- Escritor único: o segundo processo foi recusado ${String(result.singleWriter.refusedAttempts)} vezes durante toda a operação; após \`SIGKILL\` do Studio assumiu em ${String(result.singleWriter.takeoverMs)} ms e leu ${String(result.singleWriter.recordsSeenByTakeover)} registros.
- Unidades no esquema: ${String(result.unitsOnPostgres)}; registros de \`studio_hello\` ao final: ${String(result.helloRecordsAtEnd)}.
- Ambiente: Studio real (profile \`studio\` + \`postgres-proof.patch.yml\`), PostgreSQL 16 local, sem Docker.

Não é prova de carga multiusuário nem de rede; é a operação contínua de um Studio sobre PostgreSQL com backup agendado e exclusão de escritor concorrente.
`
await writeFile(resolve(studioRoot, 'docs/proofs/P31-B-postgres-soak-proof.md'), proof)
await rm(workDir, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify(result, null, 2)}\nPOSTGRES_SOAK=${result.decision} minutes=${String(minutes)} iterations=${String(result.iterations)}\n`)
if (result.decision !== 'GO') process.exitCode = 1

function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)) }
async function waitFor(predicate, timeoutMs, message) {
  const until = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > until) throw new Error(message)
    await sleep(250)
  }
}
