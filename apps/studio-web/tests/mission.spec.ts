import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * Devolve o objetivo de prova ao estado inicial.
 *
 * Sem isto, o teste que marca como terminado deixaria os outros tamanhos de
 * tela sem o botão — e eles reprovariam pela ORDEM em que rodaram, e não por um
 * defeito.
 */
async function reset(page: import('@playwright/test').Page): Promise<void> {
  await page.request.get('http://127.0.0.1:4179/e2e/reset-mission')
}

async function signedIn(context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
}

/**
 * O objetivo reúne vários trabalhos sob a mesma meta e carrega a lista do que
 * precisa estar comprovado antes de ser dado por encerrado.
 *
 * O que este teste protege é a distinção que mais se perde: "ainda sem prova" e
 * "parado por alguém de fora" são coisas DIFERENTES. Uma pede trabalho, a outra
 * pede outra pessoa — e juntá-las num "pendente" manda quem lê a tela tentar a
 * coisa errada.
 */
test('a tela mostra o que falta, e separa falta de trabalho de falta de gente', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await expect(page.getByRole('heading', { name: 'Objetivos', level: 1 })).toBeVisible()
  await expect(page.getByText('Colocar o site no ar para os clientes')).toBeVisible()

  // As duas situações aparecem EM PORTUGUÊS, e são frases distintas. Um código
  // de máquina aqui mandaria a pessoa perguntar a alguém o que significa.
  await expect(page.getByText('Comprovado', { exact: true })).toBeVisible()
  await expect(page.getByText('Parado por alguém de fora')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('BLOCKED_EXTERNAL')
  await expect(page.locator('body')).not.toContainText('UNPROVEN')

  // Quem está esperando alguém de fora vê DE QUEM depende.
  await expect(page.getByText('a empresa que registra o endereço')).toBeVisible()
  // E quem já provou vê ONDE está a prova: um item que se diz comprovado sem
  // mostrar a prova é a mesma coisa que não estar comprovado.
  await expect(page.getByText('Teste de envio gravado em 08/09')).toBeVisible()
})

/**
 * Marcar como terminado e encerrar são gestos DIFERENTES, e a tela não os
 * mistura: o primeiro é a pessoa dizendo que acredita ter acabado, o segundo é
 * a conferência item a item — que aqui recusa, porque um item está parado.
 */
test('marcar como terminado não encerra: o encerramento confere e recusa, dizendo o que falta', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await page.getByRole('heading', { name: 'Objetivos', level: 1 }).waitFor()

  await page.getByRole('button', { name: 'Marcar como terminado' }).click()
  await expect(page.getByText('Marcado como terminado, aguardando conferência')).toBeVisible()

  // Agora o outro gesto aparece — e ele NÃO some por causa do item parado:
  // esconder o botão trocaria uma recusa explicada por um botão que sumiu sem
  // motivo visível.
  const encerrar = page.getByRole('button', { name: 'Encerrar objetivo' })
  await expect(encerrar).toBeVisible()
  await encerrar.click()

  // A recusa do servidor chega inteira à tela: é nela que está o que falta.
  const aviso = page.getByRole('alert')
  await expect(aviso).toBeVisible()
  await expect(aviso).toContainText('dominio')
})

test('"Objetivos" é um link de verdade na navegação, e leva à tela', async ({ context, page }) => {
  await signedIn(context)
  await page.goto('/studio/')
  // Abaixo de 820px a barra vira gaveta e o botão do menu é a ÚNICA porta —
  // é por isso que este teste roda nos quatro tamanhos, e não só no de mesa.
  if ((page.viewportSize()?.width ?? 1280) <= 820) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
  }
  const item = page.getByRole('navigation').getByRole('link', { name: 'Objetivos' })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(/\/studio\/objetivos$/u)
})

test('a tela de objetivos não tem violação de acessibilidade', async ({ context, page }) => {
  await signedIn(context)
  await reset(page)
  await page.goto('/studio/objetivos')
  await page.getByRole('heading', { name: 'Objetivos', level: 1 }).waitFor()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('no escuro, a tela de objetivos continua legível', async ({ browser }) => {
  // O modo escuro já produziu texto branco sobre fundo branco uma vez. Tela
  // nova entra na varredura, e não depois.
  const context = await browser.newContext({ colorScheme: 'dark' })
  await signedIn(context)
  const page = await context.newPage()
  await reset(page)
  await page.goto('/studio/objetivos')
  await page.getByRole('heading', { name: 'Objetivos', level: 1 }).waitFor()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  await context.close()
})
