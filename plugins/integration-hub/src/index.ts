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
import { t } from './i18n.js'
import { studioIntegrationsDomainSpec, type HubEvent, type HubKey, type StudioExport, type StudioIntegration } from './model.js'
import { IntegrationHubService, smtpSecretShape, type EmailTestPort, type HubRepository, type SecretInspector } from './service.js'

export * from './model.js'
export * from './manifest.js'
export * from './zip.js'
export * from './export.js'
export * from './service.js'
export * from './http.js'

export const name = 'dz23-studio-integration-hub'
export const inject = ['storageDomain', 'credentials', 'webServer', 'studioIdentity', 'studioTenancy', 'studioPromptToApp']

export interface IntegrationHubConfig {
  readonly exportsRoot?: string
  /** Publisher id → Ed25519 public key (SPKI base64 or PEM). Public material only. */
  readonly publisherKeys?: Readonly<Record<string, string>>
  /** `stable` (default) refuses to enable unsigned integrations (D16); `dev` allows them for local development. */
  readonly channel?: 'stable' | 'dev'
  /** Only the operator turns this on, after the e-mail provider is chosen; until then the test is NOT_EXECUTED. */
  readonly smtpTestEnabled?: boolean
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
}

class DomainHubRepository implements HubRepository {
  constructor(
    private readonly integrationTable: KvTable<HubKey, StudioIntegration>,
    private readonly exportTable: KvTable<HubKey, StudioExport>,
    private readonly eventTable: KvTable<HubKey, HubEvent>,
  ) {}
  integrations() { return values(this.integrationTable) }
  putIntegration(value: StudioIntegration) { return this.integrationTable.put(value.integration_id as HubKey, value) }
  exports() { return values(this.exportTable) }
  putExport(value: StudioExport) { return this.exportTable.put(value.export_id as HubKey, value) }
  events() { return values(this.eventTable) }
  putEvent(value: HubEvent) { return this.eventTable.put(value.event_id as HubKey, value) }
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
      const secret = smtpSecretShape.parse(JSON.parse(resolved.value))
      const transport = nodemailer.createTransport({ host: secret.host, port: secret.port, secure: secret.secure, requireTLS: !secret.secure, auth: { user: secret.user, pass: secret.pass } })
      await transport.sendMail({ from: secret.from, to, subject: t('smtp.testSubject'), text: t('smtp.testBody') })
    },
  }
}

export async function apply(ctx: Context, config: IntegrationHubConfig = {}): Promise<void> {
  const domain: Domain<typeof studioIntegrationsDomainSpec> = await ctx.storageDomain.open(studioIntegrationsDomainSpec)
  ctx.effect(() => () => domain.close(), 'dz23-studio-integration-hub.domainClose')
  const exportsRoot = resolve(config.exportsRoot ?? resolve(homedir(), '.dz23-studio', 'exports'))
  await mkdir(exportsRoot, { recursive: true, mode: 0o700 })
  const publisherKeys = z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u), z.string().min(32)).parse(config.publisherKeys ?? {})
  const promptToApp = ctx.studioPromptToApp.service
  const service = new IntegrationHubService({
    repository: new DomainHubRepository(domain.table('integrations'), domain.table('exports'), domain.table('events')),
    secrets: credentialInspector(ctx.credentials),
    projects: {
      project: (actor, projectId) => promptToApp.project(actor, projectId),
      runs: (actor, projectId) => promptToApp.runs(actor, projectId),
    },
    exportsRoot, publisherKeys, channel: config.channel ?? 'stable',
    emailTest: config.smtpTestEnabled === true ? smtpTestPort(ctx.credentials) : undefined,
  })
  ctx.provide('studioIntegrationHub', { service })
  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`; const defaultOrigin = `http://localhost:${port}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/studio/hub',
    handler: createHubHttpHandler({
      service, identity: ctx.studioIdentity.service, tenancy: ctx.studioTenancy.service,
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
    }),
  }), 'dz23-studio-integration-hub.http')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioIntegrationHub: { readonly service: IntegrationHubService }
  }
}
