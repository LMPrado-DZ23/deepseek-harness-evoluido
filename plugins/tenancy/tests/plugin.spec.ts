import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import type { EnrollmentGrant, IdentityUser, IdentityUserProvisioningSource } from '@dz23-studio/identity'
import type { PolicyAuthorizationState } from '@dz23-studio/policy'
import { apply, type StudioTenancyRuntime } from '../src/index.ts'
import {
  STUDIO_MEMBERSHIPS_PHYSICAL_DOMAIN,
  STUDIO_ORGS_PHYSICAL_DOMAIN,
  STUDIO_WORKSPACES_PHYSICAL_DOMAIN,
} from '../src/model.ts'

function table() {
  const records = new Map<string, unknown>()
  return {
    records,
    api: {
      entries: () => records.entries(),
      get: (key: string) => records.get(key),
      put: vi.fn((key: string, value: unknown) => { records.set(key, value); return Promise.resolve() }),
    },
  }
}

const owner: IdentityUser = {
  user_id: 'owner', email: 'owner@example.com', display_name: 'Owner', bootstrap_owner: true,
  org_id: 'org-a', tenant_id: 'workspace-a', created_at: '2026-09-02T12:00:00.000Z',
}

function context(users: readonly IdentityUser[] = [owner]) {
  const orgs = table()
  const workspaces = table()
  const memberships = table()
  const invitations = table()
  const closes = [vi.fn(() => Promise.resolve()), vi.fn(() => Promise.resolve()), vi.fn(() => Promise.resolve())]
  const domains = [
    { table: vi.fn(() => orgs.api), close: closes[0] },
    { table: vi.fn(() => workspaces.api), close: closes[1] },
    { table: vi.fn((name: string) => name === 'memberships' ? memberships.api : invitations.api), close: closes[2] },
  ]
  let opened = 0
  let route: WebRoute | undefined
  let enrollmentResolver: ((email: string) => EnrollmentGrant | undefined) | undefined
  let provisioner: ((user: IdentityUser, source: IdentityUserProvisioningSource) => Promise<void>) | undefined
  let authorizationResolver: ((execution: { readonly agent?: { readonly session: { readonly id: unknown } } }) => PolicyAuthorizationState | undefined) | undefined
  const cleanup: Array<() => void | Promise<void>> = []
  const provided: { tenancy?: StudioTenancyRuntime } = {}
  const sendInvitation = vi.fn(() => Promise.resolve())
  const principalForHarnessSession = vi.fn((id: string) => id === 'agent-1'
    ? { userId: owner.user_id, orgId: owner.org_id, tenantId: owner.tenant_id, sessionId: 'session-1' }
    : undefined)
  const ctx = {
    agents: { get: vi.fn(() => undefined) },
    storageDomain: { open: vi.fn((_spec: { readonly name: string }) => Promise.resolve(domains[opened++]!)) },
    webServer: { host: '127.0.0.1', port: 4321, register: vi.fn((candidate: WebRoute) => { route = candidate; return vi.fn() }) },
    studioIdentity: { service: {
      userRecords: vi.fn(() => users),
      setEnrollmentResolver: vi.fn((resolver: typeof enrollmentResolver) => { enrollmentResolver = resolver; return vi.fn() }),
      setUserProvisioner: vi.fn((resolver: typeof provisioner) => { provisioner = resolver; return vi.fn() }),
      principalForHarnessSession,
      sendInvitation,
      recordAdministrationEvent: vi.fn(() => Promise.resolve()),
      userForSession: vi.fn(() => owner),
    } },
    studioPolicy: {
      setAuthorizationResolver: vi.fn((resolver: typeof authorizationResolver) => { authorizationResolver = resolver; return vi.fn() }),
    },
    effect: vi.fn((factory: () => () => void | Promise<void>) => { cleanup.push(factory()) }),
    provide: vi.fn((_name: string, runtime: StudioTenancyRuntime) => { provided.tenancy = runtime }),
  }
  return {
    ctx, orgs, workspaces, memberships, invitations, closes, cleanup, provided, sendInvitation,
    route: () => route,
    enrollmentResolver: () => enrollmentResolver,
    provisioner: () => provisioner,
    authorizationResolver: () => authorizationResolver,
  }
}

describe('tenancy Cordis plugin composition', () => {
  it('opens canonical domains, bootstraps the owner and wires identity and policy', async () => {
    const f = context()
    let id = 0
    await apply(f.ctx as never, {
      allowedHosts: ['studio.test'],
      allowedOrigins: ['https://studio.test'],
      now: () => new Date('2026-09-02T12:00:00.000Z'),
      createId: () => `id-${++id}`,
      createSecret: () => `invitation-secret-${id}`,
    })
    expect(f.ctx.storageDomain.open.mock.calls.map(call => call[0].name)).toEqual([
      STUDIO_ORGS_PHYSICAL_DOMAIN, STUDIO_WORKSPACES_PHYSICAL_DOMAIN, STUDIO_MEMBERSHIPS_PHYSICAL_DOMAIN,
    ])
    expect(f.orgs.records.size).toBe(1)
    expect(f.workspaces.records.size).toBe(1)
    expect(f.memberships.records.size).toBe(1)
    expect(f.route()).toMatchObject({ kind: 'prefix', path: '/api/studio/tenancy' })
    expect(f.provided.tenancy).toBeDefined()
    expect(f.authorizationResolver()?.({ agent: { session: { id: 'agent-1' } } } as never)).toMatchObject({ role: 'owner' })
    expect(f.authorizationResolver()?.({} as never)).toBeUndefined()
    expect(f.authorizationResolver()?.({ agent: { session: { id: 'missing' } } } as never)).toBeUndefined()

    const invited = await f.provided.tenancy!.service.invite(
      { userId: 'owner', email: owner.email, orgId: 'org-a', tenantId: 'workspace-a' },
      'workspace-a', 'new@example.com', 'viewer',
    )
    expect(f.invitations.records.size).toBe(1)
    expect(f.enrollmentResolver()?.('new@example.com')).toMatchObject({ role: 'viewer' })
    expect(f.sendInvitation).toHaveBeenCalledWith(expect.objectContaining({ token: invited.token }))
    await f.provisioner()?.({ ...owner, user_id: 'owner-2', org_id: 'org-b', tenant_id: 'workspace-b' }, 'bootstrap')
    await f.provisioner()?.({ ...owner, user_id: 'invited' }, 'invitation')

    for (const dispose of f.cleanup.reverse()) await dispose()
    for (const close of f.closes) expect(close).toHaveBeenCalledOnce()
  })

  it('supports an empty persisted store and safe loopback defaults', async () => {
    const f = context([])
    await apply(f.ctx as never)
    expect(f.orgs.records.size).toBe(0)
    expect(f.route()).toBeDefined()
  })
})
