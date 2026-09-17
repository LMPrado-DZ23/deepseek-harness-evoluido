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
  /*
    MAPA DE EQUIVALÊNCIA: o título "Só mais alguns detalhes" era o herói do
    CARTÃO DE PERGUNTAS — uma tela própria, com caixa e título grandes, que a
    decisão de produto listou entre o que não pode voltar. A garantia que ele
    carregava era "enviar levou a pessoa adiante"; agora ela é afirmada pelo
    que de fato acontece: a CONVERSA abre, e a pergunta é um lance dela.
  */
  await expect(page.getByLabel('Conversa desta tarefa')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Para quem você quer criar este projeto?')).toBeVisible()
  await overflow('perguntas')
  await page.goto('/studio/ajuda')
  await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
  await overflow('ajuda')
})
