import type { Context } from '@deepseek-ai/cordis'
import { isIP } from 'node:net'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/policy'
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
import { StudioIdentityService, type IdentityRepository } from './service.js'

export * from './crypto.js'
export * from './email.js'
export * from './http.js'
export * from './model.js'
export * from './mutex.js'
export * from './passkey.js'
export * from './rate-limit.js'
export * from './service.js'

export const name = 'dz23-studio-identity'
export const inject = ['storageDomain', 'webServer', 'studioPolicy', 'credentials']

export interface IdentityPluginConfig {
  readonly rpName?: string
  readonly rpId?: string
  readonly expectedOrigin?: string
  readonly defaultOrgId?: string
  readonly defaultTenantId?: string
  readonly enrollment?: 'closed' | 'open'
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly edge?: { readonly required?: boolean; readonly secretRef?: string }
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
    throw new Error('O modo servidor não permite desativar edge.required.')
  }
  const edgeRequired = config.edge?.required ?? ctx.webServer.host !== '127.0.0.1'
  const edgeSecretRef = config.edge?.secretRef === undefined ? undefined : credentialRef(config.edge.secretRef)
  if (edgeRequired && edgeSecretRef === undefined) {
    throw new Error('O modo servidor exige edge.secretRef para validar a borda Caddy.')
  }
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
  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`
  const defaultOrigin = `http://localhost:${port}`
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
    enrollment: config.enrollment ?? (ctx.webServer.host === '127.0.0.1' ? 'open' : 'closed'),
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.createId === undefined ? {} : { createId: config.createId }),
    ...(config.createSecret === undefined ? {} : { createSecret: config.createSecret }),
    ...(config.createMagicCode === undefined ? {} : { createMagicCode: config.createMagicCode }),
  })
  ctx.provide('studioIdentity', {
    service,
    ...(email.capture === undefined ? {} : { developmentEmailCapture: email.capture }),
  })
  const unsetResolver = ctx.studioPolicy.setIdentityResolver(execution => {
    const harnessSessionId = execution.agent === undefined ? '' : String(execution.agent.session.id)
    return service.identityStateForHarnessSession(harnessSessionId, ctx.webServer.host)
  })
  ctx.effect(() => unsetResolver, 'dz23-studio-identity.policyResolver')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/studio/identity',
    handler: createIdentityHttpHandler({
      service,
      bindHost: ctx.webServer.host,
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
      edgeRequired,
      ...(edgeSecretRef === undefined ? {} : {
        resolveEdgeSecret: async () => (await ctx.credentials.resolve(edgeSecretRef))?.value,
      }),
      harnessAuthenticationUrl: baseUrl => harnessAuthenticationUrl?.(baseUrl),
    }),
  }), 'dz23-studio-identity.http')
}

export function assertValidRpId(rpId: string): void {
  const domain = rpId.toLowerCase()
  const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
  if (isIP(rpId) !== 0 || (domain !== 'localhost' && !validDomain.test(domain))) {
    throw new Error('rpId deve ser localhost ou um nome de domínio, nunca um endereço IP, porta ou URL.')
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
    throw new Error('O modo servidor exige um provedor SMTP configurado por referência de segredo.')
  }
  const capture = new MemoryEmailSender()
  return { sender: capture, capture }
}
