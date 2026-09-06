#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const studioRoot = resolve(process.cwd())
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT
  ?? join(studioRoot, 'third_party', 'deepseek-harness'))
const sourceHome = join(studioRoot, 'dsh-home')
const scratch = await mkdtemp(join(tmpdir(), 'dz23-assistant-session-proof-'))
const runtimeHome = join(scratch, 'dsh-home')
const repository = join(scratch, 'repository')
const worktrees = join(scratch, 'worktrees')
const runsRoot = join(scratch, 'generated-runs')
const assetsRoot = join(scratch, 'assets')
const exportsRoot = join(scratch, 'exports')
const templateStore = join(scratch, 'template-store')
const imageDigestFile = join(scratch, 'builder-image-digest')
const proofPatch = join(scratch, 'runtime-paths.patch.yml')
const email = 'assistant-runtime-proof@example.com'

assert.equal(process.platform, 'linux', 'A prova da sessão do Assistente exige Linux/WSL2.')
assert.ok(studioRoot.startsWith('/home/'), `A prova deve rodar no ext4 do WSL2: ${studioRoot}`)

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const [{ loadLayeredEnv }, { runProfile }, { SessionId }, { createUserMessage }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  findProfileBoot(),
  moduleAt('packages/core/session/lib/index.js'),
  moduleAt('packages/llm/llm/lib/index.js'),
])

let booted
let approvalOff
let browserHandoff = 'NOT_EXECUTED'
try {
  await Promise.all([
    mkdir(join(runtimeHome, 'profiles'), { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(worktrees, { recursive: true }),
  ])
  await symlink(join(sourceHome, 'profiles', 'studio'), join(runtimeHome, 'profiles', 'studio'), 'dir')
  await execFileAsync('git', ['init', '-q'], { cwd: repository })
  await writeFile(proofPatch, [
    '- id: dz23-studio-prompt-to-app',
    '  config:',
    '    runsRoot: !!js process.env.DZ23_PROOF_RUNS_ROOT',
    '    logoStoreRoot: !!js process.env.DZ23_PROOF_ASSETS_ROOT',
    '    builder:',
    '      imageDigestFile: !!js process.env.DZ23_PROOF_IMAGE_DIGEST_FILE',
    '      templateStore: !!js process.env.DZ23_PROOF_TEMPLATE_STORE',
    '- id: dz23-studio-preview',
    '  config:',
    '    supervisor:',
    '      artifactRoot: !!js process.env.DZ23_PROOF_RUNS_ROOT',
    '- id: dz23-studio-integration-hub',
    '  config:',
    '    runsRoot: !!js process.env.DZ23_PROOF_RUNS_ROOT',
    '    exportsRoot: !!js process.env.DZ23_PROOF_EXPORTS_ROOT',
    '',
  ].join('\n'))

  const repositories = [{
    orgId: 'org_local',
    tenantId: 'tenant_local',
    workspaceId: 'tenant_local',
    repositoryPath: repository,
    allowedPaths: ['src'],
    providers: ['spawn-in-process'],
    maxPaths: 8,
    budget: { timeoutMs: 60_000, maxFiles: 8, maxDiffBytes: 131_072, maxTokens: 32_000 },
  }]
  process.env.DSH_HOME = runtimeHome
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DZ23_COORDINATOR_PRESET_ROOT = join(sourceHome, '.agent-presets')
  process.env.DZ23_ASSISTANT_REPOSITORIES = JSON.stringify(repositories)
  process.env.DZ23_AGENT_WORKTREE_ROOT = worktrees
  process.env.DZ23_OLLAMA_PLACEHOLDER = 'local-placeholder-not-a-secret'
  process.env.DZ23_PROOF_RUNS_ROOT = runsRoot
  process.env.DZ23_PROOF_ASSETS_ROOT = assetsRoot
  process.env.DZ23_PROOF_EXPORTS_ROOT = exportsRoot
  process.env.DZ23_PROOF_TEMPLATE_STORE = templateStore
  process.env.DZ23_PROOF_IMAGE_DIGEST_FILE = imageDigestFile

  booted = await runProfile({
    environment: loadLayeredEnv('dsh-studio-m71-proof', studioRoot),
    profile: 'studio',
    patchFiles: [join(sourceHome, 'profiles', 'studio', 'poc-01b.patch.yml'), proofPatch],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  })

  assert.equal(await booted.ctx.studioIdentity.service.requestMagicCode(email), 'sent')
  const message = booted.ctx.studioIdentity.developmentEmailCapture?.messages.at(-1)
  assert.ok(message, 'O login local não capturou o código de desenvolvimento.')
  const issued = await booted.ctx.studioIdentity.service.verifyMagicCode(
    message.to,
    message.code,
    { label: 'M71 runtime proof', userAgent: 'runtime-proof', ipTruncated: '127.0.0.0/24' },
  )
  const authorization = booted.ctx.studioTenancy.service.authorizationFor(
    issued.session.user_id,
    issued.session.org_id,
    issued.session.tenant_id,
  )
  assert.equal(authorization?.role, 'owner')

  const origin = `http://127.0.0.1:${String(booted.ctx.webServer.port)}`
  const headers = {
    'content-type': 'application/json',
    cookie: `dz23_studio_session=${encodeURIComponent(issued.token)}`,
    origin,
  }
  const missingCsrf = await fetch(`${origin}/studio/assistant/session`, {
    method: 'POST', headers, body: '{}', redirect: 'manual',
  })
  assert.equal(missingCsrf.status, 401, 'A criação aceitou uma mutação sem CSRF.')

  const firstResponse = await fetch(`${origin}/studio/assistant/session`, {
    method: 'POST',
    headers: { ...headers, 'x-dz23-csrf': issued.csrfToken },
    body: '{}',
    redirect: 'manual',
  })
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text())
  const first = await firstResponse.json()
  assert.deepEqual(
    { reused: first.reused, preset: first.preset },
    { reused: false, preset: 'dz23-assistant' },
  )
  assert.equal(typeof first.session_id, 'string')
  assert.ok(first.session_id.length > 0)

  const inspected = await booted.ctx.sessionController.inspect(SessionId(first.session_id))
  assert.equal(inspected.meta.agentPreset, 'dz23-assistant')
  assert.equal(inspected.meta.cwd, repository)
  const agent = booted.ctx.agents.get(SessionId(first.session_id))
  assert.ok(agent, 'A sessão criada não possui Agent ativo no Harness.')
  const tools = booted.ctx.tools.schemas(agent).map(tool => tool.name).sort()
  assert.equal(tools.filter(name => name.startsWith('studio_agent_') || name.startsWith('studio_team_')).length, 13)

  const approvals = []
  approvalOff = booted.ctx.on('approval/request', (request) => {
    approvals.push({ toolName: request.toolName, callId: String(request.callId) })
    return Promise.resolve('allowed-once')
  }, { prepend: true })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Run the deterministic Studio echo proof.' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const conversationText = agent.session.deriveMessages()
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  assert.match(conversationText, /STUDIO_ECHO_OK/)
  assert.deepEqual(approvals.map(item => item.toolName), ['studio_echo'])
  assert.ok(agent.session.events.some(event => event.type === 'approval/asked'))
  assert.ok(agent.session.events.some(event => event.type === 'approval/decided'
    && event.data.outcome === 'allowed-once'))
  await booted.ctx.sessions.flush(agent.session)

  const browserControlDirectory = process.env.DZ23_BROWSER_PROOF_CONTROL_DIR?.trim()
  if (browserControlDirectory !== undefined && browserControlDirectory !== '') {
    assert.ok(isAbsolute(browserControlDirectory), 'O diretório de controle do navegador deve ser absoluto.')
    assert.match(basename(browserControlDirectory), /^dz23-assistant-browser-proof-[a-z0-9-]+$/u)
    const control = join(browserControlDirectory, 'ready.json')
    const result = join(browserControlDirectory, 'result.json')
    await mkdir(browserControlDirectory, { recursive: false, mode: 0o700 })
    await writeFile(control, JSON.stringify({
      origin,
      sessionToken: issued.token,
      expectedSessionId: first.session_id,
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      const browserResult = await waitForBrowserResult(result)
      assert.deepEqual(browserResult, { status: 'PASS', sessionId: first.session_id })
      browserHandoff = 'PASS_IN_WINDOWS_EDGE'
    } finally {
      await Promise.all([rm(control, { force: true }), rm(result, { force: true })])
    }
  }

  const secondResponse = await fetch(`${origin}/studio/assistant/session`, {
    method: 'POST',
    headers: { ...headers, 'x-dz23-csrf': issued.csrfToken },
    body: '{}',
    redirect: 'manual',
  })
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text())
  const second = await secondResponse.json()
  assert.deepEqual(second, { session_id: first.session_id, reused: true, preset: 'dz23-assistant' })

  const persistedIdentity = booted.ctx.studioIdentity.service.sessionRecords()
    .find(candidate => candidate.session_id === issued.session.session_id)
  assert.ok(persistedIdentity?.harness_session_ids.includes(first.session_id))

  await booted.ctx.studioIdentity.service.revokeSession(issued.session, issued.session.session_id)
  const revoked = await fetch(`${origin}/studio/assistant/session`, {
    method: 'POST',
    headers: { ...headers, 'x-dz23-csrf': issued.csrfToken },
    body: '{}',
    redirect: 'manual',
  })
  assert.equal(revoked.status, 401, 'Uma sessão de identidade revogada ainda abriu o Assistente.')

  process.stdout.write(`${JSON.stringify({
    proof: 'DZ23_STUDIO_M71_ASSISTANT_SESSION',
    status: 'PASS',
    upstream: '6c705be1ce6774a000d061da41d1823b03a3d42c',
    transport: 'real HTTP on loopback',
    sessionController: 'real',
    identity: 'real login + CSRF + revocation',
    agentPreset: inspected.meta.agentPreset,
    repository: inspected.meta.cwd,
    tools: tools.length,
    governedTools: 13,
    conversationTurn: 'PASS_WITH_DETERMINISTIC_PROVIDER',
    deterministicProvider: 'studio-fake/studio-deterministic',
    approval: { policy: 'ask', outcome: 'allowed-once', requests: approvals.length },
    resumedSameSession: second.session_id === first.session_id && second.reused === true,
    browserHandoff,
    limitations: {
      realModelTurn: 'NOT_EXECUTED',
      multiUserConversationIsolation: 'NOT_SUPPORTED',
    },
  }, null, 2)}\n`)
} finally {
  approvalOff?.()
  if (booted !== undefined) await booted.shutdown.shutdown(0)
  await rm(scratch, { recursive: true, force: true })
}

async function findProfileBoot() {
  const { readFile, readdir } = await import('node:fs/promises')
  const cliRoot = join(upstreamRoot, 'apps', 'cli', 'lib')
  const bin = await readFile(join(cliRoot, 'bin.js'), 'utf8')
  const chunk = bin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/u)?.[1]
  assert.ok(chunk, 'O CLI compilado não expõe o carregador de profile.')
  const available = await readdir(cliRoot)
  assert.ok(available.includes(chunk), `O chunk do profile não existe: ${chunk}`)
  return import(pathToFileURL(join(cliRoot, chunk)).href)
}

async function waitForBrowserResult(path) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const info = await lstat(path).catch(() => undefined)
    if (info?.isSymbolicLink()) throw new Error('O resultado do navegador não pode ser um link simbólico.')
    if (info?.isFile()) return JSON.parse(await readFile(path, 'utf8'))
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('O navegador não concluiu a prova em 120 segundos.')
}
