import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityError, SESSION_COOKIE, type StudioIdentityService } from '@dz23-studio/identity'
import { createStudioWebHandler } from '../src/index.js'

const servers: ReturnType<typeof createServer>[] = []; const temporary: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-web-')); temporary.push(root)
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'index.html'), '<main>DZ23 STUDIO</main>'); await writeFile(join(root, 'assets/app.js'), 'ok')
  const identity = { authenticate: vi.fn(() => Promise.resolve({ session_id: 'session' })) }
  const allowedHosts: string[] = []
  const server = createServer(createStudioWebHandler({ distDirectory: root, identity: identity as unknown as StudioIdentityService, allowedHosts }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; allowedHosts.push(host)
  const request = (path: string, init: RequestInit = {}) => fetch(`http://${host}/studio${path}`, {
    ...init, headers: { host, cookie: `${SESSION_COOKIE}=token`, ...(init.headers ?? {}) },
  })
  return { request, identity, allowedHosts, host }
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
    const f = await fixture(); const response = await f.request('/', { method: 'HEAD' })
    expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(await response.text()).toBe('')
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
})
