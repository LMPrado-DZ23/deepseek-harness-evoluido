import AxeBuilder from '@axe-core/playwright'
import { expect, request as apiRequest, test } from '@playwright/test'

test('recusa interface e API sem sessão', async () => {
  const client = await apiRequest.newContext({ baseURL: 'http://127.0.0.1:4179' })
  expect((await client.get('/studio')).status()).toBe(401)
  expect((await client.get('/api/studio/apps/health')).status()).toBe(401)
  await client.dispose()
})

test('percorre as cinco etapas, muda privacidade e termina sem alegar publicação', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://127.0.0.1:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://127.0.0.1:4179' },
  ])
  await page.goto('/studio')
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
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
