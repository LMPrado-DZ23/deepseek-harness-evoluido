import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'
const TEAM = '11111111-2222-4333-8444-555555555555'

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await page.addInitScript(() => {
    window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e')
  })
  // A equipe de exemplo volta ao estado inicial: o teste que a interrompe não
  // pode decidir o resultado dos que rodam depois dele.
  await page.request.get('http://127.0.0.1:4179/e2e/reset-team')
})

/**
 * O painel do trabalho em equipe, num navegador de verdade e nos três tamanhos.
 *
 * Por que num navegador: contraste, foco e nome acessível só existem quando a
 * página é PINTADA. Foi assim que um aviso da PWA passou meses com contraste de
 * 1,24:1 - o teste de componente lia o HTML e nunca a cor.
 */
test('a tela de progresso mostra a árvore, a evidência e o que travou', async ({ page }) => {
  await page.goto(`/studio/progresso/${TEAM}`)

  await expect(page.getByRole('heading', { name: 'Arrumar o formulário de cadastro' })).toBeVisible()
  await expect(page.getByText('Precisa de você')).toBeVisible()

  // A árvore: as três etapas, e de quem cada uma depende ESCRITO, porque o
  // recuo não existe para quem usa leitor de tela.
  await expect(page.getByText('Escrever o formulário')).toBeVisible()
  await expect(page.getByText('Revisar o formulário')).toBeVisible()
  await expect(page.getByText('Testar o formulário')).toBeVisible()
  await expect(page.getByText('Não depende de nenhuma outra etapa.')).toBeVisible()
  await expect(page.getByText('Depende de: implementar')).toBeVisible()
  await expect(page.getByText('Depende de: revisar')).toBeVisible()

  // O que travou é ANUNCIADO, não só pintado de vermelho.
  await expect(page.getByRole('alert').filter({ hasText: 'Esta etapa parou e espera você' })).toBeVisible()
  await expect(page.getByText('A revisão parou porque o projeto mudou embaixo dela.')).toBeVisible()

  // O consumo é PARCIAL: uma etapa mediu, a outra rodou num agente externo e
  // não mediu. A tela tem de dizer que o número é MENOR que o real.
  const parcial = page.getByRole('alert').filter({ hasText: 'MENOR do que o consumo real' })
  await expect(parcial).toBeVisible()
  await expect(parcial).toContainText('4.200')
  await expect(parcial).toContainText('1 de 2')

  // A evidência de quem rodou, e a ausência dela em quem não rodou.
  const evidencia = page.locator('.team-task-evidence').first()
  await evidencia.locator('summary').click()
  await expect(evidencia.getByText('1 arquivo(s) mudado(s), 2048 caracteres')).toBeVisible()
  await expect(evidencia.getByText('src/cadastro.tsx')).toBeVisible()

  // Nenhum caminho absoluto do computador de quem hospeda chega à tela.
  expect(await page.locator('main').innerText()).not.toMatch(/[A-Za-z]:\\|\/home\/|\/var\/lib\//u)
})

test('parar interrompe o trabalho, e depois o botão não promete o que não faz', async ({ page }) => {
  await page.goto(`/studio/progresso/${TEAM}`)
  const parar = page.getByRole('button', { name: 'Parar este trabalho' })
  await expect(parar).toBeEnabled()
  await page.getByLabel('Por que está parando (opcional)').fill('errei o pedido')
  await parar.click()
  await expect(page.locator('.error')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByText('Interrompido')).toBeVisible()
  // Um botão que continua clicável depois do fim prometeria uma parada que não
  // tem mais o que parar.
  await expect(parar).toBeDisabled()
})

test('a tela de progresso não tem violação de acessibilidade', async ({ page }) => {
  await page.goto(`/studio/progresso/${TEAM}`)
  await expect(page.getByRole('heading', { name: 'O que está acontecendo' })).toBeVisible()
  // Os detalhes são ABERTOS antes da análise: conteúdo dentro de um `<details>`
  // fechado não é pintado, e o axe não teria o que reprovar.
  for (const summary of await page.locator('details > summary').all()) await summary.click()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('a lista leva ao painel, e a navegação leva à lista', async ({ page }) => {
  await page.goto('/studio/progresso')
  await page.getByRole('link', { name: 'Arrumar o formulário de cadastro' }).click()
  await expect(page).toHaveURL(new RegExp(`/studio/progresso/${TEAM}$`, 'u'))
  await page.getByRole('link', { name: 'Ver todos os trabalhos' }).click()
  await expect(page).toHaveURL(/\/studio\/progresso$/u)
})
