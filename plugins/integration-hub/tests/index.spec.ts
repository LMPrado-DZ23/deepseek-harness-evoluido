import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, assertChannelAllowed, credentialInspector, inject, name, smtpTestPort, hubChannel } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function credentials(values: Record<string, string>) {
  return { resolve: vi.fn(async (ref: string) => values[ref] === undefined ? undefined : { value: values[ref]!, source: 'env' as const }) }
}

/** The pieces of a Cordis context this plugin actually touches, with the bind host under the test's control. */
function fakeContext(bindHost = '127.0.0.1') {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (tableName: string) => {
      const rows = tables.get(tableName) ?? new Map<string, unknown>()
      tables.set(tableName, rows)
      return {
        entries: () => rows.entries(),
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
  return { ctx, registered, provided, disposers, domain }
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
