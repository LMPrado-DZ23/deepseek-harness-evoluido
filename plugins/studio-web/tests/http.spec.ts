import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityError, SESSION_COOKIE, type StudioIdentityService } from '@dz23-studio/identity'
import { apply, createStudioWebHandler } from '../src/index.js'

const servers: ReturnType<typeof createServer>[] = []; const temporary: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(previewFrameSources: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-web-')); temporary.push(root)
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'index.html'), '<main>DZ23 STUDIO</main>'); await writeFile(join(root, 'assets/app.js'), 'ok')
  const identity = { authenticate: vi.fn(() => Promise.resolve({ session_id: 'session' })) }
  const allowedHosts: string[] = []
  const server = createServer(createStudioWebHandler({
    distDirectory: root, identity: identity as unknown as StudioIdentityService, allowedHosts, previewFrameSources,
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; allowedHosts.push(host)
  const request = (path: string, init: RequestInit = {}) => fetch(`http://${host}/studio${path}`, {
    ...init, headers: { host, cookie: `${SESSION_COOKIE}=token`, ...(init.headers ?? {}) },
  })
  return { request, identity, allowedHosts, host, root }
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
    const input = { distDirectory: '.', identity: {} as StudioIdentityService, allowedHosts: [] }
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

    const input = { distDirectory: '.', identity: {} as StudioIdentityService, allowedHosts: [] }
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
