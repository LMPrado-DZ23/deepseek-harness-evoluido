import type { Context } from '@deepseek-ai/cordis'
import { t } from './i18n.js'
import type {} from '@deepseek-ai/dsh-agent'
import { isIP } from 'node:net'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PolicyIdentityState } from '@dz23-studio/policy'
import { createIdentityHttpHandler } from './http.js'
import { MemoryEmailSender, SmtpEmailSender, type EmailSender } from './email.js'
import {
  identityAuditDomainSpec,
  identityCredentialsDomainSpec,
  identitySessionsDomainSpec,
  identityUsersDomainSpec,
  type ChallengeRecord,
  type IdentityAuditRecord,
  type IdentityKey,
  type IdentityUser,
  type MagicCodeRecord,
  type PasskeyCredential,
  type SessionRecord,
} from './model.js'
import { SimpleWebAuthnProvider, type PasskeyProvider } from './passkey.js'
import { StudioIdentityService, type EnrollmentMode, type IdentityPrincipal, type IdentityRepository } from './service.js'

export * from './crypto.js'
export * from './email.js'
export * from './http.js'
export * from './model.js'
export * from './mutex.js'
export * from './passkey.js'
export * from './rate-limit.js'
export * from './service.js'

export const name = 'dz23-studio-identity'

/**
 * Structural boundary for agent lineage. Harness session identifiers are
 * persisted strings; keeping the boundary structural prevents two injected
 * workspace copies from creating incompatible nominal brand symbols.
 */
export interface AgentLineageNode {
  readonly session: {
    readonly id: string
    readonly header?: { readonly parentSession?: string }
  }
}

export interface AgentLookup { getBySessionId(id: string): AgentLineageNode | undefined }

/** Resolve identity through an explicitly recorded agent lineage, never through ambient process state. */
export function identityStateForAgent(
  service: StudioIdentityService,
  agents: AgentLookup,
  agent: AgentLineageNode | undefined,
  bindHost: '127.0.0.1' | '0.0.0.0',
): PolicyIdentityState {
  for (const candidate of agentLineage(agents, agent)) {
    const state = service.identityStateForHarnessSession(String(candidate.session.id), bindHost)
    if (state.authenticated) return state
  }
  return { authenticated: false, strongIdentityVerified: false }
}

/** Resolve the tenant principal through the same durable parentSession lineage. */
export function principalForAgent(
  service: StudioIdentityService,
  agents: AgentLookup,
  agent: AgentLineageNode | undefined,
): IdentityPrincipal | undefined {
  for (const candidate of agentLineage(agents, agent)) {
    const principal = service.principalForHarnessSession(String(candidate.session.id))
    if (principal !== undefined) return principal
  }
  return undefined
}

function* agentLineage(agents: AgentLookup, start: AgentLineageNode | undefined): Generator<AgentLineageNode> {
  const seen = new Set<string>()
  let current = start
  while (current !== undefined && !seen.has(String(current.session.id))) {
    seen.add(String(current.session.id))
    yield current
    const parent = current.session.header?.parentSession
    current = parent === undefined ? undefined : agents.getBySessionId(parent)
  }
}
export const inject = ['agents', 'storageDomain', 'webServer', 'studioPolicy', 'credentials']

export interface IdentityPluginConfig {
  readonly rpName?: string
  readonly rpId?: string
  readonly expectedOrigin?: string
  readonly defaultOrgId?: string
  readonly defaultTenantId?: string
  readonly enrollment?: EnrollmentMode
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly edge?: { readonly required?: boolean; readonly secretRef?: string }
  readonly cookieSecurity?: 'secure' | 'loopback-http'
  readonly email?: { readonly kind: 'memory' } | { readonly kind: 'smtp'; readonly secretRef: string }
  readonly now?: () => Date
  readonly createId?: () => string
  readonly createSecret?: () => string
  readonly createMagicCode?: () => string
  readonly passkeys?: PasskeyProvider
  readonly emailSender?: EmailSender
}

export interface StudioIdentityRuntime {
  readonly service: StudioIdentityService
  readonly developmentEmailCapture?: MemoryEmailSender
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioIdentity: StudioIdentityRuntime
  }
}

class DomainIdentityRepository implements IdentityRepository {
  constructor(
    private readonly userTable: KvTable<IdentityKey, IdentityUser>,
    private readonly credentialTable: KvTable<IdentityKey, PasskeyCredential>,
    private readonly challengeTable: KvTable<IdentityKey, ChallengeRecord>,
    private readonly magicCodeTable: KvTable<IdentityKey, MagicCodeRecord>,
    private readonly sessionTable: KvTable<IdentityKey, SessionRecord>,
    private readonly auditTable: KvTable<IdentityKey, IdentityAuditRecord>,
  ) {}

  users(): readonly IdentityUser[] { return values(this.userTable) }
  putUser(record: IdentityUser): Promise<void> { return this.userTable.put(record.user_id as IdentityKey, record) }
  credentials(): readonly PasskeyCredential[] { return values(this.credentialTable) }
  putCredential(record: PasskeyCredential): Promise<void> { return this.credentialTable.put(record.credential_id as IdentityKey, record) }
  challenges(): readonly ChallengeRecord[] { return values(this.challengeTable) }
  putChallenge(record: ChallengeRecord): Promise<void> { return this.challengeTable.put(record.challenge_id as IdentityKey, record) }
  magicCodes(): readonly MagicCodeRecord[] { return values(this.magicCodeTable) }
  putMagicCode(record: MagicCodeRecord): Promise<void> { return this.magicCodeTable.put(record.magic_code_id as IdentityKey, record) }
  sessions(): readonly SessionRecord[] { return values(this.sessionTable) }
  putSession(record: SessionRecord): Promise<void> { return this.sessionTable.put(record.session_id as IdentityKey, record) }
  audits(): readonly IdentityAuditRecord[] { return values(this.auditTable) }
  putAudit(record: IdentityAuditRecord): Promise<void> { return this.auditTable.put(record.audit_id as IdentityKey, record) }
}

function values<T>(table: KvTable<IdentityKey, T>): T[] {
  return [...table.entries()].map(([, value]) => value)
}

export async function apply(ctx: Context, config: IdentityPluginConfig = {}): Promise<void> {
  const rpId = config.rpId ?? 'localhost'
  assertValidRpId(rpId)
  if (ctx.webServer.host !== '127.0.0.1' && config.edge?.required === false) {
    throw new Error(t('config.serverModeRequiresEdge'))
  }
  const edgeRequired = config.edge?.required ?? ctx.webServer.host !== '127.0.0.1'
  const edgeSecretRef = config.edge?.secretRef === undefined ? undefined : credentialRef(config.edge.secretRef)
  if (edgeRequired && edgeSecretRef === undefined) {
    throw new Error(t('config.serverModeRequiresEdgeSecret'))
  }
  if (edgeRequired && config.enrollment === 'open') {
    throw new Error(t('config.closedEnrollmentRequired'))
  }
  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`
  const defaultOrigin = `http://localhost:${port}`
  const allowedHosts = config.allowedHosts ?? [defaultHost, `localhost:${port}`]
  const allowedOrigins = config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`]
  const cookieSecurity = config.cookieSecurity ?? (!edgeRequired && ctx.webServer.host === '127.0.0.1' ? 'loopback-http' : 'secure')
  if (cookieSecurity === 'loopback-http') assertLoopbackHttpCookies(ctx.webServer.host, allowedHosts, allowedOrigins)
  const [usersDomain, credentialsDomain, sessionsDomain, auditDomain]: [
    Domain<typeof identityUsersDomainSpec>,
    Domain<typeof identityCredentialsDomainSpec>,
    Domain<typeof identitySessionsDomainSpec>,
    Domain<typeof identityAuditDomainSpec>,
  ] = await Promise.all([
    ctx.storageDomain.open(identityUsersDomainSpec),
    ctx.storageDomain.open(identityCredentialsDomainSpec),
    ctx.storageDomain.open(identitySessionsDomainSpec),
    ctx.storageDomain.open(identityAuditDomainSpec),
  ])
  ctx.effect(() => async () => {
    await Promise.all([usersDomain.close(), credentialsDomain.close(), sessionsDomain.close(), auditDomain.close()])
  }, 'dz23-studio-identity.domainClose')

  const repository = new DomainIdentityRepository(
    usersDomain.table('users'),
    credentialsDomain.table('credentials'),
    credentialsDomain.table('challenges'),
    usersDomain.table('magic_codes'),
    sessionsDomain.table('sessions'),
    auditDomain.table('events'),
  )
  const email = resolveEmailSender(ctx, config, edgeRequired)
  let harnessAuthenticationUrl: ((baseUrl: string) => string) | undefined
  ctx.inject(['connection'], (connectionCtx) => {
    harnessAuthenticationUrl = baseUrl => connectionCtx.connection.authenticatedUrl(baseUrl)
    return () => { harnessAuthenticationUrl = undefined }
  })
  const service = new StudioIdentityService({
    repository,
    passkeys: config.passkeys ?? new SimpleWebAuthnProvider(),
    emailSender: email.sender,
    rpName: config.rpName ?? 'DZ23 STUDIO',
    rpId,
    expectedOrigin: config.expectedOrigin ?? defaultOrigin,
    defaultOrgId: config.defaultOrgId ?? 'org_local',
    defaultTenantId: config.defaultTenantId ?? 'tenant_local',
    enrollment: config.enrollment ?? (!edgeRequired && ctx.webServer.host === '127.0.0.1' ? 'open' : 'closed'),
    personalModeAllowed: !edgeRequired,
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.createId === undefined ? {} : { createId: config.createId }),
    ...(config.createSecret === undefined ? {} : { createSecret: config.createSecret }),
    ...(config.createMagicCode === undefined ? {} : { createMagicCode: config.createMagicCode }),
  })
  // A borda declara ao SERVIÇO quais endereços aceita: é assim que a conferência
  // de Host e Origin alcança as rotas autenticadas dos outros plugins.
  service.setRequestTrust({ allowedHosts, allowedOrigins })
  // O NOME do cookie de sessao depende disto (ver `sessionCookieName`), e os
  // seis plugins que usam `authenticatedMutation`/`requiredSessionToken` nao
  // recebem a configuracao — eles perguntam ao servico. Sem esta linha o
  // servico fica no padrao seguro (`__Host-`) e o modo pessoal em http nao
  // entraria: falha na direcao certa, mas falha.
  service.setCookieSecurity(cookieSecurity === 'secure')
  ctx.provide('studioIdentity', {
    service,
    ...(email.capture === undefined ? {} : { developmentEmailCapture: email.capture }),
  })
  type RegistrySessionId = Parameters<typeof ctx.agents.get>[0]
  const agentLookup: AgentLookup = {
    getBySessionId: sessionId => ctx.agents.get(sessionId as RegistrySessionId),
  }
  const unsetResolver = ctx.studioPolicy.setIdentityResolver(execution => {
    return identityStateForAgent(service, agentLookup, execution.agent, ctx.webServer.host)
  })
  ctx.effect(() => unsetResolver, 'dz23-studio-identity.policyResolver')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/studio/identity',
    handler: createIdentityHttpHandler({
      service,
      bindHost: ctx.webServer.host,
      allowedHosts,
      allowedOrigins,
      edgeRequired,
      secureCookies: cookieSecurity === 'secure',
      ...(edgeSecretRef === undefined ? {} : {
        resolveEdgeSecret: async () => (await ctx.credentials.resolve(edgeSecretRef))?.value,
      }),
      harnessAuthenticationUrl: baseUrl => harnessAuthenticationUrl?.(baseUrl),
    }),
  }), 'dz23-studio-identity.http')
}

function assertLoopbackHttpCookies(
  bindHost: '127.0.0.1' | '0.0.0.0',
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
): void {
  const localName = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1'
  let valid = bindHost === '127.0.0.1' && allowedHosts.length > 0 && allowedOrigins.length > 0
  try {
    valid &&= allowedHosts.every(host => localName(new URL(`http://${host}`).hostname))
    valid &&= allowedOrigins.every(origin => {
      const parsed = new URL(origin)
      return parsed.protocol === 'http:' && parsed.username === '' && parsed.password === '' && localName(parsed.hostname)
    })
  } catch { valid = false }
  if (!valid) throw new Error('cookieSecurity loopback-http exige bind 127.0.0.1 e somente origens HTTP *.localhost.')
}

export function assertValidRpId(rpId: string): void {
  const domain = rpId.toLowerCase()
  const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
  if (isIP(rpId) !== 0 || (domain !== 'localhost' && !validDomain.test(domain))) {
    throw new Error(t('config.invalidRpId'))
  }
}

function resolveEmailSender(
  ctx: Context,
  config: IdentityPluginConfig,
  edgeRequired: boolean,
): { sender: EmailSender; capture?: MemoryEmailSender } {
  if (config.emailSender !== undefined) return { sender: config.emailSender }
  if (config.email?.kind === 'smtp') {
    return { sender: new SmtpEmailSender(ctx.credentials, credentialRef(config.email.secretRef)) }
  }
  if (config.email?.kind === 'memory' && ctx.webServer.host === '127.0.0.1') {
    const capture = new MemoryEmailSender()
    return { sender: capture, capture }
  }
  if (ctx.webServer.host !== '127.0.0.1' || edgeRequired) {
    throw new Error(t('config.serverModeRequiresSmtp'))
  }
  const capture = new MemoryEmailSender()
  return { sender: capture, capture }
}
