import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:4179'

async function signIn(context: Parameters<Parameters<typeof test>[2]>[0]['context']): Promise<void> {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
}

test('publica manifesto instalável com ícones reais e escopo /studio/', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  const link = page.locator('link[rel="manifest"]')
  await expect(link).toHaveAttribute('href', '/studio/manifest.json')
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
})

test('registra o service worker, serve a casca sem internet e nunca entrega dados de projeto do cache', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/')
  // The Studio CSP has no 'unsafe-eval', so polling goes through evaluate(function), never waitForFunction(string).
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15_000 }).toBe(true)
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toBe(`${origin}/studio/`)
  // Warm the cache with the hashed assets by reloading once under the worker.
  await page.reload()
  await expect(page.getByRole('img', { name: 'DZ23 STUDIO' })).toBeVisible()
  await expect(page.locator('.pwa-offline-banner')).toBeHidden()

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('img', { name: 'DZ23 STUDIO' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.pwa-offline-banner')).toBeVisible()
  await expect(page.locator('.pwa-offline-banner')).toHaveText('Você está sem internet. O Studio continua aberto, mas suas ações vão esperar a conexão voltar.')
  // Playwright's offline emulation does not reach service-worker-initiated fetches, so the
  // "API offline → 503 OFFLINE" path is proven at worker level in src/pwa/sw.spec.ts; here we
  // prove that no project data ever entered the cache.
  const cachedApiEntries = await page.evaluate(async () => {
    const names = await caches.keys()
    const urls: string[] = []
    for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname)
    return urls
  })
  expect(cachedApiEntries.some(path => path.startsWith('/api/'))).toBe(false)
  expect(cachedApiEntries).toEqual(expect.arrayContaining(['/studio/', '/studio/manifest.json']))

  await context.setOffline(false)
  await page.reload()
  await expect(page.locator('.pwa-offline-banner')).toBeHidden()
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
  })
  await page.goto('/studio/')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'VERIFIED_PROTOTYPE' } })))
  const shown = await page.evaluate(() => (window as unknown as { __dz23Notifications: Array<{ title: string; body: string }> }).__dz23Notifications)
  expect(shown).toEqual([{ title: 'DZ23 STUDIO', body: 'Seu protótipo foi verificado.' }])
})
