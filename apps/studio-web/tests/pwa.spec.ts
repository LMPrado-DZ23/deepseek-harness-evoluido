import { readdirSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import pwa from '../src/i18n/pwa.pt-BR.json' with { type: 'json' }
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Playwright's offline emulation never reaches fetches made by a service
 * worker, so this proof puts a tiny TCP-level proxy between the browser and
 * the FRIGG test server. Killing the proxy (server closed, sockets destroyed)
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


/**
 * What the PAGE learns about the screen it is showing, asked exactly the way `register.ts` asks it:
 * of the worker that controls this page, about this page's own navigation. `null` means there is no
 * controller to ask — which is what a reload that bypassed the worker produces.
 */
function shellSourceSeenByPage(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const worker = navigator.serviceWorker?.controller
    if (worker === null || worker === undefined) return null
    return await new Promise<string | null>(resolve => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve('sem-resposta'), 3_000)
      channel.port1.onmessage = message => {
        clearTimeout(timer)
        const source = (message.data as { source?: unknown } | null)?.source
        resolve(typeof source === 'string' ? source : 'nada-marcado')
      }
      worker.postMessage({ type: 'dz23:shell-source?' }, [channel.port2])
    })
  })
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
  expect(body).toMatchObject({ name: 'FRIGG', start_url: '/studio/', scope: '/studio/', display: 'standalone' })
  expect(body.icons.map(icon => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(body.icons.some(icon => icon.purpose === 'maskable')).toBe(true)
  for (const icon of body.icons) {
    const response = await page.request.get(icon.src)
    expect(response.status(), icon.src).toBe(200)
    expect(response.headers()['content-type']).toContain('image/png')
  }
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#111418')
  // The browser's own manifest fetch (no session cookie unless use-credentials) must succeed for installability.
  const cdp = await context.newCDPSession(page)
  const appManifest = await cdp.send('Page.getAppManifest') as { url: string; errors: unknown[]; data?: string }
  expect(appManifest.errors).toEqual([])
  expect(JSON.parse(appManifest.data ?? '{}')).toMatchObject({ name: 'FRIGG' })
  const worker = await page.request.get('/studio/sw.js')
  expect(worker.headers()['content-type']).toContain('text/javascript')
  const source = await worker.text()
  expect(source).not.toMatch(/^\s*(?:import|export)\b/mu)
  expect(source).toContain('dz23-studio-shell-')
})

test('serve a casca com o servidor fora do ar, sem nunca ter dados de projeto no cache', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  // The FRIGG CSP has no 'unsafe-eval', so polling goes through evaluate(function), never waitForFunction(string).
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15_000 }).toBe(true)
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(`${origin}/studio/`)
  await page.reload()
  // A marca do proprietário, derivada do original (ADR-050). Ela é procurada
  // pelo ELEMENTO e não pelo texto alternativo: o alternativo virou vazio de
  // propósito, porque o nome "FRIGG" está escrito ao lado dela em texto
  // real, e um leitor de tela que anuncia os dois diz a marca duas vezes.
  await expect(page.locator('.dz-marca img')).toBeVisible()
  await expect(page.locator('.pwa-offline-banner')).toBeHidden()

  // Network really gone for page and worker: proxy closed, sockets destroyed. The browser still reports
  // navigator.onLine=true (the interface is not what is offline), so the banner stays hidden — the shell
  // itself is the evidence.
  await killProxy()
  await page.reload()
  await expect(page.locator('.dz-marca img')).toBeVisible({ timeout: 20_000 })
  const offlineApi = await page.evaluate(async () => {
    const response = await fetch('/api/studio/apps/projects')
    return { status: response.status, body: await response.json() as unknown }
  })
  // The device HAS network; the FRIGG is what is gone. The two causes are not the same sentence.
  expect(offlineApi).toEqual({ status: 503, body: { error: 'SERVICE_UNREACHABLE', offline: false, serviceUnreachable: true } })
  // A MUTATION gets the same treatment as a read: the worker answers POST too, so a blocked action
  // reaches the interface as a code it can turn into a sentence, never as a raw "Failed to fetch".
  const unreachablePost = await page.evaluate(async () => {
    const response = await fetch('/api/studio/apps/projects/p-1/generate', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    return { status: response.status, body: await response.json() as unknown }
  })
  expect(unreachablePost).toEqual({ status: 503, body: { error: 'SERVICE_UNREACHABLE', offline: false, serviceUnreachable: true } })
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
  const offlinePost = await page.evaluate(async () => {
    const response = await fetch('/api/studio/apps/projects/p-1/generate', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    return { status: response.status, body: await response.json() as unknown }
  })
  // Same action, other cause, other code — and the catalogue has a different sentence for each.
  expect(offlinePost).toEqual({ status: 503, body: { error: 'OFFLINE', offline: true } })
  expect(pwa.offline.blockedAction).not.toBe(pwa.offline.serviceUnreachable)
  await context.setOffline(false)
  await expect(page.locator('.pwa-offline-banner')).toBeHidden()
})

test('confirma a instalação sem nunca dizer que está sem internet', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.locator('.pwa-offline-banner')).toHaveText('O FRIGG foi instalado neste aparelho.')
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
  // What makes this deterministic is that BOTH paths write into the same array above — the stubbed
  // `ready` getter returns a new promise each time, so awaiting it here does not by itself order the
  // page's own rebinding, and saying otherwise would be a comment that lies. This await only lets
  // the page's continuation run before the event is dispatched.
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'VERIFIED_PROTOTYPE', runId: 'run-verified' } }))
    window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'SOMETHING_ELSE' } }))
  })
  const shown = await page.evaluate(() => (window as unknown as { __dz23Notifications: Array<{ title: string; body: string }> }).__dz23Notifications)
  expect(shown).toEqual([{ title: 'FRIGG', body: 'Seu protótipo foi verificado.' }])
  // The page polls: the same finished run can be seen more than once. One result, one notification —
  // and another run reaching the same state is another result, which must be said.
  await page.evaluate(() => {
    for (let repeat = 0; repeat < 3; repeat++) window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'CANCELLED', runId: 'run-a' } }))
    window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'CANCELLED', runId: 'run-b' } }))
  })
  const afterRuns = await page.evaluate(() => (window as unknown as { __dz23Notifications: Array<{ title: string; body: string }> }).__dz23Notifications)
  expect(afterRuns.slice(1)).toEqual([
    { title: 'FRIGG', body: pwa.notifications.cancelled },
    { title: 'FRIGG', body: pwa.notifications.cancelled },
  ])
})

test('sem rede e sem a copia salva, mostra uma pagina em pt-BR em vez da tela de erro do Chrome', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15_000 }).toBe(true)
  // What the browser itself does under storage pressure: it throws the Cache Storage away and keeps
  // the worker registered. Before the fix the worker then answered an EMPTY 503 and Chrome showed
  // net::ERR_HTTP_RESPONSE_CODE_FAILURE — its own error screen, in English, with no document.body.
  await page.evaluate(async () => { for (const name of await caches.keys()) await caches.delete(name) })
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0)
  await killProxy()
  await page.reload()

  // A real document, in the person's language, that says what happened and what to do.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('pt-BR')
  expect(await page.evaluate(() => Boolean(document.body))).toBe(true)
  const text = await page.evaluate(() => document.body.innerText)
  expect(text).toContain(pwa.offline.shellUnavailable.title)
  expect(text).toContain(pwa.offline.shellUnavailable.body)
  expect(text).toContain(pwa.offline.shellUnavailable.retry)
  // And it is not the FRIGG pretending to be open: the interface is not there.
  expect(await page.locator('.brand').count()).toBe(0)
})

test('a casca servida do cache se identifica como copia salva, e some quando a sessao termina', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15_000 }).toBe(true)
  await page.reload()
  // With a live session the screen is what the server just sent, and nothing extra is said.
  await expect(page.locator('.pwa-cached-shell')).toBeHidden()
  expect(await shellSourceSeenByPage(page)).toBe('network')

  // The session ends and the device goes offline BEFORE the worker can learn about it — the exact
  // sequence the reviewer reproduced. The interface used to come back with nothing to distinguish it
  // from a signed-in session, and the person was told "you are offline" when the truth was "your
  // session ended".
  await context.clearCookies()
  await killProxy()
  await page.reload()
  await expect(page.locator('.dz-marca img')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.pwa-cached-shell')).toBeVisible()
  await expect(page.locator('.pwa-cached-shell')).toHaveText(pwa.offline.cachedShell)
  expect(await shellSourceSeenByPage(page)).toBe('cache')

  // Network back, session still over: the server answers 401 and the copy of the authenticated
  // interface saved on this device goes away with the session.
  await startProxy()
  const denied = await page.goto('/studio/')
  expect(denied?.status()).toBe(401)
  expect(await denied?.text()).toContain('Entre para continuar.')
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('dz23-studio-shell-')).length), { timeout: 10_000 }).toBe(0)

  // And offline from now on there is no interface to come back: only the honest page.
  await killProxy()
  await page.reload()
  expect(await page.evaluate(() => document.body.innerText)).toContain(pwa.offline.shellUnavailable.title)
  expect(await page.locator('.brand').count()).toBe(0)
})

/**
 * SUSPEITA CONFIRMADA E FECHADA. The mark was one global slot in Cache Storage for a fact that
 * belongs to ONE navigation. Reproduced in this browser, before the fix, exactly as below: visit
 * once with no network (the slot is left saying `cache`), bring the network back and reload with
 * the worker bypassed — Shift+Reload, which CDP spells `Network.setBypassServiceWorker`. That
 * navigation never reaches the fetch handler, nothing corrects the slot, and the page read it and
 * told a person whose session was alive (the API answering 200 on the same screen):
 * "Mostrando a tela salva neste aparelho; entre de novo quando a internet voltar."
 *
 * The page now asks the worker that controls it. A bypassed navigation produces a page with NO
 * controller — asserted below, because that is the whole mechanism — so there is nobody to ask and
 * nothing is claimed about a screen the worker never served.
 */
test('uma recarga que passa por cima do worker nao herda o aviso de tela salva de uma visita anterior', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15_000 }).toBe(true)

  // A visit with no network: the screen really is the copy saved on this device, and it says so.
  // One load with the worker in charge, so the interface's own files are on the device too.
  await page.reload()
  await killProxy()
  await page.reload()
  await expect(page.locator('.dz-marca img')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.pwa-cached-shell')).toBeVisible()
  expect(await shellSourceSeenByPage(page)).toBe('cache')

  // Network back, and the person reloads bypassing the worker. The shell comes from the server.
  await startProxy()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setBypassServiceWorker', { bypass: true })
  await page.reload()
  await expect(page.locator('.dz-marca img')).toBeVisible({ timeout: 20_000 })

  // The session is alive: this screen came from the FRIGG, not from the device.
  const live = await page.evaluate(async () => (await fetch('/api/studio/apps/projects')).status)
  expect(live).toBe(200)
  // The worker never saw this navigation, and the page knows it: there is no controller to ask.
  expect(await page.evaluate(() => navigator.serviceWorker?.controller === null)).toBe(true)
  expect(await shellSourceSeenByPage(page)).toBeNull()
  // So nobody is told to sign in again over a session that never ended.
  await expect(page.locator('.pwa-cached-shell')).toBeHidden()
})

/**
 * NOT a fix: a tripwire, and it is written down as one (ADR-030, "o que continua em aberto").
 *
 * The worker calls `skipWaiting()` on install and `clients.claim()` on activate, and `activate`
 * deletes the previous version's cache. So a new version activates under a tab that is already open
 * and removes from the cache the assets that tab might still ask for. It cannot hurt anybody today:
 * the interface is built as ONE chunk with no dynamic `import()`, so a tab that is already running
 * has already loaded everything it will ever need. The day the bundle is split — a lazy route, a
 * `import()` anywhere — that stops being true, and a person with an open tab gets a chunk request
 * that the cache no longer has and the server no longer serves.
 *
 * Deciding it now, with no way to make it fail, would be inventing a mechanism nobody can test. So
 * this guard fails on the exact day the condition arrives, and its message says what to do then.
 */
test('a casca continua sendo um unico pedaco: o dia em que deixar de ser, esta guarda cai', () => {
  const assets = resolve(import.meta.dirname, '..', 'dist', 'assets')
  const scripts = readdirSync(assets).filter(name => name.endsWith('.js'))
  const remedy = 'skipWaiting()+clients.claim() com activate apagando o cache anterior so e seguro enquanto a interface for um pedaco unico;'
    + ' ao dividir o bundle, mantenha o cache da versao anterior ate o ultimo cliente dela sair, ou pare de reivindicar clientes (ADR-030).'
  expect(scripts, remedy).toHaveLength(1)
  const source = readFileSync(resolve(assets, scripts[0]!), 'utf8')
  // `import(` in the built bundle is a chunk fetched at runtime — exactly the request an activated
  // new version would have already removed from the cache of the tab that is still open.
  expect(/\bimport\s*\(/u.test(source), remedy).toBe(false)
})
