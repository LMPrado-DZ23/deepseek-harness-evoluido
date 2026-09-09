import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  await page.goto('/studio/')
})

/**
 * Abaixo de 820px a barra lateral é `display:none` e o botão de menu era mudo:
 * no telefone o produto ficava SEM NAVEGAÇÃO, e a tela onde a pessoa autoriza
 * uma ação sensível só era alcançável digitando o endereço.
 *
 * Isto roda nos três tamanhos de propósito. No tamanho de mesa a gaveta nem
 * aparece, e é justamente por isso que o defeito passou despercebido: havia um
 * único Chromium de mesa e nada mais.
 */
test('a navegação existe e leva à conversa, em qualquer tamanho de tela', async ({ page }, testInfo) => {
  const narrow = (page.viewportSize()?.width ?? 1280) <= 820
  const menu = page.getByRole('button', { name: 'Menu', exact: true })

  if (narrow) {
    // A barra some, então o botão do menu é a ÚNICA porta.
    await expect(page.locator('aside#studio-nav')).toBeHidden()
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(menu).toHaveAttribute('aria-controls', 'studio-nav')
    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
  } else {
    await expect(menu).toBeHidden()
  }

  const conversation = page.getByRole('link', { name: 'Conversar com o DZ23' })
  await expect(conversation).toBeVisible()
  await expect(conversation).toHaveAttribute('href', '/studio/assistente')
  await expect(page.getByRole('link', { name: 'Integrações' })).toBeVisible()

  // A afirmação AQUI virou de lado, e a inversão é a correção.
  //
  // Este teste exigia que "em breve" estivesse VISÍVEL: era o jeito de provar
  // que um item sem tela aparecia como indisponível em vez de virar botão mudo.
  // Só que o Prado leu a etiqueta pelo que ela diz de verdade - "este produto
  // não está pronto" -, e ele estava certo. Os dois últimos itens sem destino
  // foram embora: "Meus projetos" ganhou tela, e "Ver resultado" não precisava
  // de uma, porque o resultado é o pé da tela inicial.
  //
  // Agora o teste guarda o outro lado: nenhum item morto pode voltar sem
  // alguém reprovar aqui primeiro.
  await expect(page.getByText('em breve')).toHaveCount(0)
  await expect(page.locator('nav button[disabled]')).toHaveCount(0)

  await conversation.click()
  await expect(page).toHaveURL(/\/studio\/assistente$/u)
  testInfo.annotations.push({ type: 'tamanho', description: `${String(page.viewportSize()?.width)}px` })
})

test('a gaveta fecha pelo Escape, pelo fundo e pelo botão, devolvendo o foco', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 820, 'A gaveta só existe abaixo de 820px.')
  const menu = page.getByRole('button', { name: 'Menu', exact: true })

  await menu.click()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  // Sem devolver o foco, quem navega por teclado é largado no começo da página.
  await expect(menu).toBeFocused()

  await menu.click()
  await page.getByRole('button', { name: 'Fechar menu' }).click()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')

  await menu.click()
  // Tocar FORA da gaveta, como a pessoa faz: no centro da tela o toque cai
  // sobre a própria gaveta, que ocupa min(84vw, 300px) a partir da esquerda.
  const width = page.viewportSize()?.width ?? 0
  await expect(page.locator('.drawer-scrim')).toBeVisible()
  await page.mouse.click(width - 8, 12)
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
})

test('a gaveta aberta não tem violação de acessibilidade', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) > 820, 'A gaveta só existe abaixo de 820px.')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(scan.violations.map(violation => violation.id)).toEqual([])
})
