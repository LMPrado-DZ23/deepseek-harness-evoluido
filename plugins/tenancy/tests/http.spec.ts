import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import { authorizeRoute, createTenancyHttpHandler, TENANCY_ROUTE_CONTRACTS } from '../src/http.ts'
import { TenancyError, type StudioTenancyService } from '../src/service.ts'

const session = {
  session_id: 'session-1', user_id: 'owner', org_id: 'org-a', tenant_id: 'workspace-a',
} as SessionRecord

function services() {
  const actor = { userId: 'owner', email: 'owner@example.com', orgId: 'org-a', tenantId: 'workspace-a' }
  const identity = {
    authenticate: vi.fn(() => Promise.resolve(session)),
    validateCsrf: vi.fn(),
    validateCsrfToken: vi.fn(),
    userForSession: vi.fn(() => ({ user_id: 'owner', email: 'owner@example.com' })),
  }
  const tenancy = {
    actorFromSession: vi.fn(() => actor),
    listWorkspaces: vi.fn(() => [{ workspace_id: 'workspace-a' }]),
    createWorkspace: vi.fn(() => Promise.resolve({ workspace_id: 'workspace-new', name: 'Produto' })),
    listMembers: vi.fn(() => [{ membership_id: 'member-1' }]),
    invite: vi.fn(() => Promise.resolve({ invitation: { invitation_id: 'invite-1' }, token: 'not-returned' })),
    acceptInvitation: vi.fn(() => Promise.resolve({ membership_id: 'accepted-1' })),
    changeRole: vi.fn(() => Promise.resolve({ membership_id: 'member-1', role: 'viewer' })),
  }
  return { identity, tenancy }
}

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))))

async function fixture() {
  const f = services()
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const server = createServer(createTenancyHttpHandler({
    identity: f.identity as unknown as StudioIdentityService,
    service: f.tenancy as unknown as StudioTenancyService,
    allowedHosts,
    allowedOrigins,
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  allowedHosts.push(host)
  allowedOrigins.push(origin)
  const headers = {
    host,
    origin,
    'content-type': 'application/json',
    cookie: `${SESSION_COOKIE}=session-token; ${CSRF_COOKIE}=csrf-token`,
    'x-dz23-csrf': 'csrf-token',
  }
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/tenancy${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  })
  return { ...f, request, allowedHosts, host }
}

describe('tenancy HTTP boundary', () => {
  it('declares every route and enforces role permissions independently', () => {
    expect(TENANCY_ROUTE_CONTRACTS).toHaveLength(6)
    expect(() => authorizeRoute('owner', 'members.manage')).not.toThrow()
    expect(() => authorizeRoute('viewer', 'members.manage')).toThrow(/não permite/)
  })

  it('serves workspace and member reads', async () => {
    const f = await fixture()
    expect((await f.request('/workspaces')).status).toBe(200)
    const members = await f.request('/workspaces/workspace-a/members')
    expect(members.status).toBe(200)
    expect(f.tenancy.listMembers).toHaveBeenCalledWith(expect.anything(), 'workspace-a')
    expect(f.identity.validateCsrf).not.toHaveBeenCalled()
  })

  it('creates workspaces and invitations without accepting scope from headers', async () => {
    const f = await fixture()
    const workspace = await f.request('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Produto' }) })
    expect(workspace.status).toBe(201)
    const invitation = await f.request('/invitations', {
      method: 'POST', body: JSON.stringify({ workspace_id: 'workspace-a', email: 'new@example.com', role: 'builder' }),
    })
    expect(invitation.status).toBe(202)
    expect(await invitation.json()).toEqual({ invitation_id: 'invite-1' })
    expect(f.tenancy.invite).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-a' }), 'workspace-a', 'new@example.com', 'builder')
  })

  it('accepts an invitation only as the authenticated identity and changes roles', async () => {
    const f = await fixture()
    const accepted = await f.request('/invitations/accept', {
      method: 'POST', body: JSON.stringify({ token: 'a'.repeat(20) }),
    })
    expect(accepted.status).toBe(200)
    expect(f.tenancy.acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'owner' }), 'a'.repeat(20))
    const changed = await f.request('/memberships/member-1', {
      method: 'PATCH', body: JSON.stringify({ role: 'viewer' }),
    })
    expect(changed.status).toBe(200)
    expect(f.tenancy.changeRole).toHaveBeenCalledWith(expect.anything(), 'member-1', 'viewer')
  })

  it('rejects missing sessions, CSRF failures, hostile hosts and unknown routes', async () => {
    const f = await fixture()
    expect((await f.request('/workspaces', { headers: { cookie: '' } })).status).toBe(401)
    f.identity.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
    expect((await f.request('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Produto' }) })).status).toBe(401)
    f.allowedHosts.splice(0)
    expect((await f.request('/workspaces')).status).toBe(401)
    f.allowedHosts.push(f.host)
    expect((await f.request('/missing')).status).toBe(404)
    expect((await f.request('/workspaces//members')).status).toBe(404)
  })

  it('contains invalid content, oversized bodies and non-Error failures', async () => {
    const f = await fixture()
    expect((await f.request('/workspaces', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await f.request('/workspaces', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })).status).toBe(400)
    expect((await f.request('/workspaces', {
      method: 'POST', body: JSON.stringify({ name: 'x'.repeat(70_000) }),
    })).status).toBe(400)
    f.tenancy.listWorkspaces.mockImplementationOnce(() => { throw 'failure' })
    expect(await (await f.request('/workspaces')).json()).toEqual({ error: 'Solicitação inválida.' })
  })

  it('maps tenancy failures without exposing records', async () => {
    const f = await fixture()
    for (const [error, expected] of [
      [new TenancyError('not-found', 'missing'), 404],
      [new TenancyError('forbidden', 'denied'), 403],
      [new TenancyError('last-owner', 'owner'), 403],
      [new TenancyError('expired', 'expired'), 400],
    ] as const) {
      f.tenancy.listWorkspaces.mockImplementationOnce(() => { throw error })
      expect((await f.request('/workspaces')).status).toBe(expected)
    }
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('locked', 'locked'))
    expect((await f.request('/workspaces')).status).toBe(429)
  })

  it('handles non-buffer request chunks and an already-ended response defensively', async () => {
    const f = services()
    const handler = createTenancyHttpHandler({
      identity: f.identity as unknown as StudioIdentityService,
      service: f.tenancy as unknown as StudioTenancyService,
      allowedHosts: ['studio.test'],
      allowedOrigins: ['https://studio.test'],
    })
    const request = {
      url: '/api/studio/tenancy/workspaces',
      method: 'POST',
      headers: {
        host: 'studio.test', origin: 'https://studio.test', 'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=session-token; ${CSRF_COOKIE}=csrf-token`, 'x-dz23-csrf': 'csrf-token',
      },
      async *[Symbol.asyncIterator]() { yield '{"name":"Produto"}' },
    } as unknown as IncomingMessage
    const response = {
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse
    await handler(request, response)
    expect(f.tenancy.createWorkspace).toHaveBeenCalledWith(expect.anything(), 'Produto')

    const ended = { writableEnded: true, writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
    await handler({ ...request, url: undefined, method: 'GET' } as unknown as IncomingMessage, ended)
    expect(ended.writeHead).not.toHaveBeenCalled()
  })
})
