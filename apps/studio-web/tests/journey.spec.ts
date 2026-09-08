import AxeBuilder from '@axe-core/playwright'
import { expect, request as apiRequest, test } from '@playwright/test'

test('recusa interface e API sem sessão', async () => {
  const client = await apiRequest.newContext({
    baseURL: 'http://127.0.0.1:4179',
    extraHTTPHeaders: { host: 'studio.dz23.localhost:4179' },
  })
  expect((await client.get('/studio')).status()).toBe(401)
  expect((await client.get('/api/studio/apps/health')).status()).toBe(401)
  await client.dispose()
})

test('o login HTTP local grava sessão host-only sem enfraquecer o modo de servidor', async ({ context, page }) => {
  await page.goto('/login')
  const login = await page.evaluate(async () => {
    const response = await fetch('/api/studio/identity/magic/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', code: '123456', device_label: 'Chromium local' }),
    })
    const body = await response.json() as { session_generation?: unknown }
    if (typeof body.session_generation === 'string') window.localStorage.setItem('dz23.studio.session-generation.v1', body.session_generation)
    return { status: response.status, generation: window.localStorage.getItem('dz23.studio.session-generation.v1') }
  })
  expect(login).toEqual({ status: 200, generation: expect.stringMatching(/^[a-f0-9]{32}$/u) })
  const cookies = await context.cookies('http://studio.dz23.localhost:4179')
  expect(cookies).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'dz23_studio_session', value: 'session-token', domain: 'studio.dz23.localhost', httpOnly: true, secure: false }),
  ]))
  expect(cookies.some(cookie => cookie.name === 'dz23_studio_csrf')).toBe(false)
})

test('abre o Integration Hub pela navegação autenticada do Studio', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' }])
  await page.goto('/studio/')
  const link = page.getByRole('link', { name: 'Integrações' })
  await expect(link).toHaveAttribute('href', '/studio/hub')
  await link.click()
  await expect(page).toHaveURL(/\/studio\/hub$/u)
  await expect(page.getByRole('heading', { level: 1, name: 'Integrações e pacote do protótipo' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Voltar ao Studio' })).toHaveAttribute('href', '/studio/')
})

/**
 * O trecho verificado desta jornada NÃO é alcançável hoje.
 *
 * `plugins/prompt-to-app/src/pipeline.ts:213` lança
 * `ACCEPTANCE_ATTESTATION_UNAVAILABLE` exatamente quando o ciclo do construtor
 * passa e não há diagnóstico - ou seja, no caminho de SUCESSO. O ramo
 * `state === 'PASSED'` logo abaixo é inalcançável, e com ele o protótipo
 * verificado, a notificação e a prévia. Falhar fechado é a decisão certa
 * enquanto não existir atestação de aceitação; o que não pode é ninguém saber.
 *
 * As afirmações abaixo da bandeira ficam no repositório de propósito: são a
 * especificação do dia em que a atestação existir. Trocar isto por `true` sem
 * a atestação seria fabricar um "verificado".
 */
const VERIFIED_JOURNEY_REACHABLE = false

test('percorre as cinco etapas, muda privacidade e termina sem alegar publicação', async ({ context, page }) => {
  const admissionPosts: Array<{ readonly hasTicket: boolean; readonly origin: string; readonly url: string }> = []
  const requestedUrls: string[] = []
  const mutationBodies: unknown[] = []
  page.on('request', request => {
    requestedUrls.push(request.url())
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/studio/apps/')) {
      try { mutationBodies.push(request.postDataJSON()) } catch { /* uploads are binary and carry no authority fields */ }
    }
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/__dz23/admission') return
    const payload = request.postDataJSON() as unknown
    void request.allHeaders().then(headers => {
      admissionPosts.push({
        hasTicket: typeof payload === 'object' && payload !== null && 'ticket' in payload && typeof (payload as { ticket?: unknown }).ticket === 'string',
        origin: headers.origin ?? '',
        url: request.url(),
      })
    })
  })
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://studio.dz23.localhost:4179' },
  ])
  await context.addInitScript(() => {
    window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e')
    const shown: Array<{ title: string; body: string; tag?: string }> = []
    let permissionRequests = 0
    ;(window as unknown as { __dz23Notifications: typeof shown }).__dz23Notifications = shown
    ;(window as unknown as { __dz23PermissionRequests: () => number }).__dz23PermissionRequests = () => permissionRequests
    class FakeNotification {
      static permission: NotificationPermission = 'default'
      static async requestPermission(): Promise<NotificationPermission> { permissionRequests++; FakeNotification.permission = 'granted'; return 'granted' }
      constructor(title: string, options?: NotificationOptions) { shown.push({ title, body: options?.body ?? '', ...(options?.tag === undefined ? {} : { tag: options.tag }) }) }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true })
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      configurable: true,
      get: () => Promise.resolve({
        showNotification: (title: string, options?: NotificationOptions) => {
          shown.push({ title, body: options?.body ?? '', ...(options?.tag === undefined ? {} : { tag: options.tag }) })
          return Promise.resolve()
        },
      } as unknown as ServiceWorkerRegistration),
    })
  })
  const studioResponse = await page.goto('/studio')
  const studioPolicy = studioResponse?.headers()['content-security-policy'] ?? ''
  expect(studioPolicy).toContain('frame-src http://*.dz23.localhost:4179')
  expect(studioPolicy).toContain("frame-ancestors 'none'")
  const notificationOptIn = page.getByRole('button', { name: 'Avisar quando a criação terminar' })
  await expect(notificationOptIn).toBeVisible()
  await notificationOptIn.click()
  await expect(page.getByText('Este aparelho vai avisar quando a criação terminar.')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __dz23PermissionRequests: () => number }).__dz23PermissionRequests())).toBe(1)
  await expect(page.getByRole('button', { name: 'Quero um painel para minha equipe criar, editar e excluir cadastros.' })).toBeVisible()
  await expect(page.getByText('Seus dados não são enviados para serviços externos.')).toBeVisible()
  await page.getByText('Permitir IA configurada', { exact: false }).click()
  await expect(page.locator('.privacy-notice')).toContainText('ollama-local')
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
    await page.getByLabel('Sua resposta').fill(answer)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByLabel('O que precisa mudar?').fill('Mostrar o contato antes dos serviços.')
  await page.getByRole('button', { name: 'Enviar pedido de mudança' }).click()
  await page.getByRole('button', { name: 'Montar plano revisado' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.plan-list .task-card')).toHaveCount(2)
  const lastSlice = page.locator('.plan-list .task-card h2').last()
  const approveButton = page.getByRole('button', { name: 'Aprovar este plano' })
  await expect(lastSlice).toBeVisible()
  await expect(lastSlice).toContainText('Contato')
  expect(await lastSlice.evaluate((node, approve) => Boolean(node.compareDocumentPosition(approve as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await approveButton.elementHandle())).toBe(true)
  await approveButton.click()
  const acceptedPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/generate'))
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  const accepted = await acceptedPromise
  expect(accepted.status()).toBe(202)
  const acceptedBody = await accepted.json() as { run_id: string }
  expect(acceptedBody.run_id).toMatch(/^operation-/u)
  // A pessoa lê a FRASE, não o código. O código técnico continua existindo, mas
  // atrás de "Detalhes técnicos": antes ele era a primeira coisa na tela, em
  // inglês e em caixa alta, para quem não programa.
  await expect(page.getByText('A criação foi interrompida antes de terminar. Nada foi publicado.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('ACCEPTANCE_ATTESTATION_UNAVAILABLE')).toBeHidden()
  await page.getByText('Detalhes técnicos').click()
  await expect(page.getByText('ACCEPTANCE_ATTESTATION_UNAVAILABLE')).toBeVisible()
  // O que mais importa nesta tela: mesmo terminando mal, ela não alega
  // publicação nenhuma.
  await expect(page.getByText('publicado na internet', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toHaveCount(0)
  expect(JSON.stringify(mutationBodies)).not.toMatch(/org_id|tenant_id|bootstrap_owner|"role"/u)

  if (!VERIFIED_JOURNEY_REACHABLE) {
    test.info().annotations.push({
      type: 'lacuna',
      description: 'Protótipo verificado e prévia não são alcançáveis: pipeline.ts:213 lança ACCEPTANCE_ATTESTATION_UNAVAILABLE no caminho de sucesso.',
    })
    return
  }

  await expect(page.getByText('As verificações declaradas passaram neste computador.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('não está publicado nem disponível para outras pessoas', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('page:Início: Passou')).toBeVisible()
  await expect(page.getByText('A navegação deve ser simples.: Não verificado automaticamente')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dz23Notifications: unknown[] }).__dz23Notifications.length)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __dz23Notifications: Array<{ title: string; body: string; tag?: string }> }).__dz23Notifications)).toEqual([
    { title: 'DZ23 STUDIO', body: 'Seu protótipo foi verificado.', tag: `dz23-generation-${acceptedBody.run_id}` },
  ])
  await page.evaluate(({ runId }) => window.dispatchEvent(new CustomEvent('dz23:generation-finished', { detail: { state: 'VERIFIED_PROTOTYPE', runId } })), { runId: acceptedBody.run_id })
  expect(await page.evaluate(() => (window as unknown as { __dz23Notifications: unknown[] }).__dz23Notifications.length)).toBe(1)
  expect(JSON.stringify(mutationBodies)).not.toMatch(/org_id|tenant_id|bootstrap_owner|"role"/u)

  const openPreview = page.getByRole('button', { name: 'Ver meu protótipo' })
  await expect(openPreview).toBeVisible()
  await openPreview.click()
  const previewFrameElement = page.getByTitle('Prévia isolada do protótipo')
  await expect(previewFrameElement).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin')
  await expect(page.getByText('Isto é uma prévia local. Seu aplicativo não foi publicado na internet.')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toHaveCount(0)
  const previewFrame = page.frameLocator('iframe[title="Prévia isolada do protótipo"]')
  await expect(previewFrame.getByRole('heading', { name: 'Protótipo E2E carregado' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('cliente@preview.local')).toBeVisible()
  await expect(page.getByText('482901')).toBeVisible()

  const studioSessionCookies = (await context.cookies('http://studio.dz23.localhost:4179'))
    .filter(cookie => cookie.name === 'dz23_studio_session')
  expect(studioSessionCookies).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: 'e2e', domain: 'studio.dz23.localhost' }),
    expect.objectContaining({ value: 'shadow', domain: '.dz23.localhost' }),
  ]))
  expect(studioSessionCookies).toHaveLength(2)

  const frameUrl = await previewFrameElement.getAttribute('src').then(src => new URL(src!, page.url()))
  const loadedPreviewFrame = page.frames().find(frame => frame !== page.mainFrame() && frame.url().includes('.dz23.localhost:4179/'))
  expect(loadedPreviewFrame).toBeDefined()
  expect(page.url()).not.toMatch(/[?&#]ticket=/iu)
  expect(frameUrl.href).not.toMatch(/[?&#]ticket=/iu)
  expect(loadedPreviewFrame!.url()).not.toMatch(/[?&#]ticket=/iu)
  expect(requestedUrls.every(url => !/[?&#]ticket=/iu.test(url))).toBe(true)
  await expect.poll(() => admissionPosts.length).toBe(1)
  expect(admissionPosts[0]).toEqual({ hasTicket: true, origin: frameUrl.origin, url: `${frameUrl.origin}/__dz23/admission` })
  await expect.poll(() => requestedUrls.some(url => new URL(url).pathname === '/__dz23/refresh')).toBe(true)
  await expect.poll(() => page.locator('iframe[aria-hidden="true"]').count(), { timeout: 7_000 }).toBe(0)

  const beforeForgery = admissionPosts.length
  await page.evaluate(previewOrigin => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Prévia isolada do protótipo"]')
    if (frame?.contentWindow == null) throw new Error('preview frame missing')
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://attacker.example', source: frame.contentWindow, data: { type: 'DZ23_PREVIEW_READY' },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      origin: previewOrigin, source: window, data: { type: 'DZ23_PREVIEW_READY' },
    }))
  }, frameUrl.origin)
  await page.waitForTimeout(100)
  expect(admissionPosts).toHaveLength(beforeForgery)

  await page.getByRole('button', { name: 'Encerrar prévia' }).click()
  await expect(previewFrameElement).toHaveCount(0)
  await expect(page.getByText('A prévia foi encerrada. O protótipo continua salvo no projeto.')).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
