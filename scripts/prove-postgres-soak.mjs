// P31-B prolonged-operation proof: the real Studio profile on PostgreSQL under
// continuous writes, with scheduled hot backups, a second process contending
// for the writer lease the whole time, and a SIGKILL takeover at the end.
//
//   DZ23_POSTGRES_DSN=postgresql://... node scripts/prove-postgres-soak.mjs --minutes 30
//
// Writes docs/proofs/P31-B-postgres-soak-proof.md with the measured numbers.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
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
// The proof loads plugins/storage-postgres/lib (untracked build output): build it now so it matches src.
execFileSync('pnpm', ['--filter', '@dz23-studio/storage-postgres', 'build'], { cwd: studioRoot, stdio: 'ignore' })
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
let contender
const stderrTail = []

const worker = spawn(process.execPath, ['scripts/soak/postgres-soak-worker.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
worker.stdout.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { try { const event = JSON.parse(line); if (event.event === 'status') { statuses.push(event); process.stderr.write(`[worker] ${line}\n`) } } catch { /* non-JSON noise */ } } })
worker.stderr.on('data', chunk => { stderrTail.push(String(chunk)); if (stderrTail.length > 50) stderrTail.shift() })
await waitFor(() => statuses.length > 0 || worker.exitCode !== null, 120_000, 'worker did not report within 2 minutes')
assert.equal(worker.exitCode, null, `worker exited early:\n${stderrTail.join('')}`)

contender = spawn(process.execPath, ['--import', 'tsx', 'scripts/soak/lease-contender.ts'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
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
assert.ok(last.iterations >= minutes * 60, `too few writes for ${String(minutes)} minutes: ${String(last.iterations)}`)
assert.equal(last.errors, 0, 'write errors during the soak')
assert.equal(last.readMismatches, 0, 'in-memory read mismatches during the soak')
assert.ok(last.dbChecks >= 1 && last.dbMismatches === 0, `PostgreSQL read-back mismatches: ${String(last.dbMismatches)}/${String(last.dbChecks)}`)
assert.equal(last.backupFailures, 0, 'hot backup failures during the soak')
const contenderErrors = contenderEvents.filter(event => event.event === 'error')
assert.equal(contenderErrors.length, 0, `contender errors: ${JSON.stringify(contenderErrors.slice(0, 3))}`)

// SIGKILL: no graceful shutdown. The advisory lock dies with the session and the contender must take over.
const killedAt = Date.now()
worker.kill('SIGKILL')
await waitFor(() => contenderEvents.some(event => event.event === 'acquired'), 60_000, 'contender did not acquire the lease within 60 s of SIGKILL')
const acquired = contenderEvents.find(event => event.event === 'acquired')
const takeoverMs = Date.parse(acquired.at) - killedAt
assert.ok(acquired.refused >= Math.floor((minutes * 60) / 2) / 2, `contender was refused only ${String(acquired.refused)} times: it was not really contending`)
assert.ok(takeoverMs <= 15_000, `takeover took ${String(takeoverMs)} ms`)
await waitFor(() => contender.exitCode !== null, 30_000, 'contender did not exit')
const loaded = contenderEvents.find(event => event.event === 'loaded')
const inspector = new pg.Client({ connectionString: dsn })
await inspector.connect()
const units = await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."units"`)
const records = await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."records" WHERE unit = 'studio_hello'`)
// The last status line is up to 10 s old; the takeover must read exactly what PostgreSQL holds now, and at least what was reported.
assert.equal(loaded?.records, records.rows[0].n, 'the taking-over process did not see every persisted record')
assert.ok(records.rows[0].n >= Math.min(last.iterations, 2000), 'PostgreSQL holds fewer records than the Studio reported writing')

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
// The worker's manual runOnce calls are counted in last.backups; anything beyond them came from the plugin's own schedule
// (one immediate run at start + one per 5 minutes).
const scheduledRuns = ledgerLines - last.backups - last.backupFailures
const expectedScheduled = 1 + Math.floor(minutes / 5)
assert.ok(scheduledRuns >= expectedScheduled - 1, `scheduled backups: ${String(scheduledRuns)}, expected about ${String(expectedScheduled)}`)

await inspector.query(`DROP SCHEMA "${schema}" CASCADE`)
await inspector.end()

const first = statuses[0]
const result = {
  decision: 'GO',
  minutes, schema, iterations: last.iterations, errors: last.errors, readMismatches: last.readMismatches, dbChecks: last.dbChecks, dbMismatches: last.dbMismatches,
  latency: { p50Ms: last.p50Ms, p95Ms: last.p95Ms, maxMs: last.maxMs },
  memory: { rssStartMb: first.rssMb, rssEndMb: last.rssMb, heapStartMb: first.heapMb, heapEndMb: last.heapMb },
  backups: { manualUnderLoad: last.backups, scheduledByPlugin: scheduledRuns, failed: last.backupFailures, files: backupFiles.length, ledgerLines, newestRecords: bundle.domains.reduce((t, d) => t + Object.values(d.snapshot.tables).reduce((s, x) => s + Object.keys(x).length, 0), 0), newestDomains: bundle.domains.length },
  singleWriter: { refusedAttempts: acquired.refused, takeoverMs, recordsSeenByTakeover: loaded?.records ?? null },
  unitsOnPostgres: units.rows[0].n, helloRecordsAtEnd: records.rows[0].n,
}
const proof = `# P31-B — Prova de operação prolongada em PostgreSQL

- Resultado: **${result.decision}**
- Duração: ${String(minutes)} min; escritas: ${String(result.iterations)}; erros: ${String(result.errors)}; leituras divergentes na memória: ${String(result.readMismatches)}; conferências diretas no PostgreSQL (última chave + contagem): ${String(result.dbChecks)}, divergentes: ${String(result.dbMismatches)}.
- Latência de escrita+leitura (ms): p50 ${String(result.latency.p50Ms)}, p95 ${String(result.latency.p95Ms)}, máx ${String(result.latency.maxMs)}.
- Memória do processo Studio (RSS MB): início ${String(result.memory.rssStartMb)}, fim ${String(result.memory.rssEndMb)}; heap ${String(result.memory.heapStartMb)} → ${String(result.memory.heapEndMb)}.
- Backups a quente durante a carga: ${String(result.backups.manualUnderLoad)} disparados pelo worker (a cada 30 s) e ${String(result.backups.scheduledByPlugin)} pelo agendador do próprio plugin (1 no arranque + 1 a cada 5 min), ${String(result.backups.failed)} falhas, ${String(result.backups.files)} arquivos retidos, ${String(result.backups.ledgerLines)} linhas no ledger; o mais recente valida (formato + SHA-256) com ${String(result.backups.newestDomains)} domínios e ${String(result.backups.newestRecords)} registros.
- Escritor único: o segundo processo tentou abrir a unidade a cada 2 s e foi recusado ${String(result.singleWriter.refusedAttempts)} vezes (zero erros de conexão); após \`SIGKILL\` do Studio assumiu em ${String(result.singleWriter.takeoverMs)} ms e leu ${String(result.singleWriter.recordsSeenByTakeover)} registros — exatamente os persistidos.
- Unidades no esquema: ${String(result.unitsOnPostgres)}; registros de \`studio_hello\` ao final: ${String(result.helloRecordsAtEnd)}.
- Ambiente: Studio real (profile \`studio\` + \`postgres-proof.patch.yml\`), PostgreSQL 16 local, sem Docker.

Não é prova de carga multiusuário nem de rede; é a operação contínua de um Studio sobre PostgreSQL com backup agendado e exclusão de escritor concorrente.
`
await writeFile(resolve(studioRoot, 'docs/proofs/P31-B-postgres-soak-proof.md'), proof)
await rm(workDir, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify(result, null, 2)}\nPOSTGRES_SOAK=${result.decision} minutes=${String(minutes)} iterations=${String(result.iterations)}\n`)
if (result.decision !== 'GO') process.exitCode = 1

process.on('uncaughtException', async error => { await writeFailure(error); process.exit(1) })
process.on('unhandledRejection', async error => { await writeFailure(error); process.exit(1) })
async function writeFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  await writeFile(resolve(studioRoot, 'docs/proofs/P31-B-postgres-soak-proof.md'), `# P31-B — Prova de operação prolongada em PostgreSQL\n\n- Resultado: **NO-GO**\n- Motivo: ${message}\n- Duração pedida: ${String(minutes)} min.\n`)
  process.stderr.write(`POSTGRES_SOAK=NO-GO ${message}\n`)
  try { worker.kill('SIGKILL') } catch {}
  try { contender?.kill('SIGTERM') } catch {}
}

function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)) }
async function waitFor(predicate, timeoutMs, message) {
  const until = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > until) throw new Error(message)
    await sleep(250)
  }
}
