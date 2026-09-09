import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * O produto é para quem não programa e usa vocabulário próprio o tempo todo.
 * O ícone de ajuda existia e estava DESLIGADO: não havia, em lugar nenhum do
 * aplicativo, onde descobrir o que "protótipo", "prévia local" ou "ponto
 * seguro" querem dizer.
 */
test('a ajuda abre pela barra de navegação e explica o vocabulário do produto', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  await page.goto('/studio/')
  await page.getByRole('link', { name: 'Ajuda' }).click()
  await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
  // As palavras que a interface usa e ninguém explicava.
  for (const term of ['Protótipo', 'Prévia local', 'Ponto seguro', 'Ambiente isolado', 'Perfil de privacidade', 'Limite de gasto']) {
    await expect(page.getByRole('definition').filter({ hasText: '' }).first()).toBeVisible()
    await expect(page.getByText(term, { exact: true }).first()).toBeVisible()
  }
  // E a ajuda não pode contradizer o resto do produto.
  await expect(page.getByText('Não publica seu aplicativo na internet.', { exact: false })).toBeVisible()
  await expect(page.getByText(/\bpront[oa]s?\b/iu)).toHaveCount(0)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  await page.getByRole('link', { name: 'Voltar ao início' }).click()
  await expect(page.getByRole('heading', { name: 'Vamos criar seu aplicativo' })).toBeVisible()
})
