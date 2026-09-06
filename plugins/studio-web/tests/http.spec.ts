import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityError, SESSION_COOKIE, type StudioIdentityService } from '@dz23-studio/identity'
import { AssistantSessionLaunchError, apply, createStudioWebHandler } from '../src/index.js'

const servers: ReturnType<typeof createServer>[] = []; const temporary: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(previewFrameSources: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-web-')); temporary.push(root)
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'index.html'), '<main>DZ23 STUDIO</main>'); await writeFile(join(root, 'assets/app.js'), 'ok')
  const identity = {
    authenticate: vi.fn(() => Promise.resolve({ session_id: 'session' })),
    validateCsrfToken: vi.fn(),
  }
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const assistantSessions = { launch: vi.fn(async () => ({ session_id: 'assistant-1', reused: false, preset: 'dz23-assistant' as const })) }
  const server = createServer(createStudioWebHandler({
    distDirectory: root, identity: identity as unknown as StudioIdentityService, allowedHosts, allowedOrigins,
    previewFrameSources, assistantSessions,
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; allowedHosts.push(host)
  allowedOrigins.push(`http://${host}`)
  const request = (path: string, init: RequestInit = {}) => fetch(`http://${host}/studio${path}`, {
    ...init, headers: { host, cookie: `${SESSION_COOKIE}=token`, ...(init.headers ?? {}) },
  })
  return { request, identity, allowedHosts, allowedOrigins, assistantSessions, host, root }
}

describe('authenticated Studio web surface', () => {
  it('serves the SPA and assets only after authenticating the session', async () => {
    const f = await fixture()
    expect(await (await f.request('/')).text()).toContain('DZ23 STUDIO')
    const asset = await f.request('/assets/app.js'); expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toContain('javascript')
    expect(await (await f.request('/projects/one')).text()).toContain('DZ23 STUDIO')
    expect(f.identity.authenticate).toHaveBeenCalledTimes(3)
  })

  it('sets a restrictive browser policy and supports HEAD without a body', async () => {
    const f = await fixture(['http://*.dz23.localhost:4179']); const response = await f.request('/', { method: 'HEAD' })
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(response.status).toBe(200); expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain('frame-src http://*.dz23.localhost:4179')
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('frame-src *;')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(await response.text()).toBe('')
  })

  it('fails at startup for broad or injectable preview frame sources', () => {
    const input = { distDirectory: '.', identity: {} as StudioIdentityService, allowedHosts: [], allowedOrigins: [] }
    expect(() => createStudioWebHandler({ ...input, previewFrameSources: ['*'] })).toThrow('previewFrameSources')
    expect(() => createStudioWebHandler({ ...input, previewFrameSources: ['http://*.dz23.localhost:4179; script-src *'] })).toThrow('previewFrameSources')
    expect(() => createStudioWebHandler({ ...input, previewFrameSources: ['https://*.example.com'] })).toThrow('previewFrameSources')
  })

  it('fails closed for missing sessions, hostile hosts, traversal, missing assets and mutations', async () => {
    const f = await fixture()
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'Entre'))
    expect((await f.request('/')).status).toBe(401)
    f.allowedHosts.splice(0); expect((await f.request('/')).status).toBe(401); f.allowedHosts.push(f.host)
    expect((await f.request('/%2e%2e/secret')).status).toBe(400)
    expect((await f.request('/assets/missing.js')).status).toBe(404)
    expect((await f.request('/', { method: 'POST' })).status).toBe(401)
  })

  it('creates a governed Assistant Session only through authenticated same-origin POST', async () => {
    const f = await fixture()
    const response = await f.request('/assistant/session', {
      method: 'POST', body: '{}', headers: { origin: `http://${f.host}`, 'x-dz23-csrf': 'csrf' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session_id: 'assistant-1', reused: false, preset: 'dz23-assistant' })
    expect(f.assistantSessions.launch).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'session' }))
    expect((await f.request('/assistant/session')).status).toBe(405)
    expect((await f.request('/assistant/session', { method: 'POST', body: '{}', headers: { 'x-dz23-csrf': 'csrf' } })).status).toBe(401)
  })

  it('reports launcher policy failures as JSON and fails closed when the launcher is absent', async () => {
    const f = await fixture()
    f.assistantSessions.launch.mockRejectedValueOnce(new AssistantSessionLaunchError('FORBIDDEN', 'Projeto não liberado.'))
    const denied = await f.request('/assistant/session', {
      method: 'POST', body: '{}', headers: { origin: `http://${f.host}`, 'x-dz23-csrf': 'csrf' },
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Projeto não liberado.' })

    f.assistantSessions.launch.mockRejectedValueOnce(Object.assign(new Error('Projeto não liberado.'), {
      code: 'FORBIDDEN', name: 'AssistantSessionLaunchError',
    }))
    // A lookalike error is not trusted as a policy error and remains an opaque 500.
    const opaque = await f.request('/assistant/session', {
      method: 'POST', body: '{}', headers: { origin: `http://${f.host}`, 'x-dz23-csrf': 'csrf' },
    })
    expect(opaque.status).toBe(500)

    const root = await mkdtemp(join(tmpdir(), 'dz23-web-no-launcher-')); temporary.push(root)
    await writeFile(join(root, 'index.html'), 'ok')
    const noLauncherHosts: string[] = []
    const noLauncherOrigins: string[] = []
    const noLauncher = createServer(createStudioWebHandler({
      distDirectory: root,
      identity: f.identity as unknown as StudioIdentityService,
      allowedHosts: noLauncherHosts,
      allowedOrigins: noLauncherOrigins,
    }))
    servers.push(noLauncher)
    await new Promise<void>((resolve, reject) => { noLauncher.once('error', reject); noLauncher.listen(0, '127.0.0.1', resolve) })
    const port = (noLauncher.address() as AddressInfo).port
    const noLauncherHost = `127.0.0.1:${port}`
    noLauncherHosts.push(noLauncherHost); noLauncherOrigins.push(`http://${noLauncherHost}`)
    const missing = await fetch(`http://127.0.0.1:${port}/studio/assistant/session`, {
      method: 'POST', body: '{}', headers: {
        origin: `http://${noLauncherHost}`, cookie: `${SESSION_COOKIE}=token`, 'x-dz23-csrf': 'csrf',
      },
    })
    expect(missing.status).toBe(503)
    expect(await missing.json()).toEqual({ error: 'A conversa segura ainda não foi configurada.' })
  })

  it('maps authentication lockout, unknown failures, invalid methods, and missing builds honestly', async () => {
    const f = await fixture()
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('locked', 'Aguarde'))
    expect((await f.request('/')).status).toBe(429)
    f.identity.authenticate.mockRejectedValueOnce('opaque failure')
    const opaque = await f.request('/')
    expect(opaque.status).toBe(500)
    expect(await opaque.text()).toContain('Não foi possível abrir a interface')
    // Cross-origin-capable mutation verbs are rejected by the trust boundary
    // before the method dispatcher, so no method oracle is exposed.
    expect((await f.request('/', { method: 'DELETE' })).status).toBe(401)

    await rm(join(f.root, 'index.html'))
    expect((await f.request('/route-without-extension')).status).toBe(404)
  })

  it('rejects symlinks and serves only known content types with an octet-stream fallback', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'assets', 'data.unknown'), 'opaque')
    const opaque = await f.request('/assets/data.unknown')
    expect(opaque.status).toBe(200)
    expect(opaque.headers.get('content-type')).toBe('application/octet-stream')

    await symlink(join(f.root, 'assets', 'app.js'), join(f.root, 'assets', 'linked.js'))
    expect((await f.request('/assets/linked.js')).status).toBe(400)
  })

  it('accepts only exact local and delegated HTTPS preview source forms and deduplicates them', async () => {
    const accepted = [
      'http://*.dz23.localhost',
      'http://*.dz23.localhost:65535',
      'https://*.preview.apps.example.com',
      'https://*.preview.apps.example.com',
    ]
    const f = await fixture(accepted)
    const policy = (await f.request('/')).headers.get('content-security-policy') ?? ''
    expect(policy).toContain('http://*.dz23.localhost http://*.dz23.localhost:65535 https://*.preview.apps.example.com')
    expect(policy.match(/https:\/\/\*\.preview\.apps\.example\.com/gu)).toHaveLength(1)

    const input = { distDirectory: '.', identity: {} as StudioIdentityService, allowedHosts: [], allowedOrigins: [] }
    for (const source of [
      'http://*.dz23.localhost:65536',
      'http://*.dz23.localhost:0',
      'https://*.preview.localhost',
      'https://*.preview.bad..example.com',
    ]) expect(() => createStudioWebHandler({ ...input, previewFrameSources: [source] })).toThrow('previewFrameSources')
  })

  it('registers the composed web surface using secure defaults or explicit overrides', async () => {
    const registrations: Array<Record<string, unknown>> = []
    const effects: string[] = []
    const ctx = {
      webServer: { port: 3210, register: (value: Record<string, unknown>) => { registrations.push(value); return () => undefined } },
      studioIdentity: { service: {} as StudioIdentityService },
      studioPreview: { frameSource: 'http://*.dz23.localhost:4179' },
      studioTenancy: { service: {} },
      sessionController: {},
      effect: (factory: () => unknown, label: string) => { effects.push(label); factory() },
    }
    await apply(ctx as never)
    await apply(ctx as never, { distDirectory: fakedRoot(), allowedHosts: ['studio.example'], previewFrameSources: [] })
    expect(effects).toEqual(['dz23-studio-web.http', 'dz23-studio-web.http'])
    expect(registrations).toHaveLength(2)
    expect(registrations[0]).toMatchObject({ kind: 'prefix', path: '/studio', handler: expect.any(Function) })
  })
})

function fakedRoot(): string {
  return resolve(join(tmpdir(), 'dz23-explicit-web-dist'))
}
