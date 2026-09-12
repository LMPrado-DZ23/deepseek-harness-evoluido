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
    validateCsrfToken: vi.fn(),
    cookiesAreSecure: false,
    userForSession: vi.fn(() => ({ user_id: 'owner', email: 'owner@example.com' })),
    assertRequestTrust: vi.fn(),
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
    // `validateCsrf` (duplo envio) foi REMOVIDA do serviço de identidade: o
    // cookie que ela exigia não é mais emitido. Leitura continua sem CSRF.
    expect(f.identity.validateCsrfToken).not.toHaveBeenCalled()
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

describe('ACHADO: erro inesperado não devolve a mensagem interna ao navegador', () => {
  it('falha do armazenamento vira frase de catálogo, e o caminho do servidor não sai', async () => {
    // Qualquer erro não previsto caía no ramo `400` com `error.message`
    // repassado ao cliente. Uma falha de `putMembership` vinda do disco carrega
    // CAMINHO DE ARQUIVO do servidor; um `ZodError` carrega o JSON das issues.
    // O plugin vizinho já defendia isso de propósito; esta rota tinha ficado
    // de fora.
    const f = await fixture()
    f.tenancy.createWorkspace.mockRejectedValueOnce(
      new Error('ENOENT: no such file or directory, open \'/var/lib/dz23/instances/org-a/memberships.json\''),
    )
    const response = await f.request('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Produto' }) })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).not.toContain('/var/lib/dz23')
    expect(body.error).not.toContain('ENOENT')
    expect(body.error).toBe('Solicitação inválida.')
  })

  it('erro NOSSO continua chegando inteiro: ele é que ajuda a pessoa', async () => {
    // Filtrar demais seria trocar um vazamento por uma tela que não explica
    // nada. `TenancyError` e `IdentityError` já falam a língua da pessoa.
    const f = await fixture()
    const { TenancyError } = await import('../src/service.ts')
    f.tenancy.createWorkspace.mockRejectedValueOnce(new TenancyError('forbidden', 'Seu papel não pode criar espaços.'))
    const response = await f.request('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Produto' }) })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Seu papel não pode criar espaços.' })
  })
})
