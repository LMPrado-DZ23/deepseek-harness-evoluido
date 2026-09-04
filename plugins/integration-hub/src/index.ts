/** Integration Hub v1: registry with D16 tiers and manifest verification, SMTP by credential reference for generated apps, prototype export. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@dz23-studio/prompt-to-app'
import type {} from '@dz23-studio/identity'
import type {} from '@dz23-studio/tenancy'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { createHubHttpHandler } from './http.js'
import { isLoopbackAuthority, isLoopbackEndpoint } from './manifest.js'
import { t } from './i18n.js'
import { studioIntegrationsDomainSpec, type HubEvent, type HubKey, type StudioExport, type StudioIntegration } from './model.js'
import { IntegrationHubService, securityFingerprint, smtpSecretShape, type EmailTestPort, type HubRepository, type SecretInspector } from './service.js'

export * from './model.js'
export * from './manifest.js'
export * from './zip.js'
export * from './export.js'
export * from './service.js'
export * from './http.js'
export * from './signing.js'

export const name = 'dz23-studio-integration-hub'
export const inject = ['storageDomain', 'credentials', 'webServer', 'studioIdentity', 'studioTenancy', 'studioPromptToApp']

export interface IntegrationHubConfig {
  readonly exportsRoot?: string
  /** Publisher id → Ed25519 public key (SPKI base64 or PEM). Public material only. */
  readonly publisherKeys?: Readonly<Record<string, string>>
  /**
   * `stable` (default) refuses to enable unsigned integrations (D16); `dev`
   * allows an UNSIGNED one for local development and never a wrong signature.
   * It is read from this configuration only: an environment variable must not
   * be able to lower the policy of a running Studio.
   */
  readonly channel?: 'stable' | 'dev'
  /** Root of the generated runs; a `run_directory` outside it is refused before the export reads anything. */
  readonly runsRoot?: string
  /** Only the operator turns this on, after the e-mail provider is chosen; until then the test is NOT_EXECUTED. */
  readonly smtpTestEnabled?: boolean
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
}

class DomainHubRepository implements HubRepository {
  #integrationTail: Promise<void> = Promise.resolve()
  constructor(
    private readonly integrationTable: KvTable<HubKey, StudioIntegration>,
    private readonly exportTable: KvTable<HubKey, StudioExport>,
    private readonly eventTable: KvTable<HubKey, HubEvent>,
  ) {}
  integrations() { return values(this.integrationTable) }
  putIntegration(value: StudioIntegration) { return this.#exclusiveIntegration(() => this.integrationTable.put(value.integration_id as HubKey, value)) }
  compareAndSwapIntegration(integrationId: string, expectedFingerprint: string, value: StudioIntegration) {
    return this.#exclusiveIntegration(async () => {
      const current = this.integrationTable.get(integrationId as HubKey)
      if (current === undefined || securityFingerprint(current) !== expectedFingerprint) return false
      await this.integrationTable.put(integrationId as HubKey, value)
      return true
    })
  }
  exports() { return values(this.exportTable) }
  putExport(value: StudioExport) { return this.exportTable.put(value.export_id as HubKey, value) }
  events() { return values(this.eventTable) }
  putEvent(value: HubEvent) { return this.eventTable.put(value.event_id as HubKey, value) }
  async deleteEvent(eventId: string) { await this.eventTable.delete(eventId as HubKey) }

  #exclusiveIntegration<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#integrationTail.then(work, work)
    this.#integrationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function values<T>(table: KvTable<HubKey, T>): T[] { return [...table.entries()].map(([, value]) => value) }

/** Looks a credential up by reference and reports presence and shape; the value is parsed and discarded here. */
export function credentialInspector(credentials: Context['credentials']): SecretInspector {
  return {
    async inspect(ref) {
      if (!isCredentialRefName(ref)) return { present: false, shapeOk: false }
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved === undefined) return { present: false, shapeOk: false }
      try { return { present: true, shapeOk: smtpSecretShape.safeParse(JSON.parse(resolved.value)).success } } catch { return { present: true, shapeOk: false } }
    },
  }
}

export function smtpTestPort(credentials: Context['credentials']): EmailTestPort {
  return {
    async sendTest(ref, to) {
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved === undefined) throw new Error(t('errors.smtpNotConfigured'))
      // The vault value may have changed since it was configured; a parse failure must never echo the value (JSON errors quote their input).
      let secret: z.infer<typeof smtpSecretShape>
      try { secret = smtpSecretShape.parse(JSON.parse(resolved.value)) } catch { throw new Error(t('errors.secretShapeInvalid')) }
      const transport = nodemailer.createTransport({ host: secret.host, port: secret.port, secure: secret.secure, requireTLS: !secret.secure, auth: { user: secret.user, pass: secret.pass } })
      await transport.sendMail({ from: secret.from, to, subject: t('smtp.testSubject'), text: t('smtp.testBody') })
    },
  }
}

/**
 * The channel comes from the profile configuration and nowhere else. A value
 * that is not exactly `dev` is `stable`: a typo, an injected environment
 * variable or a stray object can only ever make the policy stricter.
 */
export function hubChannel(configured: unknown): 'stable' | 'dev' {
  return configured === 'dev' ? 'dev' : 'stable'
}

/**
 * `dev` is not a configuration flag, it is a claim about WHERE this Studio is
 * running: somebody's own machine. It lowers what may be enabled without a
 * publisher's signature, so it is only accepted on a personal installation
 * reachable from this machine alone — the server bound to loopback and every
 * accepted host and origin loopback too. Anywhere else the Studio refuses to
 * start rather than serve other people with a lowered policy (pending decision
 * #12, accepted). Refusing at boot is deliberate: a Studio that came up and
 * only complained in a log would already be reachable.
 */
export function assertChannelAllowed(channel: 'stable' | 'dev', boundary: {
  readonly bindHost: string
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
}): void {
  if (channel !== 'dev') return
  const local = isLoopbackAuthority(boundary.bindHost)
    && boundary.allowedHosts.length > 0
    && boundary.allowedHosts.every(host => isLoopbackAuthority(host))
    && boundary.allowedOrigins.length > 0
    && boundary.allowedOrigins.every(origin => isLoopbackEndpoint(origin))
  if (!local) throw new Error(t('errors.devChannelNotPersonal'))
}

export async function apply(ctx: Context, config: IntegrationHubConfig = {}): Promise<void> {
  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`; const defaultOrigin = `http://localhost:${port}`
  const allowedHosts = config.allowedHosts ?? [defaultHost, `localhost:${port}`]
  const allowedOrigins = config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`]
  const channel = hubChannel(config.channel)
  // Before the domain is served and before anything is provided: a `dev` channel that is not a
  // personal, loopback-only installation stops the Studio here.
  assertChannelAllowed(channel, { bindHost: ctx.webServer.host, allowedHosts, allowedOrigins })
  const domain: Domain<typeof studioIntegrationsDomainSpec> = await ctx.storageDomain.open(studioIntegrationsDomainSpec)
  ctx.effect(() => () => domain.close(), 'dz23-studio-integration-hub.domainClose')
  const exportsRoot = resolve(config.exportsRoot ?? resolve(homedir(), '.dz23-studio', 'exports'))
  await mkdir(exportsRoot, { recursive: true, mode: 0o700 })
  // Same default as the prompt-to-app plugin: the two must name the same folder, and the export
  // fails closed (and says so) if they ever diverge. Not taken from the environment — the export's
  // only boundary must not be movable by a variable.
  const runsRoot = resolve(config.runsRoot ?? resolve(homedir(), '.dz23-studio', 'generated-runs'))
  const publisherKeys = z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u), z.string().min(32)).parse(config.publisherKeys ?? {})
  const promptToApp = ctx.studioPromptToApp.service
  const service = new IntegrationHubService({
    repository: new DomainHubRepository(domain.table('integrations'), domain.table('exports'), domain.table('events')),
    secrets: credentialInspector(ctx.credentials),
    projects: {
      project: (actor, projectId) => promptToApp.project(actor, projectId),
      runs: (actor, projectId) => promptToApp.runs(actor, projectId),
    },
    exportsRoot, publisherKeys, channel, runsRoot,
    emailTest: config.smtpTestEnabled === true ? smtpTestPort(ctx.credentials) : undefined,
  })
  ctx.provide('studioIntegrationHub', { service })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/studio/hub',
    handler: createHubHttpHandler({
      service, identity: ctx.studioIdentity.service, tenancy: ctx.studioTenancy.service,
      allowedHosts, allowedOrigins,
    }),
  }), 'dz23-studio-integration-hub.http')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioIntegrationHub: { readonly service: IntegrationHubService }
  }
}
