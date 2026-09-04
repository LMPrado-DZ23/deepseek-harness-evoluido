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
import { IntegrationHubService, securityFingerprint, smtpSecretShape, type EmailTestPort, type HubActor, type HubRepository, type SecretInspector } from './service.js'

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
  #eventTail: Promise<void> = Promise.resolve()
  readonly #integrations = new Map<string, Map<string, StudioIntegration>>()
  readonly #exports = new Map<string, Map<string, StudioExport>>()
  readonly #events = new Map<string, HubEvent[]>()
  readonly #integrationKeys = new Map<string, HubKey>()
  readonly #exportKeys = new Map<string, HubKey>()
  readonly #eventKeys = new Map<string, HubKey>()

  constructor(
    private readonly integrationTable: KvTable<HubKey, StudioIntegration>,
    private readonly exportTable: KvTable<HubKey, StudioExport>,
    private readonly eventTable: KvTable<HubKey, HubEvent>,
  ) {
    // The storage-domain seam itself is memory resident. Build bounded, scoped
    // indexes once at open so requests never clone and filter all three tables.
    for (const [key, value] of integrationTable.entries()) {
      mapFor(this.#integrations, scopeOf(value)).set(value.integration_id, value)
      this.#integrationKeys.set(recordKey(value, value.integration_id), key)
    }
    for (const [key, value] of exportTable.entries()) {
      mapFor(this.#exports, projectScopeOf(value, value.project_id)).set(value.export_id, value)
      this.#exportKeys.set(recordKey(value, value.export_id), key)
    }
    for (const [key, value] of eventTable.entries()) {
      arrayFor(this.#events, scopeOf(value)).push(value)
      this.#eventKeys.set(recordKey(value, value.event_id), key)
    }
    for (const rows of this.#events.values()) rows.sort(newestEventFirst)
  }

  integrations(scope: HubActor) { return [...(this.#integrations.get(scopeOf(scope))?.values() ?? [])] }
  integration(scope: HubActor, integrationId: string) { return this.#integrations.get(scopeOf(scope))?.get(integrationId) }
  putIntegration(value: StudioIntegration) { return this.#exclusiveIntegration(() => this.#putIntegration(value)) }
  compareAndSwapIntegration(scope: HubActor, integrationId: string, expectedFingerprint: string, value: StudioIntegration) {
    return this.#exclusiveIntegration(async () => {
      const current = this.integration(scope, integrationId)
      if (current === undefined || securityFingerprint(current) !== expectedFingerprint) return false
      await this.#putIntegration(value)
      return true
    })
  }
  exports(scope: HubActor, projectId: string) { return [...(this.#exports.get(projectScopeOf(scope, projectId))?.values() ?? [])] }
  export(scope: HubActor, projectId: string, exportId: string) { return this.#exports.get(projectScopeOf(scope, projectId))?.get(exportId) }
  async putExport(value: StudioExport) {
    const key = physicalKey(value, value.export_id)
    await this.exportTable.put(key, value)
    const identity = recordKey(value, value.export_id)
    const previous = this.#exportKeys.get(identity)
    if (previous !== undefined && previous !== key) await this.exportTable.delete(previous)
    this.#exportKeys.set(identity, key)
    mapFor(this.#exports, projectScopeOf(value, value.project_id)).set(value.export_id, value)
  }
  eventPage(scope: HubActor, after: Pick<HubEvent, 'created_at' | 'event_id'> | undefined, limit: number) {
    const rows = this.#events.get(scopeOf(scope)) ?? []
    const start = after === undefined ? 0 : rows.findIndex(value => newestEventFirst(value, after) > 0)
    return start < 0 ? [] : rows.slice(start, start + limit)
  }
  eventCount(scope: HubActor) { return this.#events.get(scopeOf(scope))?.length ?? 0 }
  putEvent(value: HubEvent) {
    return this.#exclusiveEvent(async () => {
      const key = physicalKey(value, value.event_id)
      await this.eventTable.put(key, value)
      const identity = recordKey(value, value.event_id)
      const previous = this.#eventKeys.get(identity)
      if (previous !== undefined && previous !== key) await this.eventTable.delete(previous)
      this.#eventKeys.set(identity, key)
      const rows = arrayFor(this.#events, scopeOf(value))
      const old = rows.findIndex(event => event.event_id === value.event_id)
      if (old >= 0) rows.splice(old, 1)
      rows.push(value)
      rows.sort(newestEventFirst)
    })
  }
  pruneEvents(scope: HubActor, keep: number) {
    return this.#exclusiveEvent(async () => {
      const rows = this.#events.get(scopeOf(scope)) ?? []
      const removed = rows.splice(keep)
      for (const value of removed) {
        const identity = recordKey(value, value.event_id)
        const key = this.#eventKeys.get(identity)
        if (key !== undefined) await this.eventTable.delete(key)
        this.#eventKeys.delete(identity)
      }
      return removed.length
    })
  }

  async #putIntegration(value: StudioIntegration): Promise<void> {
    const key = physicalKey(value, value.integration_id)
    await this.integrationTable.put(key, value)
    const identity = recordKey(value, value.integration_id)
    const previous = this.#integrationKeys.get(identity)
    if (previous !== undefined && previous !== key) await this.integrationTable.delete(previous)
    this.#integrationKeys.set(identity, key)
    mapFor(this.#integrations, scopeOf(value)).set(value.integration_id, value)
  }

  #exclusiveIntegration<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#integrationTail.then(work, work)
    this.#integrationTail = result.then(() => undefined, () => undefined)
    return result
  }

  #exclusiveEvent<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#eventTail.then(work, work)
    this.#eventTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function scopeOf(value: { readonly org_id?: string; readonly tenant_id?: string; readonly orgId?: string; readonly tenantId?: string }): string {
  return JSON.stringify([value.org_id ?? value.orgId, value.tenant_id ?? value.tenantId])
}

function projectScopeOf(value: { readonly org_id?: string; readonly tenant_id?: string; readonly orgId?: string; readonly tenantId?: string }, projectId: string): string {
  return JSON.stringify([value.org_id ?? value.orgId, value.tenant_id ?? value.tenantId, projectId])
}

function recordKey(value: { readonly org_id: string; readonly tenant_id: string }, id: string): string {
  return JSON.stringify([value.org_id, value.tenant_id, id])
}

function physicalKey(value: { readonly org_id: string; readonly tenant_id: string }, id: string): HubKey {
  return recordKey(value, id) as HubKey
}

function mapFor<T>(index: Map<string, Map<string, T>>, key: string): Map<string, T> {
  let rows = index.get(key)
  if (rows === undefined) { rows = new Map(); index.set(key, rows) }
  return rows
}

function arrayFor<T>(index: Map<string, T[]>, key: string): T[] {
  let rows = index.get(key)
  if (rows === undefined) { rows = []; index.set(key, rows) }
  return rows
}

function newestEventFirst(left: Pick<HubEvent, 'created_at' | 'event_id'>, right: Pick<HubEvent, 'created_at' | 'event_id'>): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.event_id < right.event_id ? 1 : left.event_id > right.event_id ? -1 : 0
}

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
