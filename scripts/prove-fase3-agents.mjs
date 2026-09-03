import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT
  ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const studioRoot = resolve(process.cwd())
const runId = randomUUID()
const runtimeRoot = join(studioRoot, 'runtime', `fase3-proof-${runId}`)
const dshHome = join(runtimeRoot, 'dsh-home')
const repositoryPath = join(runtimeRoot, 'person-workspace')
const worktreeRoot = join(runtimeRoot, 'agent-worktrees')
const profile = join(studioRoot, 'dsh-home', 'profiles', 'studio')

assert.equal(process.platform, 'linux', 'PoC 3A must run on Linux/WSL2')
assert.ok(studioRoot.startsWith('/home/'), `PoC 3A must run on ext4, got ${studioRoot}`)
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing pinned upstream: ${upstreamRoot}`)
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot, encoding: 'utf8' }).trim(),
  '6c705be1ce6774a000d061da41d1823b03a3d42c')

process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.DZ23_AGENT_WORKTREE_ROOT = worktreeRoot
process.env.DZ23_COORDINATOR_PRESET_ROOT = join(studioRoot, 'dsh-home', '.agent-presets')
process.env.DZ23_OLLAMA_PLACEHOLDER = 'ollama-local-placeholder-not-a-secret'

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
assert.ok(profileBootChunk, 'built CLI does not expose profile boot')
const [{ loadLayeredEnv }, { runProfile }, { SessionId }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  moduleAt(`apps/cli/lib/${profileBootChunk}`),
  moduleAt('packages/core/session/lib/index.js'),
])

function git(args, cwd = repositoryPath) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function prepareRepository() {
  await mkdir(join(repositoryPath, 'src'), { recursive: true })
  await writeFile(join(repositoryPath, 'src', 'keep.txt'), 'checkout-da-pessoa\n')
  git(['init', '-q'])
  git(['config', 'user.email', 'proof@dz23.local'])
  git(['config', 'user.name', 'DZ23 Proof'])
  git(['add', '.'])
  git(['commit', '-qm', 'PoC 3A base'])
}

async function boot() {
  await mkdir(join(dshHome, 'profiles'), { recursive: true })
  await symlink(profile, join(dshHome, 'profiles', 'studio'), 'dir')
  const originalLog = console.log
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) return
    originalLog(...args)
  }
  try {
    return await runProfile({
      environment: loadLayeredEnv('dz23-studio-poc-3a', studioRoot),
      profile: 'studio',
      patchFiles: [],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  } finally {
    console.log = originalLog
  }
}

let booted
let parentHandle
try {
  await prepareRepository()
  const mainBefore = git(['status', '--porcelain=v1'])
  const treeBefore = git(['rev-parse', 'HEAD^{tree}'])
  booted = await boot()
  const routes = booted.ctx.llm.listProviders().map(provider => provider.id)
  for (const route of ['studio-fake', 'deepseek-official', 'omniroute', 'ollama']) assert.ok(routes.includes(route), `missing route ${route}`)
  assert.equal(routes.includes('9router'), false)
  const subagents = booted.ctx.subagents.list()
  for (const provider of ['spawn-in-process', 'codex', 'claude-code']) assert.ok(subagents.includes(provider), `missing provider ${provider}`)

  const parentSessionId = SessionId(`fase3-person-${runId}`)
  parentHandle = await booted.ctx.agents.create({
    sessionId: parentSessionId,
    meta: { cwd: repositoryPath },
    agentOptions: { provider: 'studio-fake', model: 'studio-deterministic' },
    setup: agentCtx => booted.ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  assert.equal(await booted.ctx.studioIdentity.service.requestMagicCode('fase3-proof@example.com'), 'sent')
  const email = booted.ctx.studioIdentity.developmentEmailCapture?.messages.at(-1)
  assert.ok(email)
  const issued = await booted.ctx.studioIdentity.service.verifyMagicCode(email.to, email.code, {
    label: 'PoC 3A', userAgent: 'proof', ipTruncated: '127.0.0.0/24',
  })
  await booted.ctx.studioIdentity.service.bindHarnessSession(issued.session, String(parentSessionId))
  const accepted = booted.ctx.studioAgents.service.start({
    orgId: issued.session.org_id,
    tenantId: issued.session.tenant_id,
    workspaceId: issued.session.tenant_id,
    repositoryPath,
    parent: parentHandle.agent,
    provider: 'spawn-in-process',
    prompt: 'PHASE3_WORKTREE_PROBE',
    intendedPaths: ['src/poc3a.txt'],
    approval: { approved: true, tier: 'T2', approvedBy: issued.session.user_id },
    inProcess: { toolFilter: { allow: ['write'] } },
    budget: { timeoutMs: 30_000, maxFiles: 1, maxDiffBytes: 16_384, maxTokens: 1_000 },
  })
  const settled = await booted.ctx.jobs.wait(accepted.jobId, 35_000, parentHandle.agent)
  const record = booted.ctx.studioAgents.runs().find(candidate => candidate.run_id === accepted.runId)
  if (settled.status !== 'completed') {
    process.stderr.write(`${JSON.stringify({ settled, record, audits: booted.ctx.studioPolicy.auditRecords() }, null, 2)}\n`)
  }
  assert.equal(settled.status, 'completed', `delegation did not complete: ${settled.detail ?? ''}; ${record?.diagnostic ?? ''}`)
  const outcome = booted.ctx.jobs.read(accepted.jobId, parentHandle.agent)
  if (!outcome.text.includes('poc-3a-isolated')) {
    process.stderr.write(`${JSON.stringify({ outcome, record, audits: booted.ctx.studioPolicy.auditRecords() }, null, 2)}\n`)
  }
  assert.match(outcome.text, /poc-3a-isolated/)
  assert.ok(record)
  assert.equal(record.status, 'PROPOSED')
  assert.deepEqual(record.changed_files, ['src/poc3a.txt'])
  assert.equal(existsSync(join(record.worktree_path, 'src', 'poc3a.txt')), true)
  assert.equal(readFileSync(join(repositoryPath, 'src', 'keep.txt'), 'utf8'), 'checkout-da-pessoa\n')
  assert.equal(existsSync(join(repositoryPath, 'src', 'poc3a.txt')), false)
  assert.equal(git(['status', '--porcelain=v1']), mainBefore)
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), treeBefore)
  assert.match(git(['worktree', 'list', '--porcelain']), new RegExp(record.worktree_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(booted.ctx.agents.get(SessionId(record.coordinator_session_id)), undefined)
  assert.ok(booted.ctx.studioPolicy.auditRecords().some(audit => audit.tool_name === 'write' && audit.decision !== 'deny'))

  async function negativeProbe(prompt, intendedPaths) {
    const started = booted.ctx.studioAgents.service.start({
      orgId: issued.session.org_id,
      tenantId: issued.session.tenant_id,
      workspaceId: issued.session.tenant_id,
      repositoryPath,
      parent: parentHandle.agent,
      provider: 'spawn-in-process',
      prompt,
      intendedPaths,
      approval: { approved: true, tier: 'T2', approvedBy: issued.session.user_id },
      inProcess: { toolFilter: { allow: ['write'] } },
      budget: { timeoutMs: 30_000, maxFiles: 1, maxDiffBytes: 16_384, maxTokens: 1_000 },
    })
    const job = await booted.ctx.jobs.wait(started.jobId, 35_000, parentHandle.agent)
    const run = booted.ctx.studioAgents.runs().find(candidate => candidate.run_id === started.runId)
    assert.ok(run)
    assert.equal(job.status, 'completed', `${prompt} failed: ${job.detail ?? ''}; ${run.diagnostic ?? ''}`)
    return { run, outcome: booted.ctx.jobs.read(started.jobId, parentHandle.agent) }
  }

  const escapeProbe = await negativeProbe('PHASE3_ESCAPE_PROBE', ['src'])
  assert.deepEqual(escapeProbe.run.changed_files, [])
  assert.match(escapeProbe.run.diagnostic ?? '', /PHASE3_ESCAPE_BLOCKED/)
  assert.equal(existsSync(join(escapeProbe.run.worktree_path, '..', 'phase3-outside.txt')), false)

  const toolDenialProbe = await negativeProbe('PHASE3_TOOL_DENIAL_PROBE', ['src'])
  assert.deepEqual(toolDenialProbe.run.changed_files, [])
  assert.match(toolDenialProbe.run.diagnostic ?? '', /PHASE3_TOOL_DENIED/)
  assert.equal(existsSync(join(toolDenialProbe.run.worktree_path, 'src', 'denied.txt')), false)
  assert.equal(git(['status', '--porcelain=v1']), mainBefore)
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), treeBefore)

  async function realProviderProof(provider, enabled, filename) {
    if (!enabled) return 'NOT_EXECUTED'
    const state = booted.ctx.studioAgents.providerStates()[provider]
    assert.equal(state, 'OK', `${provider} real proof requested but preflight state is ${state}`)
    const relativePath = `src/${filename}`
    const started = booted.ctx.studioAgents.service.start({
      orgId: issued.session.org_id,
      tenantId: issued.session.tenant_id,
      workspaceId: issued.session.tenant_id,
      repositoryPath,
      parent: parentHandle.agent,
      provider,
      prompt: `Create exactly one file named ${relativePath} containing dz23-real-provider-proof followed by a newline. Do not change any other file. Do not commit.`,
      intendedPaths: [relativePath],
      approval: { approved: true, tier: 'T2', approvedBy: issued.session.user_id },
      budget: { timeoutMs: 180_000, maxFiles: 1, maxDiffBytes: 16_384 },
    })
    const job = await booted.ctx.jobs.wait(started.jobId, 185_000, parentHandle.agent)
    const run = booted.ctx.studioAgents.runs().find(candidate => candidate.run_id === started.runId)
    assert.ok(run)
    assert.equal(job.status, 'completed', `${provider} real proof failed: ${job.detail ?? ''}; ${run.diagnostic ?? ''}`)
    assert.equal(run.status, 'PROPOSED')
    assert.deepEqual(run.changed_files, [relativePath])
    assert.equal(readFileSync(join(run.worktree_path, relativePath), 'utf8'), 'dz23-real-provider-proof\n')
    assert.equal(existsSync(join(repositoryPath, relativePath)), false)
    assert.equal(git(['status', '--porcelain=v1']), mainBefore)
    assert.equal(git(['rev-parse', 'HEAD^{tree}']), treeBefore)
    return 'GO'
  }

  const realProviders = {
    codex: await realProviderProof('codex', process.env.DZ23_REAL_CODEX === '1', 'real-codex-proof.txt'),
    claude: await realProviderProof('claude-code', process.env.DZ23_REAL_CLAUDE === '1', 'real-claude-proof.txt'),
  }

  const proof = {
    decision: 'GO', upstreamCommit: '6c705be1ce6774a000d061da41d1823b03a3d42c',
    routes, subagents,
    coordinator: { internal: true, cwd: record.worktree_path, disposed: true, parentSessionId: String(parentSessionId) },
    isolation: {
      mainWorkspaceUnchanged: true,
      worktreeListed: true,
      proposedDiffOnly: true,
      outsideWriteBlocked: true,
      filteredToolUnavailable: true,
    },
    policy: { requiredTier: accepted.requiredTier, scopedPreapproval: true, inheritedIdentity: true },
    budgets: { timeoutMs: 30_000, maxFiles: 1, maxDiffBytes: 16_384, tokenLimitMeasurable: false },
    realProviders,
  }
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
} finally {
  await parentHandle?.dispose()
  if (booted !== undefined) await booted.shutdown.shutdown(0)
  await rm(runtimeRoot, { recursive: true, force: true })
}
