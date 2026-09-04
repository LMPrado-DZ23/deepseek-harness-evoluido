// P31-B migration proof: a development Studio on the Harness default `json`
// backend, populated through the REAL services (magic-code signup, tenancy
// bootstrap, a Prompt-to-App project with intake, spec, design, plan, approval,
// run and evidence), is exported, imported into PostgreSQL by the restore CLI,
// and booted again on PostgreSQL where every record reads back identically.
//
//   DZ23_POSTGRES_DSN=postgresql://... node scripts/prove-storage-migration.mjs
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)
execFileSync('pnpm', ['--filter', '@dz23-studio/storage-postgres', 'build'], { cwd: process.cwd(), stdio: 'ignore' })
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const studioRoot = resolve(process.cwd())
const runId = randomUUID().slice(0, 8)
const workDir = join(studioRoot, 'runtime', `migration-proof-${runId}`)
const dshHome = join(workDir, 'dsh-home')
const schema = `dz23_storage_mig_${runId}`
const dsn = process.env.DZ23_POSTGRES_DSN
assert.ok(dsn, 'DZ23_POSTGRES_DSN is required')
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing upstream checkout: ${upstreamRoot}`)

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  moduleAt(`apps/cli/lib/${profileBootChunk}`),
])
const { validateBundle, canonicalJson, sha256 } = await import('../plugins/storage-postgres/lib/bundle.js')
const { snapshotPostgresStorage } = await import('../plugins/storage-postgres/lib/snapshot.js')

process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'
await mkdir(join(dshHome, 'profiles'), { recursive: true })
await symlink(join(studioRoot, 'dsh-home', 'profiles', 'studio'), join(dshHome, 'profiles', 'studio'), 'dir')

async function boot(patchFiles) {
  const originalLog = console.log
  console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('dsh web: http://'))) originalLog(...args) }
  try {
    return await runProfile({
      environment: loadLayeredEnv('dsh-studio-p31b-migration', studioRoot),
      profile: 'studio',
      patchFiles,
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  } finally { console.log = originalLog }
}

const email = 'prado.migracao@example.test'
const device = { label: 'prova-migracao', userAgent: 'node', ipTruncated: '127.0.0.0' }
let projectId
let expected = {}

// ---- Phase 1: development Studio on json, populated through the real services.
let app = await boot([])
try {
  const identity = app.ctx.studioIdentity.service
  const capture = app.ctx.studioIdentity.developmentEmailCapture
  assert.ok(capture, 'development email capture is not available on 127.0.0.1')
  assert.equal(await identity.requestMagicCode(email), 'sent')
  const code = capture.messages.at(-1).code
  const issued = await identity.verifyMagicCode(email, code, device)
  const session = await identity.authenticate(issued.token)
  const tenancy = app.ctx.studioTenancy.service
  const authorization = tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  assert.ok(authorization, 'tenancy did not bootstrap a membership for the first user')
  const actor = { ...authorization, sessionId: session.session_id }
  const workspace = await tenancy.createWorkspace(tenancy.actorFromSession(session), 'Espaço da prova de migração')

  const p2a = app.ctx.studioPromptToApp.service
  const project = await p2a.createProject(actor, {
    name: 'Agenda do salão', original_brief: 'Preciso de um aplicativo para as pessoas escolherem horário no meu salão e eu confirmar depois.',
    category: 'form-database', privacy: 'local-only',
  })
  projectId = project.project_id
  await p2a.recordTurn(actor, projectId, { question_id: 'audience', question: 'Quem vai usar?', answer: 'Clientes do salão', recommended: false, route: 'deterministic', model: 'studio-deterministic' })
  await p2a.recordTurn(actor, projectId, { question_id: 'goal', question: 'Qual o objetivo?', answer: 'Reservar horário', recommended: true, route: 'deterministic', model: 'studio-deterministic' })
  const spec = {
    schema_version: 1, problem: project.original_brief, audience: 'Clientes do salão', journeys: ['Escolher horário e confirmar'],
    pages: [{ name: 'Reservas', sections: ['Cadastro', 'Lista'] }],
    entities: [{ name: 'Reserva', kind: 'database', sensitive: false, fields: [
      { name: 'Nome', type: 'text', required: true }, { name: 'Data', type: 'date', required: true }, { name: 'Horário', type: 'text', required: true },
    ] }],
    sensitive_data: { detected: [], confirmed_by_user: false },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
    acceptance_criteria: ['preencher, salvar e encontrar na lista', 'evitar reserva duplicada', 'critérios testáveis'],
  }
  await p2a.saveSpec(actor, projectId, spec, 'intake') // saveSpec already moves the project to SPEC_READY
  await p2a.saveDesign(actor, projectId, { preset: 'professional', font: 'source-serif', radius: 'compact', density: 'comfortable', tone: 'formal' })
  await p2a.proposePlan(actor, projectId, [{ slice_id: 'slice-1', title: 'Tela de reservas', description: 'Formulário e lista de reservas.', acceptance_criteria: spec.acceptance_criteria, planned_files: ['src/GeneratedApp.tsx'] }])
  const plan = await p2a.approvePlan(actor, projectId)
  const now = new Date().toISOString()
  await p2a.putRun(actor, {
    run_id: `run-${runId}`, operation_id: `op-${runId}`, owner_session_id: session.session_id, plan_id: plan.plan_id, project_id: projectId,
    org_id: actor.orgId, tenant_id: actor.tenantId, stage: 'verify', attempt: 1, state: 'PASSED', started_at: now, finished_at: now,
    sandbox: 'full', route: 'deterministic', model: 'studio-deterministic', input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0,
    run_directory: join(workDir, 'generated-runs', `op-${runId}`), failure_code: null,
    acceptance_checks: [{ id: 'language', label: 'language=pt-BR', kind: 'language', expected: 'pt-BR', status: 'PASSED' }],
  })
  await p2a.putEvidence(actor, {
    evidence_id: `ev-${runId}`, run_id: `run-${runId}`, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
    kind: 'test-report', sha256: 'a'.repeat(64), size_bytes: 1234, relative_path: 'evidence/appspec-report.json', created_at: now,
  })
  expected = {
    actor: { userId: actor.userId, orgId: actor.orgId, tenantId: actor.tenantId, role: actor.role },
    project: p2a.project(actor, projectId),
    turns: p2a.intakeTurns(actor, projectId),
    spec: p2a.latestSpec(actor, projectId),
    design: p2a.latestDesign(actor, projectId),
    plan: p2a.plan(actor, projectId),
    runs: p2a.runs(actor, projectId),
    evidence: p2a.evidence(actor, projectId),
    workspaces: tenancy.listWorkspaces(tenancy.actorFromSession(session)).map(item => item.workspace_id).sort(),
    sessionToken: issued.token,
  }
  assert.equal(expected.project.state, 'PLAN_APPROVED')
  assert.ok(expected.workspaces.includes(workspace.workspace_id))
} finally {
  await app.shutdown.shutdown(0)
}

// ---- Phase 2: export the stopped json instance, import into PostgreSQL through the restore CLI.
const bundlePath = join(workDir, 'dev.bundle.json')
const exported = JSON.parse((await run(process.execPath, ['--import', 'tsx', 'scripts/export-json-storage.ts',
  '--storages', join(dshHome, 'storages'), '--out', bundlePath, '--confirm-harness-stopped', '--write'], { cwd: studioRoot, env: process.env })).stdout)
const bundle = JSON.parse(await readFile(bundlePath, 'utf8'))
validateBundle(bundle)
assert.equal(bundle.source.kind, 'json')
const countsOf = report => Object.fromEntries(report.counts.map(item => [item.domain, item.records]))
const exportedCounts = countsOf(exported)
for (const domain of ['studio_identity_users', 'studio_identity_sessions', 'studio_orgs', 'studio_workspaces', 'studio_memberships', 'studio_projects', 'studio_app_specs', 'studio_design_specs', 'studio_intake_turns', 'studio_plans', 'studio_runs', 'studio_evidence', 'studio_approvals']) {
  assert.ok(exportedCounts[domain] >= 1, `export has no records for ${domain}`)
}
const imported = JSON.parse((await run(process.execPath, ['--import', 'tsx', 'scripts/import-postgres-storage.ts',
  '--input', bundlePath, '--dsn-ref', 'DZ23_POSTGRES_DSN', '--schema', schema, '--ssl', 'off', '--write', '--backup', join(workDir, 'unused.dump')],
  { cwd: studioRoot, env: process.env })).stdout)
assert.equal(imported.mode, 'write')

// Every imported domain must hash exactly like the export (snapshot taken from PostgreSQL itself).
const onPostgres = await snapshotPostgresStorage({ connectionString: dsn, ssl: false, schema, descriptors: bundle.domains.map(domain => domain.descriptor) })
for (const domain of bundle.domains) {
  const target = onPostgres.domains.find(candidate => candidate.descriptor.name === domain.descriptor.name)
  assert.ok(target, `${domain.descriptor.name} missing on postgres`)
  assert.equal(target.sha256, domain.sha256, `${domain.descriptor.name} differs after import`)
}

// ---- Phase 3: boot the Studio on PostgreSQL and read the same project through the same services.
process.env.DZ23_POSTGRES_PROOF_SCHEMA = schema
await rm(join(dshHome, 'storages'), { recursive: true, force: true }) // the json copy is gone: only PostgreSQL can serve now
app = await boot([join(studioRoot, 'deploy', 'harness', 'postgres-proof.patch.yml')])
try {
  const identity = app.ctx.studioIdentity.service
  const session = await identity.authenticate(expected.sessionToken)
  const tenancy = app.ctx.studioTenancy.service
  const authorization = tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  assert.deepEqual({ userId: authorization.userId, orgId: authorization.orgId, tenantId: authorization.tenantId, role: authorization.role }, expected.actor)
  const actor = { ...authorization, sessionId: session.session_id }
  const p2a = app.ctx.studioPromptToApp.service
  const same = (label, left, right) => assert.equal(canonicalJson(left), canonicalJson(right), `${label} differs on PostgreSQL`)
  same('project', p2a.project(actor, projectId), expected.project)
  same('turns', p2a.intakeTurns(actor, projectId), expected.turns)
  same('spec', p2a.latestSpec(actor, projectId), expected.spec)
  same('design', p2a.latestDesign(actor, projectId), expected.design)
  same('plan', p2a.plan(actor, projectId), expected.plan)
  same('runs', p2a.runs(actor, projectId), expected.runs)
  same('evidence', p2a.evidence(actor, projectId), expected.evidence)
  same('workspaces', tenancy.listWorkspaces(tenancy.actorFromSession(session)).map(item => item.workspace_id).sort(), expected.workspaces)
  // The migrated Studio keeps working: a new write lands on PostgreSQL, not on a json fallback.
  const archived = await p2a.archive(actor, projectId)
  assert.ok(archived.archived_at !== null)
} finally {
  await app.shutdown.shutdown(0)
}
const inspector = new pg.Client({ connectionString: dsn })
await inspector.connect()
const projects = await inspector.query(`SELECT value->>'archived_at' AS archived_at FROM "${schema}"."records" WHERE unit = 'studio_projects'`)
assert.equal(projects.rows.length, 1)
assert.ok(projects.rows[0].archived_at !== null, 'the post-migration write did not land on PostgreSQL')
const units = await inspector.query(`SELECT count(*)::int AS n FROM "${schema}"."units"`)
await inspector.query(`DROP SCHEMA "${schema}" CASCADE`)
await inspector.end()

const result = {
  decision: 'GO', source: 'json (Harness default, development instance)', target: 'postgres', schema,
  exportedDomains: bundle.domains.length, exportedRecords: Object.values(exportedCounts).reduce((a, b) => a + b, 0),
  unitsOnPostgres: units.rows[0].n, sessionSurvived: true, writesAfterMigrationOnPostgres: true,
  sourceDigest: bundle.source.sha256.slice(0, 16), bundleDigest: bundle.payloadSha256.slice(0, 16),
}
const proof = `# P31-B — Prova de migração da instância de desenvolvimento (json → PostgreSQL)

- Resultado: **${result.decision}**
- Origem: Studio real no backend \`json\` padrão do Harness, povoado pelos serviços reais: cadastro por código de e-mail, bootstrap de organização/espaço, um projeto Prompt-to-App da fatia 2 (\`form-database\`) com perguntas, AppSpec, DesignSpec, plano proposto e aprovado (aprovação T1), run \`PASSED\` e evidência.
- Exportação: \`pnpm storage:export-json\` com o Harness parado; ${String(result.exportedDomains)} domínios e ${String(result.exportedRecords)} registros; bundle validado (formato, pin do Harness, SHA-256 por domínio e do payload).
- Importação: \`pnpm storage:import-postgres --write\` (esquema de staging + troca atômica); o snapshot lido do PostgreSQL bate hash a hash com a exportação.
- Nova execução: o Studio subiu sobre PostgreSQL com a cópia json apagada; a sessão emitida antes da migração continuou válida; projeto, perguntas, spec, design, plano, run e evidência leram idênticos (JSON canônico); uma escrita nova (arquivar o projeto) ficou no PostgreSQL.
- Unidades no esquema: ${String(result.unitsOnPostgres)}. Nenhum dado real de pessoa foi usado (e-mail fictício \`example.test\`).

Limite: migra os domínios do Studio; sessões e logs do próprio Harness usam outro caminho e não fazem parte do bundle (D-P31-A).
`
await writeFile(resolve(studioRoot, 'docs/proofs/P31-B-json-to-postgres-migration-proof.md'), proof)
await rm(workDir, { recursive: true, force: true })
process.stdout.write(`${JSON.stringify(result, null, 2)}\nSTORAGE_MIGRATION=${result.decision}\n`)

process.on('uncaughtException', async error => { await writeFailure(error); process.exit(1) })
process.on('unhandledRejection', async error => { await writeFailure(error); process.exit(1) })
async function writeFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  await writeFile(resolve(studioRoot, 'docs/proofs/P31-B-json-to-postgres-migration-proof.md'), `# P31-B — Prova de migração da instância de desenvolvimento (json → PostgreSQL)\n\n- Resultado: **NO-GO**\n- Motivo: ${message}\n`)
  process.stderr.write(`STORAGE_MIGRATION=NO-GO ${message}\n`)
}
