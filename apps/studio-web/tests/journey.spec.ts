import AxeBuilder from '@axe-core/playwright'
import { expect, request as apiRequest, test } from '@playwright/test'

test('recusa interface e API sem sessão', async () => {
  const client = await apiRequest.newContext({ baseURL: 'http://127.0.0.1:4179' })
  expect((await client.get('/studio')).status()).toBe(401)
  expect((await client.get('/api/studio/apps/health')).status()).toBe(401)
  await client.dispose()
})

test('percorre as cinco etapas, muda privacidade e termina sem alegar publicação', async ({ context, page }) => {
  const postedMessages: Array<{ readonly hasTicket: boolean; readonly targetOrigin: string; readonly receiverUrl: string }> = []
  const requestedUrls: string[] = []
  await context.exposeBinding('__recordDz23PostMessage', ({ frame }, payload: { hasTicket: boolean; targetOrigin: string }) => {
    postedMessages.push({ ...payload, receiverUrl: frame.url() })
  })
  await context.addInitScript(() => {
    type Recorder = (payload: { hasTicket: boolean; targetOrigin: string }) => Promise<void>
    const scope = globalThis as typeof globalThis & { __recordDz23PostMessage: Recorder }
    const original = window.postMessage
    window.postMessage = function (...args: Parameters<Window['postMessage']>): void {
      const message = args[0]
      const target = args[1]
      const targetOrigin = typeof target === 'string' ? target : target.targetOrigin
      const hasTicket = typeof message === 'object' && message !== null && 'ticket' in message
      void scope.__recordDz23PostMessage({ hasTicket, targetOrigin })
      Reflect.apply(original, this, args)
    } as Window['postMessage']
  })
  page.on('request', request => requestedUrls.push(request.url()))
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://127.0.0.1:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://127.0.0.1:4179' },
  ])
  const studioResponse = await page.goto('/studio')
  const studioPolicy = studioResponse?.headers()['content-security-policy'] ?? ''
  expect(studioPolicy).toContain('frame-src http://*.localhost:4179')
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

  const frameUrl = await previewFrameElement.getAttribute('src').then(src => new URL(src!, page.url()))
  const loadedPreviewFrame = page.frames().find(frame => frame !== page.mainFrame() && frame.url().includes('.localhost:4179/'))
  expect(loadedPreviewFrame).toBeDefined()
  expect(page.url()).not.toMatch(/[?&#]ticket=/iu)
  expect(frameUrl.href).not.toMatch(/[?&#]ticket=/iu)
  expect(loadedPreviewFrame!.url()).not.toMatch(/[?&#]ticket=/iu)
  expect(requestedUrls.every(url => !/[?&#]ticket=/iu.test(url))).toBe(true)
  await expect.poll(() => postedMessages.filter(message => message.hasTicket).length).toBe(1)
  const ticketPost = postedMessages.find(message => message.hasTicket)!
  expect(ticketPost.targetOrigin).toBe(frameUrl.origin)
  expect(new URL(ticketPost.receiverUrl).origin).toBe(frameUrl.origin)

  const beforeForgery = postedMessages.filter(message => message.hasTicket).length
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
  expect(postedMessages.filter(message => message.hasTicket)).toHaveLength(beforeForgery)

  await page.getByRole('button', { name: 'Encerrar prévia' }).click()
  await expect(previewFrameElement).toHaveCount(0)
  await expect(page.getByText('A prévia foi encerrada. O protótipo continua salvo no projeto.')).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
