import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * A tela não pode rolar para os LADOS.
 *
 * O grid de duas colunas pedia 948px de largura mínima e o layout só virava
 * coluna abaixo de 820px: entre um número e outro o corpo transbordava. Ninguém
 * via porque o tamanho "tablet" dos testes é 800px — 21px do lado seguro.
 */
test('nenhuma tela do fluxo rola para os lados', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  const overflow = async (screen: string) => {
    const measured = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }))
    expect(measured.scroll, `${screen}: ${measured.scroll}px de conteúdo em ${measured.inner}px de tela`).toBeLessThanOrEqual(measured.inner)
  }
  await page.goto('/studio/')
  await expect(page.getByRole('heading', { name: 'O que posso fazer por você?' })).toBeVisible()
  await overflow('ideia')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.getByRole('heading', { name: 'Só mais alguns detalhes' })).toBeVisible({ timeout: 15_000 })
  await overflow('perguntas')
  await page.goto('/studio/ajuda')
  await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
  await overflow('ajuda')
})
