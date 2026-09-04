import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, assertChannelAllowed, credentialInspector, inject, name, smtpTestPort, hubChannel, securityFingerprint, type HubRepository } from '../src/index.ts'
import type { HubEvent, StudioExport, StudioIntegration } from '../src/model.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function credentials(values: Record<string, string>) {
  return { resolve: vi.fn(async (ref: string) => values[ref] === undefined ? undefined : { value: values[ref]!, source: 'env' as const }) }
}

/** The pieces of a Cordis context this plugin actually touches, with the bind host under the test's control. */
function fakeContext(bindHost = '127.0.0.1') {
  const tables = new Map<string, Map<string, unknown>>()
  let entriesCalls = 0
  const domain = {
    table: (tableName: string) => {
      const rows = tables.get(tableName) ?? new Map<string, unknown>()
      tables.set(tableName, rows)
      return {
        entries: () => { entriesCalls += 1; return rows.entries() },
        put: async (key: string, value: unknown) => { rows.set(key, value) },
        delete: async (key: string) => rows.delete(key),
      }
    },
    close: vi.fn(async () => undefined),
  }
  const registered: Array<{ kind: string; path: string }> = []
  const provided = vi.fn()
  const disposers: Array<() => unknown> = []
  const ctx = {
    storageDomain: { open: vi.fn(async () => domain) },
    credentials: credentials({}),
    webServer: { port: 3210, host: bindHost, register: vi.fn((spec: { kind: string; path: string }) => { registered.push(spec); return () => undefined }) },
    studioIdentity: { service: {} }, studioTenancy: { service: {} },
    studioPromptToApp: { service: { project: vi.fn(), runs: vi.fn(() => []) } },
    provide: provided,
    effect: (factory: () => () => unknown) => { disposers.push(factory()) },
  }
  return { ctx, registered, provided, disposers, domain, tables, entriesCalls: () => entriesCalls }
}

describe('integration hub plugin wiring', () => {
  it('inspects credentials by reference without ever returning the value', async () => {
    const inspector = credentialInspector(credentials({
      DZ23_APP_SMTP: JSON.stringify({ host: 'smtp.example.test', port: 587, secure: false, user: 'u', pass: 'p', from: 'app@example.test' }),
      DZ23_BAD_SHAPE: JSON.stringify({ host: 'x' }),
      DZ23_NOT_JSON: 'plain',
    }) as never)
    expect(await inspector.inspect('DZ23_APP_SMTP')).toEqual({ present: true, shapeOk: true })
    expect(await inspector.inspect('DZ23_BAD_SHAPE')).toEqual({ present: true, shapeOk: false })
    expect(await inspector.inspect('DZ23_NOT_JSON')).toEqual({ present: true, shapeOk: false })
    expect(await inspector.inspect('DZ23_MISSING')).toEqual({ present: false, shapeOk: false })
    expect(await inspector.inspect('not a ref')).toEqual({ present: false, shapeOk: false })
  })

  it('refuses to send a test through an unconfigured or malformed credential', async () => {
    const port = smtpTestPort(credentials({ DZ23_BAD: '{"host":"x"}' }) as never)
    await expect(port.sendTest('DZ23_MISSING', 'a@example.test')).rejects.toThrow('ainda não foi configurado')
    await expect(port.sendTest('DZ23_BAD', 'a@example.test')).rejects.toThrow()
  })

  it('opens its domain, provides the service and registers the HTTP prefix; the SMTP test stays off by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-hub-plugin-'))
    roots.push(root)
    const { ctx, registered, provided, disposers, domain } = fakeContext()
    await apply(ctx as never, { exportsRoot: join(root, 'exports') })
    expect(name).toBe('dz23-studio-integration-hub')
    expect(inject).toContain('studioPromptToApp')
    expect(registered.map(spec => [spec.kind, spec.path])).toEqual([['prefix', '/api/studio/hub']])
    const service = provided.mock.calls.find(call => call[0] === 'studioIntegrationHub')?.[1] as { service: { testSmtp(actor: unknown, to: string): Promise<unknown> } }
    expect(service).toBeDefined()
    await Promise.all(disposers.map(dispose => dispose()))
    expect(domain.close).toHaveBeenCalled()
    await expect(apply(ctx as never, { exportsRoot: join(root, 'x'), publisherKeys: { 'BAD ID': 'k' } })).rejects.toThrow()
  })

  it('builds scoped indexes once and pages without materialising domain tables per request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-hub-indexed-'))
    roots.push(root)
    const fixture = fakeContext()
    const eventRows = new Map<string, unknown>()
    for (let index = 0; index < 500; index += 1) {
      eventRows.set(`physical-${index}`, {
        event_id: `event-${String(index).padStart(4, '0')}`, org_id: 'org-a', tenant_id: 'ws-a', actor_user_id: 'u1',
        action: 'approval.requested', subject_id: 'smtp', outcome: 'success', detail: 'seed',
        created_at: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      })
    }
    fixture.tables.set('events', eventRows)
    await apply(fixture.ctx as never, { exportsRoot: join(root, 'exports') })
    expect(fixture.entriesCalls()).toBe(3)
    const provided = fixture.provided.mock.calls.find(call => call[0] === 'studioIntegrationHub')?.[1] as { service: {
      events(actor: unknown, page: { limit: number; cursor?: string }): { events: unknown[]; next_cursor: string | null }
    } }
    const service = provided.service
    const actor = { userId: 'u1', orgId: 'org-a', tenantId: 'ws-a', role: 'owner' }
    const first = service.events(actor, { limit: 2 })
    const second = service.events(actor, { limit: 2, cursor: first.next_cursor! })
    expect(first.events).toHaveLength(2)
    expect(second.events).toHaveLength(2)
    // Only the constructor snapshot touched KvTable.entries(); both pages came
    // from the scoped, retained index and asked for three rows apiece.
    expect(fixture.entriesCalls()).toBe(3)
  })

  it('keeps adapter indexes scoped, CAS-safe and compatible with legacy physical keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-hub-adapter-'))
    roots.push(root)
    const fixture = fakeContext()
    const timestamp = '2026-09-04T00:00:00.000Z'
    const manifest = {
      schema_version: 1 as const, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill' as const,
      publisher: { id: 'dz23', name: 'DZ23' }, permissions: [] as const,
    }
    const integration: StudioIntegration = {
      integration_id: 'agenda', org_id: 'org-a', tenant_id: 'ws-a', kind: 'skill', name: 'Agenda', manifest,
      effective_tier: 'T0', verification: 'verified', enabled: false, secret_ref: null,
      created_by: 'u1', created_at: timestamp, updated_at: timestamp,
    }
    const exported: StudioExport = {
      export_id: 'export-1', org_id: 'org-a', tenant_id: 'ws-a', project_id: 'project-1', run_id: 'run-1',
      file_name: 'project.zip', path: join(root, 'project.zip'), sha256: 'a'.repeat(64), size_bytes: 1, entries: 1,
      created_by: 'u1', created_at: timestamp,
    }
    const event: HubEvent = {
      event_id: 'event-1', org_id: 'org-a', tenant_id: 'ws-a', actor_user_id: 'u1', action: 'integration.registered',
      subject_id: 'agenda', outcome: 'success', detail: 'seed', created_at: timestamp,
    }
    fixture.tables.set('integrations', new Map([['legacy-integration', integration]]))
    fixture.tables.set('exports', new Map([['legacy-export', exported]]))
    fixture.tables.set('events', new Map([['legacy-event', event]]))
    await apply(fixture.ctx as never, { exportsRoot: join(root, 'exports') })
    const service = fixture.provided.mock.calls.find(call => call[0] === 'studioIntegrationHub')?.[1] as { service: unknown }
    const repository = (service.service as { options: { repository: HubRepository } }).options.repository
    const actor = { userId: 'u1', orgId: 'org-a', tenantId: 'ws-a', role: 'owner' as const }
    const stranger = { ...actor, tenantId: 'ws-b' }

    expect(repository.integrations(actor)).toEqual([integration])
    expect(repository.integrations(stranger)).toEqual([])
    expect(repository.integration(actor, 'agenda')).toEqual(integration)
    expect(repository.integration(actor, 'missing')).toBeUndefined()
    expect(repository.exports(actor, 'project-1')).toEqual([exported])
    expect(repository.exports(stranger, 'project-1')).toEqual([])
    expect(repository.export(actor, 'project-1', 'export-1')).toEqual(exported)
    expect(repository.export(actor, 'project-1', 'missing')).toBeUndefined()
    expect(repository.eventCount(actor)).toBe(1)
    expect(repository.eventCount(stranger)).toBe(0)
    expect(repository.eventPage(actor, undefined, 2)).toEqual([event])
    expect(repository.eventPage(actor, { created_at: '1900-01-01T00:00:00.000Z', event_id: 'missing' }, 2)).toEqual([])

    expect(await repository.compareAndSwapIntegration(actor, 'missing', 'x', integration)).toBe(false)
    expect(await repository.compareAndSwapIntegration(actor, 'agenda', 'x', integration)).toBe(false)
    const enabled = { ...integration, enabled: true, updated_at: '2026-09-04T00:00:01.000Z' }
    expect(await repository.compareAndSwapIntegration(actor, 'agenda', securityFingerprint(integration), enabled)).toBe(true)
    expect(repository.integration(actor, 'agenda')).toEqual(enabled)
    expect(fixture.tables.get('integrations')?.has('legacy-integration')).toBe(false)

    const larger = { ...exported, size_bytes: 2 }
    await repository.putExport(larger)
    expect(repository.export(actor, 'project-1', 'export-1')).toEqual(larger)
    expect(fixture.tables.get('exports')?.has('legacy-export')).toBe(false)

    const amended = { ...event, detail: 'amended' }
    await repository.putEvent(amended)
    expect(repository.eventCount(actor)).toBe(1)
    expect(repository.eventPage(actor, undefined, 2)).toEqual([amended])
    expect(fixture.tables.get('events')?.has('legacy-event')).toBe(false)
    const tied = { ...event, event_id: 'event-2', detail: 'tie' }
    await repository.putEvent(tied)
    expect(repository.eventPage(actor, undefined, 2).map(row => row.event_id)).toEqual(['event-2', 'event-1'])
    expect(await repository.pruneEvents(stranger, 0)).toBe(0)
    expect(await repository.pruneEvents(actor, 1)).toBe(1)
    expect(repository.eventCount(actor)).toBe(1)
  })

  it('refuses to start on the dev channel unless this is a personal, loopback-only Studio', async () => {
    const local = { bindHost: '127.0.0.1:3210', allowedHosts: ['127.0.0.1:3210', 'localhost:3210'], allowedOrigins: ['http://localhost:3210', 'http://127.0.0.1:3210'] }
    // A personal installation: nobody but this machine can reach it, so `dev` means what it says.
    expect(() => assertChannelAllowed('dev', local)).not.toThrow()
    expect(() => assertChannelAllowed('dev', { ...local, bindHost: '[::1]:3210', allowedHosts: ['[::1]:3210'], allowedOrigins: ['http://[::1]:3210'] })).not.toThrow()
    // Anything reachable by somebody else refuses AT BOOT — a Studio that came up and only wrote a
    // line in a log would already be serving other people with a lowered policy.
    for (const shared of [
      { ...local, bindHost: '0.0.0.0:3210' },
      { ...local, allowedHosts: ['127.0.0.1:3210', 'studio.example.com'] },
      { ...local, allowedOrigins: ['http://localhost:3210', 'https://studio.example.com'] },
      { ...local, allowedHosts: [] },
      { ...local, allowedOrigins: [] },
    ]) {
      expect(() => assertChannelAllowed('dev', shared)).toThrow('instalação pessoal')
      // The strict channel is allowed everywhere: this is about `dev`, not about the boundary.
      expect(() => assertChannelAllowed('stable', shared)).not.toThrow()
    }
    // And the plugin itself refuses to come up: no domain served, no service provided.
    const root = await mkdtemp(join(tmpdir(), 'dz23-hub-dev-'))
    roots.push(root)
    const shared = fakeContext('0.0.0.0')
    await expect(apply(shared.ctx as never, { exportsRoot: join(root, 'exports'), channel: 'dev' })).rejects.toThrow('instalação pessoal')
    expect(shared.provided).not.toHaveBeenCalled()
    expect(shared.registered).toEqual([])
    const personal = fakeContext('127.0.0.1')
    await apply(personal.ctx as never, { exportsRoot: join(root, 'exports-2'), channel: 'dev' })
    expect(personal.provided).toHaveBeenCalled()
  })

  it('only an explicit `dev` in the configuration opens the dev channel', () => {
    expect(hubChannel('dev')).toBe('dev')
    expect(hubChannel('stable')).toBe('stable')
    // Anything else — absent, a typo, an environment variable read as a string, an object — is the strict channel.
    for (const value of [undefined, null, '', 'DEV', ' dev', 'development', 1, true, { channel: 'dev' }, ['dev']]) {
      expect(hubChannel(value)).toBe('stable')
    }
  })
})
