import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import type { EmailSender } from '../src/email.ts'
import { apply, type StudioIdentityRuntime } from '../src/index.ts'
import type { PasskeyProvider, RegistrationOptions, AuthenticationOptions } from '../src/passkey.ts'
import type { StudioPolicyRuntime } from '../../policy/src/index.ts'

function table() {
  const records = new Map<string, unknown>()
  return {
    records,
    table: {
      entries: () => records.entries(),
      get: (key: string) => records.get(key),
      put: vi.fn((key: string, value: unknown) => { records.set(key, value); return Promise.resolve() }),
    },
  }
}

function context(host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1') {
  const tables = Object.fromEntries([
    'users', 'magic_codes', 'credentials', 'challenges', 'sessions', 'events',
  ].map(name => [name, table()]))
  const close = vi.fn(() => Promise.resolve())
  const domain = (names: string[]) => ({
    table: vi.fn((name: string) => tables[name]!.table),
    close,
    names,
  })
  const domains = [domain(['users', 'magic_codes']), domain(['credentials', 'challenges']), domain(['sessions']), domain(['events'])]
  let opened = 0
  const cleanups: Array<() => void | Promise<void>> = []
  const provided: { identity?: StudioIdentityRuntime } = {}
  let route: WebRoute | undefined
  let strongResolver: ((execution: never) => { authenticated: boolean; strongIdentityVerified: boolean }) | undefined
  const routeDispose = vi.fn()
  const resolverDispose = vi.fn()
  const ctx = {
    storageDomain: { open: vi.fn(() => Promise.resolve(domains[opened++]!)) },
    webServer: {
      host,
      port: 4321,
      register: vi.fn((candidate: WebRoute) => { route = candidate; return routeDispose }),
    },
    credentials: { resolve: vi.fn() } as unknown as CredentialProvider,
    studioPolicy: {
      auditRecords: () => [],
      setIdentityResolver: vi.fn((resolver: (execution: never) => { authenticated: boolean; strongIdentityVerified: boolean }) => {
        strongResolver = resolver
        return resolverDispose
      }),
      setAuthorizationResolver: vi.fn(() => vi.fn()),
    } satisfies StudioPolicyRuntime,
    effect: vi.fn((factory: () => () => void | Promise<void>) => { cleanups.push(factory()) }),
    provide: vi.fn((_name: string, runtime: StudioIdentityRuntime) => { provided.identity = runtime }),
  }
  return { ctx, tables, close, cleanups, provided, getRoute: () => route, getResolver: () => strongResolver, routeDispose, resolverDispose }
}

const passkeys: PasskeyProvider = {
  registrationOptions: () => Promise.resolve({ challenge: 'r' } as RegistrationOptions),
  verifyRegistration: () => Promise.resolve({
    id: 'credential-1', publicKey: Uint8Array.from([1]), counter: 0, transports: ['internal'],
  }),
  authenticationOptions: () => Promise.resolve({ challenge: 'a' } as AuthenticationOptions),
  verifyAuthentication: () => Promise.reject(new Error('unused')),
}

describe('identity Cordis plugin composition', () => {
  it('opens the four owned domains, registers the route, and links strong identity to policy', async () => {
    const f = context()
    let id = 0
    let secret = 0
    await apply(f.ctx as never, {
      passkeys,
      now: () => new Date('2026-09-02T12:00:00.000Z'),
      createId: () => `id-${++id}`,
      createSecret: () => `secret-${++secret}`,
      createMagicCode: () => '123456',
    })
    expect(f.ctx.storageDomain.open).toHaveBeenCalledTimes(4)
    expect(f.ctx.provide).toHaveBeenCalledWith('studioIdentity', expect.objectContaining({
      service: expect.anything(), developmentEmailCapture: expect.anything(),
    }))
    expect(f.getRoute()).toMatchObject({ kind: 'prefix', path: '/api/studio/identity' })
    const runtime = f.provided.identity!
    await runtime.service.requestMagicCode('owner@example.com')
    const code = runtime.developmentEmailCapture!.messages[0]!.code
    const issued = await runtime.service.verifyMagicCode('owner@example.com', code, {
      label: 'Notebook', userAgent: 'Vitest', ipTruncated: '127.0.0.0/24',
    })
    const registration = await runtime.service.beginPasskeyRegistration(issued.token)
    await runtime.service.finishPasskeyRegistration(issued.token, registration.challengeId, {} as never, 'Windows Hello')
    await runtime.service.bindHarnessSession(issued.session, 'agent-1')
    expect(f.getResolver()?.({ agent: { session: { id: 'agent-1' } } } as never)).toEqual({ authenticated: true, strongIdentityVerified: false })
    expect(f.getResolver()?.({} as never)).toEqual({ authenticated: false, strongIdentityVerified: false })
    expect(runtime.service.auditRecords().length).toBeGreaterThan(0)
    expect(runtime.service.sessionRecords()).toHaveLength(1)
    await Promise.all(f.cleanups.map(cleanup => cleanup()))
    expect(f.close).toHaveBeenCalledTimes(4)
    expect(f.routeDispose).toHaveBeenCalledOnce()
    expect(f.resolverDispose).toHaveBeenCalledOnce()
  })

  it('accepts an explicitly injected sender without exposing a development capture', async () => {
    const f = context('0.0.0.0')
    const sender: EmailSender = {
      sendMagicCode: vi.fn(() => Promise.resolve()),
      sendInvitation: vi.fn(() => Promise.resolve()),
    }
    await apply(f.ctx as never, {
      emailSender: sender,
      rpName: 'Custom Studio',
      rpId: 'studio.example',
      expectedOrigin: 'https://studio.example',
      allowedHosts: ['studio.example'],
      allowedOrigins: ['https://studio.example'],
    })
    expect(f.provided.identity).not.toHaveProperty('developmentEmailCapture')
    await expect(f.provided.identity!.service.requestMagicCode('unknown@example.com')).resolves.toBe('suppressed')
    expect(sender.sendMagicCode).not.toHaveBeenCalled()
  })

  it('constructs SMTP only from a credential reference and rejects memory email on a server bind', async () => {
    const smtp = context()
    await apply(smtp.ctx as never, { passkeys, email: { kind: 'smtp', secretRef: 'DZ23_SMTP' } })
    expect(smtp.provided.identity).not.toHaveProperty('developmentEmailCapture')
    const remote = context('0.0.0.0')
    await expect(apply(remote.ctx as never, { passkeys })).rejects.toThrow(/SMTP/)
  })

  it('uses localhost as the default WebAuthn RP and rejects IP RP identifiers before opening storage', async () => {
    const local = context()
    await apply(local.ctx as never, { passkeys, enrollment: 'closed' })
    await expect(local.provided.identity!.service.requestMagicCode('unknown@example.com')).resolves.toBe('suppressed')
    const invalid = context()
    await expect(apply(invalid.ctx as never, { passkeys, rpId: '127.0.0.1' })).rejects.toThrow(/nunca um endereço IP/)
    expect(invalid.ctx.storageDomain.open).not.toHaveBeenCalled()
  })
})
