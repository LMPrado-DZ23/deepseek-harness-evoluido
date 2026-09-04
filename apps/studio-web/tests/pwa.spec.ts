import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import pwa from '../src/i18n/pwa.pt-BR.json' with { type: 'json' }
import { expect, test, type BrowserContext } from '@playwright/test'

/**
 * Playwright's offline emulation never reaches fetches made by a service
 * worker, so this proof puts a tiny TCP-level proxy between the browser and
 * the Studio test server. Killing the proxy (server closed, sockets destroyed)
 * makes the network really disappear for page AND worker; the worker's
 * fallback is then the only way the shell can appear.
 */
const upstream = { host: '127.0.0.1', port: 4179 }
const proxyPort = 4180
const origin = `http://127.0.0.1:${proxyPort}`
let proxy: Server | undefined
const sockets = new Set<Socket>()

function startProxy(): Promise<void> {
  return new Promise(resolvePromise => {
    proxy = createServer((request: IncomingMessage, response: ServerResponse) => {
      const forward = httpRequest({ ...upstream, method: request.method, path: request.url, headers: { ...request.headers, host: `${upstream.host}:${upstream.port}` } }, back => {
        response.writeHead(back.statusCode ?? 502, back.headers)
        back.pipe(response)
      })
      forward.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.pipe(forward)
    })
    proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    proxy.listen(proxyPort, '127.0.0.1', () => resolvePromise())
  })
}

function killProxy(): Promise<void> {
  return new Promise(resolvePromise => {
    for (const socket of sockets) socket.destroy()
    if (proxy === undefined) return resolvePromise()
    proxy.close(() => { proxy = undefined; resolvePromise() })
  })
}

async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
}

test.use({ baseURL: origin })
test.beforeEach(async () => { await startProxy() })
test.afterEach(async () => { await killProxy() })

test('publica manifesto instalável com ícones reais, escopo /studio/ e worker clássico sem imports', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  const link = page.locator('link[rel="manifest"]')
  await expect(link).toHaveAttribute('href', '/studio/manifest.json')
  await expect(link).toHaveAttribute('crossorigin', 'use-credentials')
  const manifest = await page.request.get('/studio/manifest.json')
  expect(manifest.status()).toBe(200)
  const body = await manifest.json() as { name: string; start_url: string; scope: string; display: string; icons: Array<{ src: string; sizes: string; purpose: string }> }
  expect(body).toMatchObject({ name: 'DZ23 STUDIO', start_url: '/studio/', scope: '/studio/', display: 'standalone' })
  expect(body.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(body.icons.some(icon => icon.purpose === 'maskable')).toBe(true)
  for (const icon of body.icons) {
    const response = await page.request.get(icon.src)
    expect(response.status(), icon.src).toBe(200)
    expect(response.headers()['content-type']).toContain('image/png')
  }
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#1f2a5a')
  // The browser's own manifest fetch (no session cookie unless use-credentials) must succeed for installability.
  const cdp = await context.newCDPSession(page)
  const appManifest = await cdp.send('Page.getAppManifest') as { url: string; errors: unknown[]; data?: string }
  expect(appManifest.errors).toEqual([])
  expect(JSON.parse(appManifest.data ?? '{}')).toMatchObject({ name: 'DZ23 STUDIO' })
  const worker = await page.request.get('/studio/sw.js')
  expect(worker.headers()['content-type']).toContain('text/javascript')
  const source = await worker.text()
  expect(source).not.toMatch(/^\s*(?:import|export)\b/mu)
  expect(source).toContain('dz23-studio-shell-')
})

test('serve a casca com o servidor fora do ar, sem nunca ter dados de projeto no cache', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  // The Studio CSP has no 'unsafe-eval', so polling goes through evaluate(function), never waitForFunction(string).
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15_000 }).toBe(true)
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(`${origin}/studio/`)
  await page.reload()
  await expect(page.getByRole('img', { name: 'DZ23 STUDIO' })).toBeVisible()
  await expect(page.locator('.pwa-offline-banner')).toBeHidden()

  // Network really gone for page and worker: proxy closed, sockets destroyed. The browser still reports
  // navigator.onLine=true (the interface is not what is offline), so the banner stays hidden — the shell
  // itself is the evidence.
  await killProxy()
  await page.reload()
  await expect(page.getByRole('img', { name: 'DZ23 STUDIO' })).toBeVisible({ timeout: 20_000 })
  const offlineApi = await page.evaluate(async () => {
    const response = await fetch('/api/studio/apps/projects')
    return { status: response.status, body: await response.json() as unknown }
  })
  // The device HAS network; the Studio is what is gone. The two causes are not the same sentence.
  expect(offlineApi).toEqual({ status: 503, body: { error: 'SERVICE_UNREACHABLE', offline: false, serviceUnreachable: true } })
  const cachedPaths = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname)
    return urls
  })
  expect(cachedPaths.some(path => path.startsWith('/api/'))).toBe(false)
  expect(cachedPaths).toEqual(expect.arrayContaining(['/studio/', '/studio/manifest.json']))

  // Browser-level offline (navigator.onLine=false) drives the banner.
  await context.setOffline(true)
  await expect(page.locator('.pwa-offline-banner')).toBeVisible()
  await expect(page.locator('.pwa-offline-banner')).toHaveText(pwa.offline.banner)
  // No promise of a queue: the text says the screen stays open and nothing can be created, saved or sent.
  expect(pwa.offline.banner).not.toMatch(/esperar a conexão/u)
  // Now the device really is offline, and the worker says so with the other code.
  const trulyOffline = await page.evaluate(async () => {
    const response = await fetch('/api/studio/apps/projects')
    return { status: response.status, body: await response.json() as unknown }
  })
  expect(trulyOffline).toEqual({ status: 503, body: { error: 'OFFLINE', offline: true } })
  await context.setOffline(false)
  await expect(page.locator('.pwa-offline-banner')).toBeHidden()
})

test('confirma a instalação sem nunca dizer que está sem internet', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.locator('.pwa-offline-banner')).toHaveText('O DZ23 STUDIO foi instalado neste aparelho.')
  await expect(page.locator('.pwa-offline-banner')).toBeHidden({ timeout: 6_000 })
  await expect(page.locator('.pwa-install')).toBeHidden()
})

test('mostra notificação local quando a criação termina com a aba em segundo plano', async ({ context, page }) => {
  await signIn(context)
  await context.grantPermissions(['notifications'], { origin })
  await page.addInitScript(() => {
    const shown: Array<{ title: string; body: string }> = []
    ;(window as unknown as { __dz23Notifications: typeof shown }).__dz23Notifications = shown
    class FakeNotification {
      static permission: NotificationPermission = 'granted'
      static requestPermission = async () => 'granted' as NotificationPermission
      constructor(title: string, options?: { body?: string }) { shown.push({ title, body: options?.body ?? '' }) }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true })
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    // The page shows the notification through the service worker registration whenever there is
    // one (the only path that works on Android) and through the constructor otherwise. Both paths
    // are captured, so the test asserts the CONTRACT — one notification per final state — instead
    // of which of the two happened to win the race with `serviceWorker.ready`.
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      configurable: true,
      get: () => Promise.resolve({
        showNotification: (title: string, options?: { body?: string }) => { shown.push({ title, body: options?.body ?? '' }); return Promise.resolve() },
      } as unknown as ServiceWorkerRegistration),
    })
  })
  await page.goto('/studio/')
  // The rebinding to the registration happens after `serviceWorker.ready` resolves; waiting for it
  // is what makes this deterministic instead of a race that fails once in a while.
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'VERIFIED_PROTOTYPE' } }))
    window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'SOMETHING_ELSE' } }))
  })
  const shown = await page.evaluate(() => (window as unknown as { __dz23Notifications: Array<{ title: string; body: string }> }).__dz23Notifications)
  expect(shown).toEqual([{ title: 'DZ23 STUDIO', body: 'Seu protótipo foi verificado.' }])
})
