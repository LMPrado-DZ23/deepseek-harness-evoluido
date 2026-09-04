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
  const status = await page.evaluate(async () => (await fetch('/api/studio/identity/magic/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', code: '123456', device_label: 'Chromium local' }),
  })).status)
  expect(status).toBe(200)
  const cookies = await context.cookies('http://studio.dz23.localhost:4179')
  expect(cookies).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'dz23_studio_session', value: 'session-token', domain: 'studio.dz23.localhost', httpOnly: true, secure: false }),
  ]))
  expect(cookies.some(cookie => cookie.name === 'dz23_studio_csrf')).toBe(false)
})

test('percorre as cinco etapas, muda privacidade e termina sem alegar publicação', async ({ context, page }) => {
  const admissionPosts: Array<{ readonly hasTicket: boolean; readonly origin: string; readonly url: string }> = []
  const requestedUrls: string[] = []
  page.on('request', request => {
    requestedUrls.push(request.url())
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
  ])
  await context.addInitScript(() => window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e'))
  const studioResponse = await page.goto('/studio')
  const studioPolicy = studioResponse?.headers()['content-security-policy'] ?? ''
  expect(studioPolicy).toContain('frame-src http://*.dz23.localhost:4179')
  expect(studioPolicy).toContain("frame-ancestors 'none'")
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
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await expect(page.getByText('VERIFIED_PROTOTYPE')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('não está publicado nem disponível para outras pessoas', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('page:Início: Passou')).toBeVisible()
  await expect(page.getByText('A navegação deve ser simples.: Não verificado automaticamente')).toBeVisible()

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
