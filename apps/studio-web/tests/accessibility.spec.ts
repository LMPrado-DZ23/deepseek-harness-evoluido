import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * O axe varria TRÊS telas do produto.
 *
 * A gaveta de navegação (só abaixo de 820px), o painel de equipe e a tela do
 * plano — esta última só no tamanho de mesa e com o viewport forçado a 390px.
 * Ficavam de fora, em todo tamanho: a tela da Ideia (campo de texto, sete
 * sugestões, quatro cartões de aparência, o `fieldset` de privacidade e agora o
 * seletor de tipo), a tela de Perguntas e a tela de Verificação com a lista de
 * conferências. São as telas por onde TODA pessoa passa.
 *
 * Este arquivo varre o caminho inteiro, e roda nos três tamanhos.
 */
test.use({ serviceWorkers: 'block' })

test.describe('acessibilidade do fluxo principal', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      { name: 'dz23_studio_session', value: 'e2e', url: origin },
      { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
    ])
    await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  })

  test('a ideia, as perguntas, o plano e a verificação passam no axe', async ({ page }, testInfo) => {
    const violations: string[] = []
    const check = async (screen: string) => {
      const result = await new AxeBuilder({ page }).analyze()
      for (const violation of result.violations) {
        violations.push(`${testInfo.project.name}/${screen}: ${violation.id} (${violation.nodes.length}) ${violation.nodes[0]?.html ?? ''}`)
      }
    }

    await page.goto('/studio/')
    await expect(page.getByRole('heading', { name: 'Vamos criar seu aplicativo' })).toBeVisible()
    await check('ideia')

    // O seletor de tipo é novo nesta tela e nunca tinha sido varrido. O texto é
    // o da sugestão porque o servidor de teste responde a este caminho — o que
    // está sob varredura aqui é a TELA, não o que o gerador faz com o texto.
    await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
    await check('ideia-preenchida')

    await page.getByRole('button', { name: 'Continuar' }).click()
    await expect(page.getByRole('heading', { name: 'Só mais alguns detalhes' })).toBeVisible({ timeout: 15_000 })
    await check('perguntas')

    for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
      await page.getByLabel('Sua resposta').fill(answer)
      await page.getByRole('button', { name: 'Responder e continuar' }).click()
    }
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.locator('.plan-list .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('plano')

    await page.getByRole('button', { name: 'Aprovar este plano' }).click()
    await expect(page.getByRole('button', { name: 'Iniciar criação' })).toBeVisible()
    await check('criacao')

    await page.getByRole('button', { name: 'Iniciar criação' }).click()
    await expect(page.getByText('As verificações declaradas passaram neste computador.')).toBeVisible({ timeout: 40_000 })
    await check('verificacao')
    await expect(page.getByRole('heading', { name: 'O que aconteceu na criação' })).toBeVisible({ timeout: 20_000 })
    await check('relato')

    expect(violations, violations.join('\n')).toEqual([])
  })

  test('a ajuda passa no axe em qualquer tamanho', async ({ page }) => {
    await page.goto('/studio/ajuda')
    await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
    const result = await new AxeBuilder({ page }).analyze()
    expect(result.violations).toEqual([])
  })
})

/**
 * O estado do Studio era um botão que não fazia nada, e a visita começava com
 * um alarme que ninguém tinha medido.
 */
test('o estado do Studio começa neutro e abre o que está em atenção', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  // Antes de `/health` responder, a tela não pode acusar "Atenção".
  await page.route('**/api/studio/apps/health', async route => {
    await new Promise(resolve => setTimeout(resolve, 1_200))
    await route.fallback()
  })
  await page.goto('/studio/')
  await expect(page.getByRole('button', { name: /Verificando/u })).toBeVisible()
  // Depois da resposta, o botão ABRE o detalhe dos três campos que decidem o
  // estado — antes ele recebia foco, era anunciado como botão e não fazia nada.
  const status = page.locator('.status-wrap button')
  await expect(status).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 })
  await status.click()
  await expect(status).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('O que o Studio está conferindo')).toBeVisible()
  await expect(page.getByText(/inteligência artificial:/u)).toBeVisible()
  await expect(page.getByText(/Ambiente isolado de criação:/u)).toBeVisible()
  await expect(page.getByText(/Espaço em disco:/u)).toBeVisible()
})

/**
 * O mesmo caminho, no MODO ESCURO.
 *
 * O produto tinha modo escuro só na tela do assistente: a conversa ficava
 * escura e agradável e, ao voltar para "Vamos criar seu aplicativo", a tela
 * disparava branco puro. Além do susto à noite, meio-tema é onde nascem os
 * contrastes impossíveis — e é o axe que diz se algum sobrou.
 */
test.describe('o mesmo fluxo no modo escuro', () => {
  test.use({ colorScheme: 'dark' })

  test('as telas do fluxo passam no axe com o sistema em modo escuro', async ({ context, page }, testInfo) => {
    await context.addCookies([
      { name: 'dz23_studio_session', value: 'e2e', url: origin },
      { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
    ])
    await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
    const violations: string[] = []
    const check = async (screen: string) => {
      const result = await new AxeBuilder({ page }).analyze()
      for (const violation of result.violations) {
        for (const node of violation.nodes) {
          violations.push(`${testInfo.project.name}/escuro/${screen}: ${violation.id} ${node.html.slice(0, 110)} ${node.any.map(item => JSON.stringify(item.data)).join(' ')}`)
        }
      }
    }
    await page.goto('/studio/')
    await expect(page.getByRole('heading', { name: 'Vamos criar seu aplicativo' })).toBeVisible()
    await check('ideia')
    await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
    await page.getByRole('button', { name: 'Continuar' }).click()
    await expect(page.getByRole('heading', { name: 'Só mais alguns detalhes' })).toBeVisible({ timeout: 15_000 })
    await check('perguntas')
    for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
      await page.getByLabel('Sua resposta').fill(answer)
      await page.getByRole('button', { name: 'Responder e continuar' }).click()
    }
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.locator('.plan-list .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('plano')
    await page.goto('/studio/ajuda')
    await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
    await check('ajuda')
    expect(violations, violations.join('\n')).toEqual([])
  })
})
