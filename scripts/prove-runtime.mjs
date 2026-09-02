import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT
  ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const studioRoot = resolve(process.cwd())
const dshHome = resolve(process.env.DSH_HOME ?? join(studioRoot, 'dsh-home'))
const workspaceRoot = resolve(process.env.STUDIO_PROOF_WORKSPACE ?? join(studioRoot, 'runtime', 'workspace'))
const outsideMarker = join(dirname(workspaceRoot), 'studio-sandbox-outside.txt')
const insideMarker = join(workspaceRoot, 'runtime', 'sandbox-inside.txt')
const sessionIdText = process.env.STUDIO_PROOF_SESSION_ID ?? `studio-poc-01b-${randomUUID()}`
process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'

assert.equal(process.platform, 'linux', 'PoC-01b must run inside Linux/WSL2')
assert.ok(studioRoot.startsWith('/home/'), `PoC-01b must run on WSL2 ext4, got ${studioRoot}`)
assert.ok(workspaceRoot.startsWith('/home/'), `workspace must be on WSL2 ext4, got ${workspaceRoot}`)
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing upstream checkout: ${upstreamRoot}`)

const pnpmStore = join(upstreamRoot, 'node_modules', '.pnpm')
const codexLinuxPackage = readdirSync(pnpmStore)
  .find(name => name.startsWith('@openai+codex@') && name.endsWith('-linux-x64'))
assert.ok(codexLinuxPackage, 'no pinned Linux Codex package supplies Bubblewrap')
const bundledBwrap = join(
  pnpmStore,
  codexLinuxPackage,
  'node_modules',
  '@openai',
  'codex',
  'vendor',
  'x86_64-unknown-linux-musl',
  'codex-resources',
  'bwrap',
)
assert.ok(existsSync(bundledBwrap), `missing bundled Bubblewrap: ${bundledBwrap}`)
process.env.PATH = `${dirname(bundledBwrap)}:${process.env.PATH ?? ''}`
process.env.STUDIO_BWRAP_PATH = bundledBwrap

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
assert.ok(profileBootChunk, 'built CLI does not expose its profile boot chunk')
const [{ loadLayeredEnv }, { runProfile }, { createUserMessage }, { SessionId }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  moduleAt(`apps/cli/lib/${profileBootChunk}`),
  moduleAt('packages/llm/llm/lib/index.js'),
  moduleAt('packages/core/session/lib/index.js'),
])

const userMessage = text => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

function messageText(session) {
  return session.deriveMessages()
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function toolResultText(event) {
  if (event.type !== 'tool/result') return ''
  return event.data.message.content
    .flatMap(block => block.type === 'tool-result' ? block.content : [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

async function bootStudio() {
  const log = console.log
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) return
    log(...args)
  }
  try {
    return await runProfile({
      environment: loadLayeredEnv('dsh-studio-poc-01b', studioRoot),
      profile: 'studio',
      patchFiles: [join(dshHome, 'profiles', 'studio', 'poc-01b.patch.yml')],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  } finally {
    console.log = log
  }
}

async function createAgent(ctx, sessionId) {
  return ctx.agents.create({
    sessionId,
    meta: { cwd: workspaceRoot },
    agentOptions: { provider: 'studio-fake', model: 'studio-deterministic' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
}

async function resumeAgent(ctx, sessionId) {
  return ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'studio-fake', model: 'studio-deterministic' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
}

async function ask(agent, text) {
  agent.followup(userMessage(text))
  await agent.whenIdle()
}

async function stop(booted, handle) {
  await handle?.dispose()
  await booted.shutdown.shutdown(0)
}

const sessionId = SessionId(sessionIdText)
const approvals = []
let first
let firstHandle
let second
let secondHandle
let identityToken
let identitySessionId
let firstIdentityAudits

try {
  await mkdir(workspaceRoot, { recursive: true })
  await rm(insideMarker, { force: true })
  await rm(outsideMarker, { force: true })
  first = await bootStudio()
  const approvalOff = first.ctx.on('approval/request', (request) => {
    approvals.push({ toolName: request.toolName, callId: String(request.callId), reason: request.reason })
    return Promise.resolve('allowed-once')
  }, { prepend: true })
  firstHandle = await createAgent(first.ctx, sessionId)
  assert.equal(first.ctx.studioIdentity.service.isPersonalMode('127.0.0.1'), true)
  await first.ctx.studioIdentity.service.requestMagicCode('runtime-proof@example.com', 'org-proof', 'tenant-proof')
  const capturedMessage = first.ctx.studioIdentity.developmentEmailCapture?.messages.at(-1)
  assert.ok(capturedMessage, 'loopback proof did not capture its development-only email')
  const identityIssued = await first.ctx.studioIdentity.service.verifyMagicCode(
    capturedMessage.to,
    capturedMessage.code,
    { label: 'WSL2 proof', userAgent: 'runtime-proof', ipTruncated: '127.0.0.0/24' },
  )
  identityToken = identityIssued.token
  identitySessionId = identityIssued.session.session_id
  await first.ctx.studioIdentity.service.bindHarnessSession(identityIssued.session, sessionIdText)
  assert.deepEqual(first.ctx.studioIdentity.service.identityStateForHarnessSession(sessionIdText, '127.0.0.1'), {
    authenticated: true,
    strongIdentityVerified: false,
  })
  const confidentialValues = [identityIssued.token, identityIssued.csrfToken, capturedMessage.code]
  const identityEvidence = JSON.stringify({
    audits: first.ctx.studioIdentity.service.auditRecords(),
    sessions: first.ctx.studioIdentity.service.sessionRecords(),
  })
  for (const confidential of confidentialValues) {
    assert.equal(identityEvidence.includes(confidential), false, 'identity secret leaked into durable records')
  }
  const toolNames = first.ctx.tools.schemas(firstHandle.agent).map(schema => schema.name).sort()
  assert.ok(toolNames.includes('studio_echo'), 'Studio tool was not visible to the live agent')
  assert.ok(toolNames.includes('bash'), 'standard preset bash tool was not visible to the live agent')
  assert.equal(first.ctx.sandboxPolicy.defaultMode, 'workspace-write')
  assert.equal(first.ctx.approval.overrideOf(firstHandle.agent.session)
    ?? first.ctx.approval.config.policy, 'ask')

  await ask(firstHandle.agent, 'Run the deterministic Studio echo proof.')
  assert.match(messageText(firstHandle.agent.session), /STUDIO_ECHO_OK/)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].toolName, 'studio_echo')
  assert.ok(firstHandle.agent.session.events.some(event => event.type === 'approval/asked'))
  assert.ok(firstHandle.agent.session.events.some(event => event.type === 'approval/decided'
    && event.data.outcome === 'allowed-once'))
  assert.deepEqual(first.ctx.studioHello.record(), {
    tenant_id: 'tenant-poc-01',
    created_at: '2026-09-01T00:00:00.000Z',
    note: 'PoC-01 deterministic echo',
  })

  await ask(firstHandle.agent, 'SANDBOX_PROBE')
  const insideResult = firstHandle.agent.session.events.findLast(event => event.type === 'tool/result'
    && String(event.data.message.source.callId) === 'studio-sandbox-call')
  assert.ok(insideResult, 'missing inside-workspace bash result')
  const insideResultText = toolResultText(insideResult)
  assert.ok(existsSync(insideMarker), `inside marker was not created; bash result: ${insideResultText}`)
  assert.equal(readFileSync(insideMarker, 'utf8'), 'sandbox-ok')
  assert.match(insideResultText, /sandbox-ok/)

  await ask(firstHandle.agent, 'SANDBOX_ESCAPE_PROBE')
  assert.equal(existsSync(outsideMarker), false, 'sandbox escape marker exists outside workspace')
  const escapeResult = firstHandle.agent.session.events.findLast(event => event.type === 'tool/result'
    && String(event.data.message.source.callId) === 'studio-sandbox-escape-call')
  assert.ok(escapeResult, 'missing outside-workspace bash result')
  assert.match(toolResultText(escapeResult), /sandbox: file access denied under workspace-write mode/)

  const firstEventCount = firstHandle.agent.session.events.length
  await first.ctx.sessions.flush(firstHandle.agent.session)
  const firstRecord = structuredClone(first.ctx.studioHello.record())
  const firstPolicyAudits = structuredClone(first.ctx.studioPolicy.auditRecords()
    .filter(record => record.session_id === sessionIdText))
  firstIdentityAudits = structuredClone(first.ctx.studioIdentity.service.auditRecords())
  assert.ok(firstPolicyAudits.length >= 3, 'policy decisions were not durably recorded')
  approvalOff()
  await stop(first, firstHandle)
  firstHandle = undefined
  first = undefined

  second = await bootStudio()
  const restoredIdentitySession = await second.ctx.studioIdentity.service.authenticate(identityToken, false)
  assert.equal(restoredIdentitySession.session_id, identitySessionId)
  assert.deepEqual(second.ctx.studioIdentity.service.auditRecords(), firstIdentityAudits)
  assert.deepEqual(second.ctx.studioHello.record(), firstRecord)
  assert.deepEqual(second.ctx.studioPolicy.auditRecords()
    .filter(record => record.session_id === sessionIdText), firstPolicyAudits)
  secondHandle = await resumeAgent(second.ctx, sessionId)
  assert.ok(secondHandle.agent.session.events.length >= firstEventCount)
  await ask(secondHandle.agent, 'RESTART_PROBE')
  assert.match(messageText(secondHandle.agent.session), /RESTART_OK history_restored=true/)
  await second.ctx.studioIdentity.service.revokeSession(restoredIdentitySession, restoredIdentitySession.session_id)
  await assert.rejects(() => second.ctx.studioIdentity.service.authenticate(identityToken, false), /sessão foi encerrada/)
  await ask(secondHandle.agent, 'Run the deterministic Studio echo proof after identity revocation.')
  const revokedDecision = second.ctx.studioPolicy.auditRecords().findLast(record => record.session_id === sessionIdText
    && record.tool_name === 'studio_echo')
  assert.deepEqual(
    { decision: revokedDecision?.decision, reason: revokedDecision?.reason },
    { decision: 'deny', reason: 'Sessão de identidade ausente, expirada ou revogada.' },
  )
  await second.ctx.sessions.flush(secondHandle.agent.session)

  const upstreamLock = Object.fromEntries(readFileSync(join(studioRoot, 'UPSTREAM.lock'), 'utf8')
    .trim().split('\n').map(line => line.split('=', 2)))
  const proof = {
    decision: 'GO',
    upstreamCommit: upstreamLock.commit,
    platform: process.platform,
    filesystem: 'WSL2 ext4 (/home)',
    sessionId: sessionIdText,
    logicalDomain: 'studio.hello',
    physicalDomain: 'studio_hello',
    toolsVerified: ['studio_echo', 'bash'],
    approval: { policy: 'ask', outcome: 'allowed-once', requests: approvals.length },
    sandbox: {
      mode: 'workspace-write',
      backend: 'Bubblewrap from the pinned @openai/codex Linux dependency',
      insideWrite: 'allowed',
      outsideWrite: 'denied',
      outsideMarkerExists: existsSync(outsideMarker),
    },
    persistence: {
      sessionResumed: true,
      historyRestored: true,
      domainRecordRestored: true,
      policyAuditDomainRestored: true,
    },
    policyAudit: {
      physicalDomain: 'studio_policy_audit',
      logicalDomain: 'studio.policy.audit',
      recordsBeforeRestart: firstPolicyAudits.length,
    },
    identity: {
      physicalDomains: [
        'studio_identity_users',
        'studio_identity_credentials',
        'studio_identity_sessions',
        'studio_identity_audit',
      ],
      sessionRestoredAfterRestart: true,
      revocationBlockedNextToolCall: true,
      strongIdentityVerified: false,
      durableSecretsExposed: false,
      passkeyHardwareCeremony: 'NOT_EXECUTED',
    },
    eventTypes: [...new Set(secondHandle.agent.session.events.map(event => event.type))].sort(),
  }
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
} finally {
  if (second !== undefined) await stop(second, secondHandle)
  if (first !== undefined) await stop(first, firstHandle)
  await rm(join(dshHome, '.credentials.yaml'), { force: true })
}
