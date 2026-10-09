import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const studioRoot = resolve(process.cwd())
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT
  ?? join(studioRoot, 'third_party', 'deepseek-harness'))
const profile = join(studioRoot, 'dsh-home', 'profiles', 'studio')
const scriptPath = fileURLToPath(import.meta.url)
const phaseIndex = process.argv.indexOf('--phase')
const phase = phaseIndex < 0 ? undefined : process.argv[phaseIndex + 1]
const runtimeRoot = process.env.DZ23_M75_RUNTIME_ROOT

assert.equal(process.platform, 'linux', 'M75 runtime restart proof must run on Linux/WSL2')
assert.ok(studioRoot.startsWith('/home/'), `M75 proof must run on ext4, got ${studioRoot}`)
assert.equal(existsSync(join(studioRoot, '.env')), false,
  'M75 proof refuses a project .env so provider credentials cannot enter the child runtime')
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing pinned upstream: ${upstreamRoot}`)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot, encoding: 'utf8' }).trim(),
  '6c705be1ce6774a000d061da41d1823b03a3d42c')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function boot() {
  assert.ok(runtimeRoot, 'DZ23_M75_RUNTIME_ROOT is required in a proof phase')
  const dshHome = join(runtimeRoot, 'dsh-home')
  const profileLink = join(dshHome, 'profiles', 'studio')
  await mkdir(dirname(profileLink), { recursive: true })
  if (!existsSync(profileLink)) await symlink(profile, profileLink, 'dir')

  process.env.DSH_HOME = dshHome
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DZ23_AGENT_WORKTREE_ROOT = join(runtimeRoot, 'agent-worktrees')
  process.env.DZ23_COORDINATOR_PRESET_ROOT = join(studioRoot, 'dsh-home', '.agent-presets')
  process.env.DZ23_OLLAMA_PLACEHOLDER = 'ollama-local-placeholder-not-a-secret'

  const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
  const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
  const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
  assert.ok(profileBootChunk, 'built CLI does not expose profile boot')
  const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([
    moduleAt('packages/boot/app-boot/lib/index.js'),
    moduleAt(`apps/cli/lib/${profileBootChunk}`),
  ])
  const originalLog = console.log
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) return
    originalLog(...args)
  }
  try {
    return await runProfile({
      environment: loadLayeredEnv('dz23-studio-m75-restart-proof', studioRoot),
      profile: 'studio',
      patchFiles: [
        join(profile, 'poc-01b.patch.yml'),
        join(runtimeRoot, 'runtime-paths.patch.yml'),
      ],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  } finally {
    console.log = originalLog
  }
}

function domains(ctx) {
  const runs = ctx.storageDomain.get('studio_agent_runs')
  const leases = ctx.storageDomain.get('studio_agent_leases')
  const teams = ctx.storageDomain.get('studio_agent_teams')
  assert.ok(runs && leases && teams, 'agent persistence domains were not mounted')
  return {
    runs: runs.table('runs'),
    leases: leases.table('leases'),
    teams: teams.table('teams'),
    tasks: teams.table('tasks'),
  }
}

async function seedInterruptedState(ctx) {
  const repositoryPath = join(runtimeRoot, 'person-repository')
  const worktreePath = join(runtimeRoot, 'preserved-worktree')
  const baseCommit = git(['rev-parse', 'HEAD'], repositoryPath)
  const timestamp = '2026-09-06T18:00:00.000Z'
  const storage = domains(ctx)
  await storage.runs.put('run-restart-proof', {
    run_id: 'run-restart-proof', org_id: 'org-proof', tenant_id: 'tenant-proof',
    workspace_id: 'workspace-proof', parent_session_id: 'parent-before-restart',
    coordinator_session_id: 'coordinator-before-restart', provider: 'spawn-in-process',
    worktree_path: worktreePath, repository_path: repositoryPath, base_commit: baseCommit,
    status: 'RUNNING', changed_files: ['src/proposal.txt'], diff_bytes: 17,
    diff_sha256: '0'.repeat(64), main_changed_during_run: false,
    approved_by: 'user-proof', approved_at: timestamp, diagnostic: null,
    created_at: timestamp, updated_at: timestamp,
  })
  await storage.leases.put('lease-restart-proof', {
    lease_id: 'lease-restart-proof', run_id: 'run-restart-proof', org_id: 'org-proof',
    tenant_id: 'tenant-proof', workspace_id: 'workspace-proof', repository_path: repositoryPath,
    paths: ['src/proposal.txt'], active: true,
    // A-03: a cerca é gravada no armazenamento do perfil e tem de atravessar o
    // reinício. Uma cerca que voltasse a zero faria a reserva seguinte receber
    // um número MENOR do que a que ela precisa superar.
    fence: 4,
    created_at: timestamp, released_at: null,
  })
  await storage.teams.put('team-restart-proof', {
    team_id: 'team-restart-proof', org_id: 'org-proof', tenant_id: 'tenant-proof',
    workspace_id: 'workspace-proof', repository_path: repositoryPath,
    parent_session_id: 'parent-before-restart', name: 'Equipe interrompida',
    provider: 'spawn-in-process', required_tier: 'T2', sensitive_operation: null,
    status: 'RUNNING', approved_by: 'user-proof', approved_at: timestamp,
    diagnostic: null, created_at: timestamp, updated_at: timestamp,
  })
  await storage.tasks.put('team-restart-proof:task-one', {
    task_id: 'task-one', team_id: 'team-restart-proof', org_id: 'org-proof',
    tenant_id: 'tenant-proof', workspace_id: 'workspace-proof', title: 'Tarefa interrompida',
    role: 'implementer', prompt: 'Preserve a proposta depois do reinício.',
    intended_paths: ['src/proposal.txt'], depends_on: [], status: 'RUNNING',
    run_id: 'run-restart-proof', job_id: 'studio-agent-before-restart', diagnostic: null,
    created_at: timestamp, updated_at: timestamp,
  })
  return { seeded: true, baseCommit }
}

function assertRecoveredState(ctx, expectedCounts) {
  assertReconciliation(ctx.studioAgents.restartReconciliation, expectedCounts.agents)
  assertReconciliation(ctx.studioAgentTeams.restartReconciliation, expectedCounts.teams)
  const run = ctx.studioAgents.runs().find(candidate => candidate.run_id === 'run-restart-proof')
  const lease = ctx.studioAgents.leases().find(candidate => candidate.lease_id === 'lease-restart-proof')
  const team = ctx.studioAgentTeams.teams().find(candidate => candidate.team_id === 'team-restart-proof')
  const task = ctx.studioAgentTeams.tasks().find(candidate => candidate.task_id === 'task-one')
  assert.equal(run?.status, 'FAILED')
  assert.match(run?.diagnostic ?? '', /interrompida pelo reinício/u)
  // A-03: a marca ESTRUTURAL de "parou por reinício" atravessou o reinício de
  // verdade, em processo separado e com o armazenamento do perfil. Decidir a
  // retomada pela FRASE do diagnóstico faria uma troca de palavra na tradução
  // desligar a retomada em silêncio.
  assert.equal(run?.interrupted_by_restart, true)
  assert.equal(ctx.studioAgents.resumable(run), true)
  // A cerca sobreviveu ao reinício, e a próxima é maior. Sem isso, a reserva
  // nova depois de um reinício não superaria a antiga.
  assert.equal(lease?.fence, 4)
  const repositoryForFence = join(runtimeRoot, 'person-repository')
  assert.equal(ctx.studioAgents.nextFence({ workspaceId: 'workspace-proof', repositoryPath: repositoryForFence }), 5)
  assert.equal(lease?.active, false)
  assert.ok(lease?.released_at)
  assert.equal(task?.status, 'FAILED')
  assert.equal(task?.diagnostic, run?.diagnostic)
  assert.equal(team?.status, 'NEEDS_ATTENTION')
  const repositoryPath = join(runtimeRoot, 'person-repository')
  const worktreePath = join(runtimeRoot, 'preserved-worktree')
  assert.equal(readFileSync(join(worktreePath, 'src', 'proposal.txt'), 'utf8'), 'proposta-preservada\n')
  assert.match(git(['worktree', 'list', '--porcelain'], repositoryPath),
    new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  return {
    runStatus: run.status, leaseActive: lease.active, taskStatus: task.status, teamStatus: team.status,
    interruptedByRestart: run.interrupted_by_restart === true, resumable: ctx.studioAgents.resumable(run),
    leaseFence: lease.fence ?? 0,
    // A próxima reserva neste repositório recebe um número MAIOR do que o que
    // sobreviveu ao reinício — conferido depois do reinício, contra o que o
    // armazenamento do perfil realmente devolveu.
    nextFenceAfterRestart: ctx.studioAgents.nextFence({ workspaceId: 'workspace-proof', repositoryPath: join(runtimeRoot, 'person-repository') }),
  }
}

/**
 * Compara os contadores e valida `reconciledAt` como carimbo real.
 * Antes isto era `reconciledAt: <o próprio valor lido>` — uma asserção
 * tautológica, que passa com qualquer coisa e não prova nada.
 */
function assertReconciliation(actual, expectedCounts) {
  const { reconciledAt, ...counts } = actual
  assert.deepEqual(counts, expectedCounts)
  assert.match(reconciledAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.ok(Number.isFinite(Date.parse(reconciledAt)))
}

async function runPhase() {
  let app
  try {
    app = await boot()
    if (phase === 'seed') {
      assertReconciliation(app.ctx.studioAgents.restartReconciliation,
        { interruptedRuns: 0, releasedLeases: 0, unresolvedRuns: 0, keptLeases: 0 })
      const result = await seedInterruptedState(app.ctx)
      process.stdout.write(`M75_PHASE_RESULT=${JSON.stringify({ phase, ...result })}\n`)
      return
    }
    if (phase === 'recover') {
      const result = assertRecoveredState(app.ctx, {
        agents: { interruptedRuns: 1, releasedLeases: 1, unresolvedRuns: 0, keptLeases: 0 },
        teams: { updatedTasks: 1, updatedTeams: 1 },
      })
      process.stdout.write(`M75_PHASE_RESULT=${JSON.stringify({ phase, ...result })}\n`)
      return
    }
    if (phase === 'idempotent') {
      const result = assertRecoveredState(app.ctx, {
        agents: { interruptedRuns: 0, releasedLeases: 0, unresolvedRuns: 0, keptLeases: 0 },
        teams: { updatedTasks: 0, updatedTeams: 0 },
      })
      process.stdout.write(`M75_PHASE_RESULT=${JSON.stringify({ phase, ...result })}\n`)
      return
    }
    throw new Error(`unknown M75 proof phase: ${phase}`)
  } finally {
    if (app !== undefined) await app.shutdown.shutdown(0)
  }
}

function runChild(childPhase, root) {
  const home = join(root, 'isolated-home')
  const result = spawnSync(process.execPath, [scriptPath, '--phase', childPhase], {
    cwd: studioRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '', HOME: home, LANG: process.env.LANG ?? 'C.UTF-8',
      DSH_UPSTREAM_ROOT: upstreamRoot, DZ23_M75_RUNTIME_ROOT: root,
      DSH_TELEMETRY_DISABLED: '1',
      STUDIO_BWRAP_PATH: process.env.STUDIO_BWRAP_PATH ?? '/usr/bin/bwrap',
    },
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`M75 ${childPhase} process failed with status ${result.status}`)
  }
  const line = (result.stdout ?? '').split(/\r?\n/u).find(value => value.startsWith('M75_PHASE_RESULT='))
  assert.ok(line, `M75 ${childPhase} process did not return structured evidence`)
  return JSON.parse(line.slice('M75_PHASE_RESULT='.length))
}

async function prepareRepository(root) {
  const repositoryPath = join(root, 'person-repository')
  const worktreePath = join(root, 'preserved-worktree')
  await mkdir(join(repositoryPath, 'src'), { recursive: true })
  await writeFile(join(repositoryPath, 'src', 'keep.txt'), 'checkout-da-pessoa\n')
  git(['init', '-q'], repositoryPath)
  git(['config', 'user.email', 'proof@dz23.local'], repositoryPath)
  git(['config', 'user.name', 'DZ23 Proof'], repositoryPath)
  git(['add', '.'], repositoryPath)
  git(['commit', '-qm', 'M75 restart proof base'], repositoryPath)
  git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repositoryPath)
  await writeFile(join(worktreePath, 'src', 'proposal.txt'), 'proposta-preservada\n')
}

async function prepareRuntimePatch(root) {
  await writeFile(join(root, 'runtime-paths.patch.yml'), [
    '- id: dz23-studio-prompt-to-app',
    '  config:',
    `    runsRoot: ${join(root, 'generated-runs')}`,
    `    logoStoreRoot: ${join(root, 'assets')}`,
    '    builder:',
    `      imageDigestFile: ${join(root, 'builder-image-digest')}`,
    `      templateStore: ${join(root, 'template-store')}`,
    '- id: dz23-studio-preview',
    '  config:',
    '    supervisor:',
    `      artifactRoot: ${join(root, 'generated-runs')}`,
    '- id: dz23-studio-integration-hub',
    '  config:',
    `    runsRoot: ${join(root, 'generated-runs')}`,
    `    exportsRoot: ${join(root, 'exports')}`,
    '',
  ].join('\n'))
}

if (phase !== undefined) {
  await runPhase()
} else {
  const runtimeParent = join(studioRoot, 'runtime')
  await mkdir(runtimeParent, { recursive: true })
  const tempPrefix = join(runtimeParent, 'm75-restart-')
  const root = await mkdtemp(tempPrefix)
  assert.equal(root.startsWith(tempPrefix), true)
  try {
    await prepareRepository(root)
    await prepareRuntimePatch(root)
    const seed = runChild('seed', root)
    const recovered = runChild('recover', root)
    const idempotent = runChild('idempotent', root)
    process.stdout.write(`${JSON.stringify({
      decision: 'GO', transport: 'three-separate-node-processes',
      persistedBackend: 'profile-storage', upstreamCommit: '6c705be1ce6774a000d061da41d1823b03a3d42c',
      seed, recovered, idempotent, worktreePreservedAcrossRestart: true,
      // A retomada existe e a elegibilidade dela atravessa o reinício de
      // verdade (ver `resumable` acima, conferido em processo separado). O que
      // continua NÃO EXECUTADO neste ambiente é a retomada de ponta a ponta com
      // um assistente real escrevendo na cópia preservada — isso exige provedor
      // de verdade, e um dublê aqui provaria o dublê.
      processResumption: 'ELIGIBILITY_PROVEN_END_TO_END_NOT_EXECUTED',
      externalProviders: 'NOT_EXECUTED',
    }, null, 2)}\n`)
  } finally {
    const normalizedRoot = resolve(root)
    const normalizedPrefix = resolve(runtimeParent, 'm75-restart-')
    assert.ok(normalizedRoot.startsWith(`${normalizedPrefix}`), `refusing to remove unexpected proof root: ${normalizedRoot}`)
    await rm(normalizedRoot, { recursive: true, force: true })
  }
}
