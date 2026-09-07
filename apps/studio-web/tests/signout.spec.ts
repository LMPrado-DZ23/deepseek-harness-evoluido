import { expect, request as apiRequest, test, type BrowserContext, type Page } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

async function prepareBrowserState(context: BrowserContext, page: Page, token: string, path = '/studio/'): Promise<void> {
  await context.addCookies([{ name: 'dz23_studio_session', value: token, url: origin }])
  await page.addInitScript(() => {
    if (!window.location.pathname.startsWith('/studio/')) return
    window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e')
    window.sessionStorage.setItem('test.session.keep', 'preservado')
    window.localStorage.setItem('dsh.sessions.current', 'sessão-do-assistente')
    window.localStorage.setItem('test.local.keep', 'preservado')
  })
  await page.goto(path)
  await page.evaluate(async () => {
    await (await caches.open('dz23-studio-shell-e2e-logout')).put('/studio/test-shell', new Response('shell'))
    await (await caches.open('test-unrelated-cache')).put('/test-unrelated', new Response('preservado'))
  })
}

async function browserState(page: Page) {
  return page.evaluate(async () => ({
    csrf: window.sessionStorage.getItem('dz23.studio.csrf.v1'),
    selectedSession: window.localStorage.getItem('dsh.sessions.current'),
    keptSession: window.sessionStorage.getItem('test.session.keep'),
    keptLocal: window.localStorage.getItem('test.local.keep'),
    caches: await caches.keys(),
  }))
}

test('revoga a sessão atual antes de limpar somente o estado DZ23 do navegador', async ({ context, page }) => {
  await prepareBrowserState(context, page, 'e2e-logout')

  const logoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/identity/logout')
  await page.getByRole('button', { name: 'Sair' }).click()
  expect((await logoutResponse).status()).toBe(200)
  await expect(page).toHaveURL(/\/login$/u)

  await expect(browserState(page)).resolves.toEqual({
    csrf: null,
    selectedSession: null,
    keptSession: 'preservado',
    keptLocal: 'preservado',
    caches: ['test-unrelated-cache'],
  })
  expect((await context.cookies(origin)).some(cookie => cookie.name === 'dz23_studio_session')).toBe(false)

  const rejected = await apiRequest.newContext({
    baseURL: 'http://127.0.0.1:4179',
    extraHTTPHeaders: { host: 'studio.dz23.localhost:4179', cookie: 'dz23_studio_session=e2e-logout' },
  })
  expect((await rejected.get('/api/studio/identity/session')).status()).toBe(401)
  await rejected.dispose()
})

test('preserva cookie, tela, cache e storage quando o servidor não revoga', async ({ context, page }) => {
  const sibling = await context.newPage()
  await prepareBrowserState(context, page, 'e2e-logout-fail')
  await prepareBrowserState(context, sibling, 'e2e-logout-fail')

  const logoutResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/identity/logout')
  await page.getByRole('button', { name: 'Sair' }).click()
  expect((await logoutResponse).status()).toBe(401)
  await expect(page).toHaveURL(/\/studio\/$/u)
  await expect(page.getByRole('alert')).toHaveText('Não foi possível encerrar sua sessão. Confira a conexão e tente novamente.')
  await expect(page.getByRole('button', { name: 'Sair' })).toBeEnabled()
  await expect(sibling).toHaveURL(/\/studio\/$/u)
  await expect(sibling.getByRole('button', { name: 'Sair' })).toBeEnabled()

  await expect(browserState(page)).resolves.toEqual({
    csrf: 'csrf-e2e',
    selectedSession: 'sessão-do-assistente',
    keptSession: 'preservado',
    keptLocal: 'preservado',
    caches: expect.arrayContaining([expect.stringMatching(/^dz23-studio-shell-/u), 'test-unrelated-cache']),
  })
  expect((await context.cookies(origin)).some(cookie => cookie.name === 'dz23_studio_session' && cookie.value === 'e2e-logout-fail')).toBe(true)

  const stillActive = await apiRequest.newContext({
    baseURL: 'http://127.0.0.1:4179',
    extraHTTPHeaders: { host: 'studio.dz23.localhost:4179', cookie: 'dz23_studio_session=e2e-logout-fail' },
  })
  expect((await stillActive.get('/api/studio/identity/session')).status()).toBe(200)
  await stillActive.dispose()
})

test('sincroniza a saída confirmada com outra aba sem repetir a mutação', async ({ context, page }) => {
  const hub = await context.newPage()
  const assistant = await context.newPage()
  await prepareBrowserState(context, page, 'e2e-logout-cross-tab')
  await prepareBrowserState(context, hub, 'e2e-logout-cross-tab', '/studio/hub')
  await prepareBrowserState(context, assistant, 'e2e-logout-cross-tab', '/studio/assistente')
  await expect(page.getByRole('button', { name: 'Sair' })).toBeEnabled()
  await expect(hub).toHaveURL(/\/studio\/hub$/u)
  await expect(assistant).toHaveURL(/\/studio\/assistente$/u)

  const siblingIdentityRequests: Array<{ screen: string; method: string; path: string }> = []
  for (const [screen, sibling] of [['hub', hub], ['assistant', assistant]] as const) {
    sibling.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/studio/identity/')) siblingIdentityRequests.push({ screen, method: request.method(), path: url.pathname })
    })
  }

  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page).toHaveURL(/\/login$/u)
  for (const sibling of [hub, assistant]) {
    await expect(sibling).toHaveURL(/\/login$/u)
    await expect(browserState(sibling)).resolves.toEqual({
      csrf: null,
      selectedSession: null,
      keptSession: 'preservado',
      keptLocal: 'preservado',
      caches: ['test-unrelated-cache'],
    })
  }
  expect(siblingIdentityRequests).toEqual(expect.arrayContaining([
    { screen: 'hub', method: 'GET', path: '/api/studio/identity/session' },
    { screen: 'assistant', method: 'GET', path: '/api/studio/identity/session' },
  ]))
  expect(siblingIdentityRequests).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: '/api/studio/identity/logout' }),
  ]))
})

test('preserva um login novo concluído enquanto a confirmação final antiga estava em voo', async ({ context, page }) => {
  const sibling = await context.newPage()
  await prepareBrowserState(context, page, 'e2e-logout-generation-race')
  await prepareBrowserState(context, sibling, 'e2e-logout-generation-race', '/studio/hub')
  const cdp = await context.newCDPSession(sibling)
  await cdp.send('Network.enable')
  await cdp.send('Network.setBypassServiceWorker', { bypass: true })

  let probes = 0
  let releaseFinalProbe: (() => void) | undefined
  let markFinalProbeStarted: (() => void) | undefined
  const finalProbeStarted = new Promise<void>(resolve => { markFinalProbeStarted = resolve })
  const finalProbeRelease = new Promise<void>(resolve => { releaseFinalProbe = resolve })
  await sibling.route('**/api/studio/identity/session', async route => {
    probes += 1
    if (probes === 2) {
      markFinalProbeStarted?.()
      await finalProbeRelease
    }
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'old-session' }) })
  })

  await page.getByRole('button', { name: 'Sair' }).click()
  await finalProbeStarted
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e-logout-fail', url: origin },
    { name: 'dz23_studio_session_generation', value: '88888888888888888888888888888888', url: origin, sameSite: 'Strict' },
  ])
  releaseFinalProbe?.()

  await expect.poll(() => probes).toBe(2)
  await expect(page).toHaveURL(/\/login$/u)
  await sibling.waitForTimeout(250)
  await expect(sibling).toHaveURL(/\/studio\/hub$/u)
  await expect(browserState(sibling)).resolves.toEqual({
    csrf: 'csrf-e2e',
    // Cache Storage and localStorage are origin-wide, so the initiating tab
    // already removed its own DZ23 values. The guarded sibling must preserve
    // its tab-scoped CSRF state and screen instead of performing cleanup too.
    selectedSession: null,
    keptSession: 'preservado',
    keptLocal: 'preservado',
    caches: ['test-unrelated-cache'],
  })
  await cdp.detach()
})

test('não oferece sair no modo pessoal sem sessão revogável', async ({ page }) => {
  await page.goto('/studio/')

  await expect(page.getByRole('button', { name: 'Sair' })).toHaveCount(0)
})
