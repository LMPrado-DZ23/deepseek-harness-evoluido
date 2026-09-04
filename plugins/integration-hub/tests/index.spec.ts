import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, credentialInspector, inject, name, smtpTestPort, hubChannel } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function credentials(values: Record<string, string>) {
  return { resolve: vi.fn(async (ref: string) => values[ref] === undefined ? undefined : { value: values[ref]!, source: 'env' as const }) }
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
    const tables = new Map<string, Map<string, unknown>>()
    const domain = {
      table: (tableName: string) => {
        const rows = tables.get(tableName) ?? new Map<string, unknown>()
        tables.set(tableName, rows)
        return { entries: () => rows.entries(), put: async (key: string, value: unknown) => { rows.set(key, value) } }
      },
      close: vi.fn(async () => undefined),
    }
    const registered: Array<{ kind: string; path: string }> = []
    const provided = vi.fn()
    const disposers: Array<() => unknown> = []
    const ctx = {
      storageDomain: { open: vi.fn(async () => domain) },
      credentials: credentials({}),
      webServer: { port: 3210, register: vi.fn((spec: { kind: string; path: string }) => { registered.push(spec); return () => undefined }) },
      studioIdentity: { service: {} }, studioTenancy: { service: {} },
      studioPromptToApp: { service: { project: vi.fn(), runs: vi.fn(() => []) } },
      provide: provided,
      effect: (factory: () => () => unknown) => { disposers.push(factory()) },
    }
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

  it('only an explicit `dev` in the configuration opens the dev channel', () => {
    expect(hubChannel('dev')).toBe('dev')
    expect(hubChannel('stable')).toBe('stable')
    // Anything else — absent, a typo, an environment variable read as a string, an object — is the strict channel.
    for (const value of [undefined, null, '', 'DEV', ' dev', 'development', 1, true, { channel: 'dev' }, ['dev']]) {
      expect(hubChannel(value)).toBe('stable')
    }
  })
})
