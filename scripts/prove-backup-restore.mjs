// P31-B restore drill: a Studio on PostgreSQL with the scheduled backup enabled
// is populated through the REAL services, produces a scheduled backup AND a hot
// operator backup (CLI, Studio still running), then the schema is destroyed on
// purpose. The backup file is verified, restored by the restore CLI into the
// same schema name, and the Studio boots again on it: same session, same
// records, new writes land. Finally the CLI must refuse to overwrite a schema
// that already has Studio units without --force + confirmation.
//
//   DZ23_POSTGRES_DSN=postgresql://... node scripts/prove-backup-restore.mjs
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)
execFileSync('pnpm', ['--filter', '@dz23-studio/storage-postgres', 'build'], { cwd: process.cwd(), stdio: 'ignore' })
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const studioRoot = resolve(process.cwd())
const runId = randomUUID().slice(0, 8)
const workDir = join(studioRoot, 'runtime', `restore-proof-${runId}`)
const dshHome = join(workDir, 'dsh-home')
const backupDir = join(workDir, 'backups')
const operatorDir = join(workDir, 'operator-backups')
const schema = `dz23_storage_rst_${runId}`
const dsn = process.env.DZ23_POSTGRES_DSN
assert.ok(dsn, 'DZ23_POSTGRES_DSN is required')
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing upstream checkout: ${upstreamRoot}`)

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([moduleAt('packages/boot/app-boot/lib/index.js'), moduleAt(`apps/cli/lib/${profileBootChunk}`)])
const { validateBundle, canonicalJson } = await import('../plugins/storage-postgres/lib/bundle.js')
const { verifyBackupFile } = await import('../plugins/storage-postgres/lib/backup.js')

process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.DZ23_POSTGRES_PROOF_SCHEMA = schema
process.env.DZ23_POSTGRES_BACKUP_DIR = backupDir
await mkdir(join(dshHome, 'profiles'), { recursive: true })
await mkdir(backupDir, { recursive: true })
await symlink(join(studioRoot, 'dsh-home', 'profiles', 'studio'), join(dshHome, 'profiles', 'studio'), 'dir')
const patch = join(studioRoot, 'deploy', 'harness', 'postgres-proof.patch.yml')

async function boot() {
  const originalLog = console.log
  console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('dsh web: http://'))) originalLog(...args) }
  try {
    return await runProfile({ environment: loadLayeredEnv('dsh-studio-p31b-restore', studioRoot), profile: 'studio', patchFiles: [patch], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] })
  } finally { console.log = originalLog }
}

const inspector = new pg.Client({ connectionString: dsn })
await inspector.connect()
const unitCount = async () => Number((await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."units"`)).rows[0].n)
const email = 'prado.restauracao@example.test'
let expected
let scheduled
let operatorFile
let projectId

// ---- Phase 1: Studio on PostgreSQL with scheduled backups, populated through the real services.
let app = await boot()
try {
  const identity = app.ctx.studioIdentity.service
  const capture = app.ctx.studioIdentity.developmentEmailCapture
  assert.equal(await identity.requestMagicCode(email), 'sent')
  const issued = await identity.verifyMagicCode(email, capture.messages.at(-1).code, { label: 'prova-restauracao', userAgent: 'node', ipTruncated: '127.0.0.0' })
  const session = await identity.authenticate(issued.token)
  const tenancy = app.ctx.studioTenancy.service
  const actor = { ...tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id), sessionId: session.session_id }
  const workspace = await tenancy.createWorkspace(tenancy.actorFromSession(session), 'Espaço da prova de restauração')
  const p2a = app.ctx.studioPromptToApp.service
  const project = await p2a.createProject(actor, { name: 'Cardápio da padaria', original_brief: 'Quero uma página com o cardápio da minha padaria e o telefone para pedidos.', category: 'landing-page', privacy: 'local-only' })
  projectId = project.project_id
  await p2a.recordTurn(actor, projectId, { question_id: 'audience', question: 'Quem vai usar?', answer: 'Clientes do bairro', recommended: false, route: 'deterministic', model: 'studio-deterministic' })
  await p2a.saveSpec(actor, projectId, { schema_version: 1, problem: project.original_brief, audience: 'Clientes do bairro', journeys: ['Ver o cardápio e ligar'], pages: [{ name: 'Início', sections: ['Cardápio', 'Contato'] }], entities: [], sensitive_data: { detected: [], confirmed_by_user: false }, accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR', acceptance_criteria: ['mostrar o cardápio', 'mostrar o telefone', 'abrir no celular'] }, 'intake')

  // The scheduled backup produced by the plugin itself (same code path as the timer).
  scheduled = await app.ctx.studioStorageBackup.runOnce()
  assert.equal(scheduled.status, 'created', `scheduled backup not created: ${JSON.stringify(scheduled)}`)
  // A hot operator backup through the CLI while the Studio is still running (no writer lock taken).
  const hot = JSON.parse((await run(process.execPath, ['--import', 'tsx', 'scripts/backup-postgres-storage.ts', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--schema', schema, '--ssl', 'off', '--out', operatorDir, '--write'], { cwd: studioRoot, env: process.env })).stdout)
  assert.equal(hot.status, 'created')
  operatorFile = hot.file
  // A write AFTER the backups: it must be absent after the restore (the drill restores a point in time, honestly).
  await p2a.recordTurn(actor, projectId, { question_id: 'goal', question: 'Qual o objetivo?', answer: 'Receber pedidos por telefone', recommended: false, route: 'deterministic', model: 'studio-deterministic' })
  expected = {
    sessionToken: issued.token,
    actor: { userId: actor.userId, orgId: actor.orgId, tenantId: actor.tenantId, role: actor.role },
    project: p2a.project(actor, projectId),
    spec: p2a.latestSpec(actor, projectId),
    turnsBeforeLateWrite: 1,
    workspaces: tenancy.listWorkspaces(tenancy.actorFromSession(session)).map(item => item.workspace_id).sort(),
  }
  assert.ok(expected.workspaces.includes(workspace.workspace_id))
  assert.equal(p2a.intakeTurns(actor, projectId).length, 2)
} finally {
  await app.shutdown.shutdown(0)
}
const unitsBefore = await unitCount()
assert.ok(unitsBefore > 0)

// ---- Phase 2: verify both backup files; destroy the schema; restore from the scheduled backup.
for (const file of [scheduled.file, operatorFile]) {
  const verified = await verifyBackupFile(file)
  assert.equal(verified.matches, true, `sha256 sidecar does not match ${file}`)
  const bundle = JSON.parse(readFileSync(file, 'utf8'))
  validateBundle(bundle)
  assert.equal(bundle.source.kind, 'postgres')
}
const ledger = (await readdir(backupDir)).filter(name => name === 'backups.jsonl')
assert.equal(ledger.length, 1, 'scheduled backup ledger missing')
await inspector.query(`DROP SCHEMA "${schema}" CASCADE`) // the disaster
const gone = await inspector.query('SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present', [schema])
assert.equal(gone.rows[0].present, false)
const restored = JSON.parse((await run(process.execPath, ['--import', 'tsx', 'scripts/import-postgres-storage.ts',
  '--input', scheduled.file, '--dsn-ref', 'DZ23_POSTGRES_DSN', '--schema', schema, '--ssl', 'off', '--write', '--backup', join(workDir, 'pre-restore.dump')],
  { cwd: studioRoot, env: process.env })).stdout)
assert.equal(restored.mode, 'write')
assert.equal(await unitCount(), unitsBefore, 'restored unit count differs')

// ---- Phase 3: the Studio boots on the restored schema: same session, same records, new writes land.
app = await boot()
try {
  const identity = app.ctx.studioIdentity.service
  const session = await identity.authenticate(expected.sessionToken)
  const tenancy = app.ctx.studioTenancy.service
  const authorization = tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  assert.deepEqual({ userId: authorization.userId, orgId: authorization.orgId, tenantId: authorization.tenantId, role: authorization.role }, expected.actor)
  const actor = { ...authorization, sessionId: session.session_id }
  const p2a = app.ctx.studioPromptToApp.service
  assert.equal(canonicalJson(p2a.project(actor, projectId)), canonicalJson(expected.project))
  assert.equal(canonicalJson(p2a.latestSpec(actor, projectId)), canonicalJson(expected.spec))
  assert.equal(canonicalJson(tenancy.listWorkspaces(tenancy.actorFromSession(session)).map(item => item.workspace_id).sort()), canonicalJson(expected.workspaces))
  // Point in time: the turn written after the backup is NOT there (and the proof says so instead of pretending otherwise).
  assert.equal(p2a.intakeTurns(actor, projectId).length, expected.turnsBeforeLateWrite)
  const archived = await p2a.archive(actor, projectId)
  assert.ok(archived.archived_at !== null)
  // The scheduler is alive again on the restored instance.
  assert.equal((await app.ctx.studioStorageBackup.runOnce()).status, 'created')
} finally {
  await app.shutdown.shutdown(0)
}
const archivedRow = await inspector.query(`SELECT value->>'archived_at' AS archived_at FROM "${schema}"."records" WHERE unit = 'studio_projects'`)
assert.ok(archivedRow.rows[0]?.archived_at, 'post-restore write did not land on PostgreSQL')

// ---- Phase 4: the restore CLI refuses to overwrite a populated schema without --force + confirmation.
let refused = false
try {
  await run(process.execPath, ['--import', 'tsx', 'scripts/import-postgres-storage.ts', '--input', operatorFile, '--dsn-ref', 'DZ23_POSTGRES_DSN', '--schema', schema, '--ssl', 'off', '--write', '--backup', join(workDir, 'unused.dump')], { cwd: studioRoot, env: process.env })
} catch (error) { refused = /REPLACE_DZ23_STORAGE/u.test(`${error.stderr ?? ''}${error.stdout ?? ''}${error.message}`) }
assert.ok(refused, 'restore over a populated schema was not refused')
const afterRefusal = await inspector.query(`SELECT value->>'archived_at' AS archived_at FROM "${schema}"."records" WHERE unit = 'studio_projects'`)
assert.equal(afterRefusal.rows[0]?.archived_at, archivedRow.rows[0].archived_at, 'refused restore must leave the data untouched')
assert.equal(await unitCount(), unitsBefore, 'refused restore must not touch the units')

await inspector.query(`DROP SCHEMA "${schema}" CASCADE`)
await inspector.end()
const result = { decision: 'GO', schema, unitsRestored: unitsBefore, scheduledBackup: scheduled.file.split('/').pop(), operatorBackup: operatorFile.split('/').pop(), pointInTimeHonest: true, refusedOverwrite: true }
await writeFile(resolve(studioRoot, 'docs/proofs/P31-B-backup-restore-proof.md'), `# P31-B — Prova de restauração a partir da cópia de segurança (PostgreSQL)

- Resultado: **${result.decision}** (${new Date().toISOString().slice(0, 10)}, ambiente do Claude, PostgreSQL 16 real, Studio real no profile \`studio\` com \`postgres-proof.patch.yml\`)
- Studio em PostgreSQL com cópia agendada ligada, populado pelos serviços reais (código de acesso, espaço de trabalho, projeto, pergunta e especificação).
- Duas cópias produzidas com o Studio **ligado**: a agendada (mesmo caminho do temporizador, \`${result.scheduledBackup}\`) e a do operador pela CLI \`storage:backup-postgres\` (\`${result.operatorBackup}\`); ambas com \`.sha256\` conferido e formato \`dz23-studio-kv-export/v1\` validado; livro-razão \`backups.jsonl\` presente.
- Desastre simulado: \`DROP SCHEMA … CASCADE\`. Restauração pela CLI \`storage:import-postgres\` a partir da cópia agendada → ${String(result.unitsRestored)} unidades, contagem igual à de antes.
- Studio religado sobre o esquema restaurado: a **mesma sessão** entra, projeto/especificação/espaços idênticos (JSON canônico), uma escrita nova cai no PostgreSQL e a cópia agendada volta a funcionar.
- Honestidade do ponto no tempo: a escrita feita **depois** das cópias não existe após a restauração — a prova afirma isso em vez de esconder.
- Segurança: a CLI **recusa** sobrescrever um esquema que já tem unidades sem \`--force --confirm REPLACE_DZ23_STORAGE\`, e os dados ficam intactos.

Não executado: restauração em servidor remoto com TLS \`verify-full\` (aqui \`ssl off\` local), Docker/Compose (ambiente do Claude sem daemon), restauração a partir de \`pg_dump\` (o caminho oficial é o bundle JSON; o dump é só rede de segurança do \`--backup\`).
`)
await rm(workDir, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify(result, null, 2)}\nBACKUP_RESTORE=GO\n`)
