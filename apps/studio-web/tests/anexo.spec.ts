import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/*
  O ANEXO de verdade, na tela montada (pedido do titular, 19/09/2026): o
  arquivo de texto entra no pedido, visível e editável, e o limite é o do
  servidor (10.000), e não os 1.000 que a tela cortava.
*/
test('um arquivo de texto anexado entra no pedido, e o pedido aceita mais de mil caracteres', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await page.goto('/studio/')
  const pedido = page.locator('#brief')
  await pedido.fill('Quero um catálogo com estes produtos')
  await page.locator('.dz-compositor input[type=file]').setInputFiles({ name: 'produtos.csv', mimeType: 'text/csv', buffer: Buffer.from('nome,preco\nBolo,20\nTorta,35\n') })
  await expect(pedido).toHaveValue('Quero um catálogo com estes produtos\n\n[Anexo: produtos.csv]\nnome,preco\nBolo,20\nTorta,35')
  await expect(page.getByRole('status').filter({ hasText: 'O conteúdo de produtos.csv entrou no pedido' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toBeVisible()

  await pedido.fill('x'.repeat(4_000))
  await expect(pedido).toHaveValue('x'.repeat(4_000))
  await expect(page.getByText('4000 de 10.000 caracteres')).toBeVisible()

  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations).toEqual([])
})
