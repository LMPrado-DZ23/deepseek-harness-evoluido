/** Identidade, permissões e trabalho pessoal, persistidos em JSON e reabertos em outro processo. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { StudioIdentityService } from '../plugins/identity/lib/service.js'
import * as identityModel from '../plugins/identity/lib/model.js'
import { StudioTenancyService } from '../plugins/tenancy/lib/service.js'
import * as tenancyModel from '../plugins/tenancy/lib/model.js'
import { DomainPromptToAppRepository } from '../plugins/prompt-to-app/lib/domain-repository.js'
import { PromptToAppService } from '../plugins/prompt-to-app/lib/service.js'
import * as projectModel from '../plugins/prompt-to-app/lib/model.js'
import { AssistantSessionLauncher } from '../plugins/studio-web/lib/assistant-session.js'

const pluginRequire = createRequire(new URL('../plugins/prompt-to-app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(pluginRequire.resolve('@deepseek-ai/cordis')).href)
const script = fileURLToPath(import.meta.url)
const scopeOf = session => [session.user_id, session.org_id, session.tenant_id]

// Adaptadores de tabela para os contratos de identidade/tenancy: todos os dados
// são dos domínios reais, revalidados pelos schemas na reabertura do processo.
function bind(repository, domain, table, key, reader, writer) {
  const target = domain.table(table)
  repository[reader] = () => [...target.entries()].map(([, value]) => value)
  repository[writer] = value => target.put(value[key], value)
}

async function phase(root, mode) {
  const ctx = new Context(); await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'domains'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  try {
    const users = await facility.open(identityModel.identityUsersDomainSpec)
    const credentials = await facility.open(identityModel.identityCredentialsDomainSpec)
    const sessions = await facility.open(identityModel.identitySessionsDomainSpec)
    const audit = await facility.open(identityModel.identityAuditDomainSpec)
    const identityRepository = {}
    bind(identityRepository, users, 'users', 'user_id', 'users', 'putUser')
    bind(identityRepository, users, 'magic_codes', 'magic_code_id', 'magicCodes', 'putMagicCode')
    bind(identityRepository, credentials, 'credentials', 'credential_id', 'credentials', 'putCredential')
    bind(identityRepository, credentials, 'challenges', 'challenge_id', 'challenges', 'putChallenge')
    bind(identityRepository, sessions, 'sessions', 'session_id', 'sessions', 'putSession')
    bind(identityRepository, audit, 'events', 'audit_id', 'audits', 'putAudit')
    let receivedCode
    const identity = new StudioIdentityService({
      repository: identityRepository, emailSender: { sendMagicCode: async message => { receivedCode = message.code } },
      passkeys: {}, rpName: 'FRIGG proof', rpId: 'localhost', expectedOrigin: 'http://localhost',
      defaultOrgId: 'org-default-proof', defaultTenantId: 'tenant-default-proof', enrollment: 'open', personalModeAllowed: true,
    })
    identity.setBindHost('127.0.0.1')
    const tenancyRepository = {}
    const orgs = await facility.open(tenancyModel.studioOrgsDomainSpec)
    const workspaces = await facility.open(tenancyModel.studioWorkspacesDomainSpec)
    const memberships = await facility.open(tenancyModel.studioMembershipsDomainSpec)
    bind(tenancyRepository, orgs, 'orgs', 'org_id', 'organizations', 'putOrganization')
    bind(tenancyRepository, workspaces, 'workspaces', 'workspace_id', 'workspaces', 'putWorkspace')
    bind(tenancyRepository, memberships, 'memberships', 'membership_id', 'memberships', 'putMembership')
    bind(tenancyRepository, memberships, 'invitations', 'invitation_id', 'invitations', 'putInvitation')
    const tenancy = new StudioTenancyService({ repository: tenancyRepository, identity, emailSender: {} })
    for (const user of identity.userRecords()) await tenancy.ensureBootstrap(user)
    identity.setEnrollmentResolver(email => tenancy.enrollmentGrantFor(email))
    identity.setUserProvisioner((user, source) => source === 'bootstrap' ? tenancy.ensureBootstrap(user) : Promise.resolve())
    const specs = [projectModel.studioProjectsDomainSpec, projectModel.studioAppSpecsDomainSpec, projectModel.studioDesignSpecsDomainSpec,
      projectModel.studioIntakeTurnsDomainSpec, projectModel.studioPlansDomainSpec, projectModel.studioRunsDomainSpec,
      projectModel.studioEvidenceDomainSpec, projectModel.studioApprovalsDomainSpec, projectModel.studioCreationKeysDomainSpec]
    const names = ['projects', 'specs', 'designs', 'turns', 'plans', 'runs', 'evidence', 'approvals', 'keys']
    const domains = await Promise.all(specs.map(spec => facility.open(spec)))
    const repository = new DomainPromptToAppRepository(...domains.map((domain, index) => domain.table(names[index])))
    const projects = new PromptToAppService({ repository })
    const workspaceRoot = join(root, 'workspaces')
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
    const files = await AssistantSessionLauncher.create({ identity, tenancy, sessions: {}, repositories: [], workspaceRoot })
    let expected; let authenticated
    if (mode === 'write') {
      const personal = identity.personalSession()
      assert.ok(personal)
      const actor = tenancy.authorizationFor(...scopeOf(personal))
      assert.equal(actor.role, 'owner')
      const project = await projects.createProject(actor, { name: 'Trabalho antes do cadastro', original_brief: 'Apresentar meus serviços.', category: 'landing-page', privacy: 'local-only' })
      const foreign = await projects.createProject({ userId: 'other-user', orgId: 'other-org', tenantId: 'other-tenant', role: 'owner' }, { name: 'Outro espaço', original_brief: 'Projeto isolado.', category: 'landing-page', privacy: 'local-only' })
      const directory = await files.pastaDeTrabalho(personal, 'project.write')
      await writeFile(join(directory, 'personal-note.txt'), 'Trabalho preservado.', { mode: 0o600 })
      await identity.requestMagicCode('owner@example.test')
      assert.equal(typeof receivedCode, 'string')
      const issued = await identity.verifyMagicCode('owner@example.test', receivedCode, { label: 'proof', userAgent: 'proof', ipTruncated: '127.0.0.0/24' })
      authenticated = await identity.authenticate(issued.token)
      assert.deepEqual(scopeOf(authenticated), scopeOf(personal), 'o registro não pode trocar o dono nem o espaço do trabalho')
      expected = { projectId: project.project_id, foreignId: foreign.project_id, token: issued.token, directory }
      // Token apenas desta instalação temporária, nunca impresso nem enviado ao Git.
      await writeFile(join(root, 'expected.json'), JSON.stringify(expected), { mode: 0o600 })
    } else {
      expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'))
      authenticated = await identity.authenticate(expected.token)
    }
    assert.equal(identity.personalSession(), undefined, 'acesso anônimo deve terminar após o registro')
    const actor = tenancy.authorizationFor(...scopeOf(authenticated))
    assert.equal(actor.role, 'owner')
    assert.equal(projects.project(actor, expected.projectId).created_by, authenticated.user_id)
    assert.deepEqual(projects.listProjects(actor).map(project => project.project_id), [expected.projectId])
    assert.throws(() => projects.project(actor, expected.foreignId), { code: 'NOT_FOUND' })
    const directory = await files.pastaDeTrabalho(authenticated, 'project.read')
    assert.equal(directory, expected.directory)
    assert.equal(await readFile(join(directory, 'personal-note.txt'), 'utf8'), 'Trabalho preservado.')
    assert.equal(identityRepository.users().length, 1)
    assert.equal(tenancyRepository.memberships().length, 1)
    return { phase: mode, status: 'PASS', projectsPreserved: 1, filesPreserved: 1, foreignScopeDenied: true, anonymousAccessDisabled: true }
  } finally {
    await facility.closeAll(); await backend.close()
  }
}

if (process.argv[2] === '--phase') {
  assert.ok(['write', 'reopen'].includes(process.argv[3])); assert.ok(process.argv[4])
  console.log(JSON.stringify(await phase(process.argv[4], process.argv[3])))
} else {
  const root = await mkdtemp(join(tmpdir(), 'frigg-personal-adoption-'))
  try {
    const results = []
    for (const mode of ['write', 'reopen']) {
      const child = spawnSync(process.execPath, [script, '--phase', mode, root], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(child.status, 0, child.stderr || child.error?.message)
      results.push(JSON.parse(child.stdout))
    }
    console.log(JSON.stringify({ proof: 'PERSONAL_ADOPTION', status: 'PASS', separateProcesses: true, storage: 'Harness JSON domains', emailTransport: 'captured locally, not SMTP', results }))
  } finally { await rm(root, { recursive: true, force: true }) }
}
