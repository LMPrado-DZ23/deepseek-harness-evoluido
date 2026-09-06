import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import type { EmailSender } from '../src/email.ts'
import { apply, SESSION_COOKIE, type StudioIdentityRuntime } from '../src/index.ts'
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
  const agents = new Map<string, unknown>()
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
    agents: { get: vi.fn((id: string) => agents.get(String(id))) },
    storageDomain: { open: vi.fn(() => Promise.resolve(domains[opened++]!)) },
    webServer: {
      host,
      port: 4321,
      register: vi.fn((candidate: WebRoute) => { route = candidate; return routeDispose }),
    },
    credentials: { resolve: vi.fn(() => Promise.resolve({ value: 'edge-secret', source: 'test' })) } as unknown as CredentialProvider,
    studioPolicy: {
      auditRecords: () => [],
      setIdentityResolver: vi.fn((resolver: (execution: never) => { authenticated: boolean; strongIdentityVerified: boolean }) => {
        strongResolver = resolver
        return resolverDispose
      }),
      setAuthorizationResolver: vi.fn(() => vi.fn()),
      setDelegationGrantResolver: vi.fn(() => vi.fn()),
    } satisfies StudioPolicyRuntime,
    effect: vi.fn((factory: () => () => void | Promise<void>) => { cleanups.push(factory()) }),
    inject: vi.fn((_dependencies: string[], callback: (injected: { connection: { authenticatedUrl: (baseUrl: string) => string } }) => () => void) => {
      const cleanup = callback({ connection: { authenticatedUrl: baseUrl => `${baseUrl}?token=harness` } })
      cleanups.push(cleanup)
    }),
    provide: vi.fn((_name: string, runtime: StudioIdentityRuntime) => { provided.identity = runtime }),
  }
  return { ctx, agents, tables, close, cleanups, provided, getRoute: () => route, getResolver: () => strongResolver, routeDispose, resolverDispose }
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
    const parent = { session: { id: 'agent-1', header: {} } }
    const coordinator = { session: { id: 'coordinator', header: { parentSession: 'agent-1' } } }
    const child = { session: { id: 'child', header: { parentSession: 'coordinator' } } }
    f.agents.set('agent-1', parent)
    f.agents.set('coordinator', coordinator)
    expect(f.getResolver()?.({ agent: child } as never)).toEqual({ authenticated: true, strongIdentityVerified: false })
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
      edge: { secretRef: 'DZ23_EDGE_SECRET' },
      email: { kind: 'memory' },
    })
    expect(f.provided.identity).not.toHaveProperty('developmentEmailCapture')
    await expect(f.provided.identity!.service.requestMagicCode('unknown@example.com')).resolves.toBe('suppressed')
    expect(sender.sendMagicCode).not.toHaveBeenCalled()

    const owner = context('0.0.0.0')
    const captured: string[] = []
    await apply(owner.ctx as never, {
      emailSender: {
        sendMagicCode: message => { captured.push(message.code); return Promise.resolve() },
        sendInvitation: () => Promise.resolve(),
      },
      enrollment: { mode: 'bootstrap-email', email: ' Owner@Example.com ' },
      edge: { secretRef: 'DZ23_EDGE_SECRET' },
      email: { kind: 'memory' },
      allowedHosts: ['studio.example'],
      allowedOrigins: ['https://studio.example'],
    })
    expect(owner.provided.identity!.service.identityStateForHarnessSession('unbound', '127.0.0.1')).toEqual({
      authenticated: false,
      strongIdentityVerified: false,
    })
    await expect(owner.provided.identity!.service.requestMagicCode('competitor@example.com')).resolves.toBe('suppressed')
    expect(captured).toHaveLength(0)
    await owner.provided.identity!.service.requestMagicCode('owner@example.com')
    const ownerIssued = await owner.provided.identity!.service.verifyMagicCode('owner@example.com', captured[0]!, {
      label: 'Test', userAgent: 'Vitest', ipTruncated: '127.0.0.0/24',
    })
    const result = { status: 0, headers: {} as Record<string, string> }
    await owner.getRoute()!.handler({
      method: 'GET',
      url: '/api/studio/identity/harness/session',
      headers: {
        host: 'studio.example',
        cookie: `${SESSION_COOKIE}=${ownerIssued.token}`,
        'x-dz23-edge': 'edge-secret',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as never, {
      writableEnded: false,
      setHeader: () => undefined,
      writeHead: (status: number, headers: Record<string, string>) => { result.status = status; result.headers = headers },
      end: () => undefined,
    } as never)
    expect(result).toEqual({
      status: 403,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    })
  })

  it('constructs SMTP only from a credential reference and rejects memory email on a server bind', async () => {
    const smtp = context()
    await apply(smtp.ctx as never, { passkeys, email: { kind: 'smtp', secretRef: 'DZ23_SMTP' } })
    expect(smtp.provided.identity).not.toHaveProperty('developmentEmailCapture')
    const disabled = context('0.0.0.0')
    await expect(apply(disabled.ctx as never, { passkeys, edge: { required: false } })).rejects.toThrow(/desativar/)
    const noEdgeSecret = context('0.0.0.0')
    await expect(apply(noEdgeSecret.ctx as never, { passkeys })).rejects.toThrow(/edge.secretRef/)
    const remote = context('0.0.0.0')
    await expect(apply(remote.ctx as never, { passkeys, edge: { secretRef: 'DZ23_EDGE_SECRET' } })).rejects.toThrow(/SMTP/)
    const loopbackEdge = context()
    await expect(apply(loopbackEdge.ctx as never, {
      passkeys, edge: { required: true, secretRef: 'DZ23_EDGE_SECRET' },
    })).rejects.toThrow(/SMTP/)
    const unsafeEnrollment = context()
    await expect(apply(unsafeEnrollment.ctx as never, {
      passkeys,
      edge: { required: true, secretRef: 'DZ23_EDGE_SECRET' },
      enrollment: 'open',
      email: { kind: 'memory' },
    })).rejects.toThrow(/proíbe enrollment aberto/)
    expect(unsafeEnrollment.ctx.storageDomain.open).not.toHaveBeenCalled()
    const explicitLocalMemory = context()
    await apply(explicitLocalMemory.ctx as never, {
      passkeys,
      edge: { required: true, secretRef: 'DZ23_EDGE_SECRET' },
      email: { kind: 'memory' },
    })
    expect(explicitLocalMemory.provided.identity).toHaveProperty('developmentEmailCapture')
    const remoteMemory = context('0.0.0.0')
    await expect(apply(remoteMemory.ctx as never, {
      passkeys,
      edge: { secretRef: 'DZ23_EDGE_SECRET' },
      email: { kind: 'memory' },
    })).rejects.toThrow(/SMTP/)
  })

  it('uses localhost as the default WebAuthn RP and rejects IP RP identifiers before opening storage', async () => {
    const local = context()
    await apply(local.ctx as never, { passkeys, enrollment: 'closed' })
    await expect(local.provided.identity!.service.requestMagicCode('unknown@example.com')).resolves.toBe('suppressed')
    const invalid = context()
    await expect(apply(invalid.ctx as never, { passkeys, rpId: '127.0.0.1' })).rejects.toThrow(/nunca um endereço IP/)
    expect(invalid.ctx.storageDomain.open).not.toHaveBeenCalled()
  })

  it('allows non-Secure cookies only on an explicit loopback HTTP origin', async () => {
    const local = context()
    await expect(apply(local.ctx as never, {
      passkeys,
      edge: { required: true, secretRef: 'DZ23_EDGE_SECRET' },
      email: { kind: 'memory' },
      enrollment: 'closed',
      cookieSecurity: 'loopback-http',
      allowedHosts: ['studio.dz23.localhost:4321'],
      allowedOrigins: ['http://studio.dz23.localhost:4321'],
    })).resolves.toBeUndefined()

    const publicBind = context('0.0.0.0')
    await expect(apply(publicBind.ctx as never, {
      passkeys,
      edge: { secretRef: 'DZ23_EDGE_SECRET' },
      emailSender: { sendMagicCode: vi.fn(), sendInvitation: vi.fn() },
      cookieSecurity: 'loopback-http',
      allowedHosts: ['studio.example'],
      allowedOrigins: ['http://studio.example'],
    })).rejects.toThrow(/loopback-http exige/)
    expect(publicBind.ctx.storageDomain.open).not.toHaveBeenCalled()

    const malformed = context()
    await expect(apply(malformed.ctx as never, {
      passkeys,
      cookieSecurity: 'loopback-http',
      allowedHosts: ['['],
      allowedOrigins: ['http://localhost:4321'],
    })).rejects.toThrow(/loopback-http exige/)
    expect(malformed.ctx.storageDomain.open).not.toHaveBeenCalled()
  })
})
