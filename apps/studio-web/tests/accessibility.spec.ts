import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { INTAKE_ANSWERS, answerIntake } from './answering'
import { abrirDetalhamento, esperarResultado, fecharDetalhamento } from './resultado'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * O axe varria TRÊS telas do produto.
 *
 * A gaveta de navegação (só abaixo de 1024px), o painel de equipe e a tela do
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
    await expect(page.getByRole('heading', { name: 'O que posso fazer por você?' })).toBeVisible()
    await check('ideia')

    // O seletor de tipo é novo nesta tela e nunca tinha sido varrido. O texto é
    // o da sugestão porque o servidor de teste responde a este caminho — o que
    // está sob varredura aqui é a TELA, não o que o gerador faz com o texto.
    await page.getByRole('button', { name: 'Página de apresentação' }).click()
    await check('ideia-preenchida')

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
    await check('perguntas')

    await answerIntake(page, INTAKE_ANSWERS)
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.locator('.plan-list .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('plano')

    await page.getByRole('button', { name: 'Aprovar este plano' }).click()
    await expect(page.getByRole('button', { name: 'Iniciar criação' })).toBeVisible()
    await check('criacao')

    await page.getByRole('button', { name: 'Iniciar criação' }).click()
    // O resultado chega na CONVERSA; o detalhamento continua inteiro, atrás do
    // painel. `tests/resultado.ts` tem o mapa de equivalência.
    await esperarResultado(page)
    await check('conversa')
    await abrirDetalhamento(page)
    await check('detalhamento')
    await fecharDetalhamento(page)

    expect(violations, violations.join('\n')).toEqual([])
  })

  test('as Preferências abrem, passam no axe e NÃO oferecem controle do que não existe', async ({ page }) => {
    /*
      A decisão do proprietário proíbe botão mudo por escrito. O quadro F04 da
      referência mostra treze itens; aqui os que ainda não existem aparecem
      como TEXTO dizendo o que falta — e este teste confere no navegador que
      não há controle interativo dentro de uma seção indisponível.
    */
    await page.goto('/studio/')
    // Abaixo de 1024px o trilho sai do fluxo, e a conta mora no rodapé DELE: a
    // porta é o botão de menu. Sem isto, este teste provava as Preferências só
    // na mesa — e a referência é a mesma experiência adaptada, não outra.
    const menu = page.getByRole('button', { name: 'Abrir o menu', exact: true })
    if (await menu.isVisible()) await menu.click()
    await page.getByRole('button', { name: 'Preferências', exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Preferências' })
    await expect(modal).toBeVisible()

    const semViolacao = await new AxeBuilder({ page }).analyze()
    expect(semViolacao.violations.map(violation => violation.id)).toEqual([])

    // Uma seção que não existe: só a frase, nenhum controle.
    await modal.getByRole('button', { name: 'Tema', exact: true }).click()
    await expect(modal.getByText('Ainda não disponível')).toBeVisible()
    const corpo = modal.locator('.dz-preferencias-corpo')
    // O botão de fechar é o único controle do corpo nessa seção.
    await expect(corpo.locator('button, a, input, select, textarea')).toHaveCount(1)

    // Uma capacidade que EXISTE leva ao destino real, e não a "#".
    await modal.getByRole('button', { name: 'Habilidades', exact: true }).click()
    await expect(corpo.getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', '/studio/habilidades')

    // Esc fecha, e a tarefa e o rascunho continuam onde estavam.
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
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
  // T-22: o mesmo painel responde a pergunta que a pessoa realmente faz — e ele
  // responde "ninguém conferiu ainda", porque o endereço de saúde confere as
  // PEÇAS e não cria aplicativo nenhum para descobrir. Um verde aqui seria a
  // tela afirmando a cadeia inteira a partir das partes dela.
  await expect(page.getByText('O que dá para fazer agora')).toBeVisible()
  await expect(page.getByText('Criar um aplicativo: ninguém conferiu ainda.')).toBeVisible()
  await expect(page.getByText(/Nada foi criado ainda nesta instalação/u)).toBeVisible()
})

/**
 * O mesmo caminho, no MODO ESCURO.
 *
 * O produto tinha modo escuro só na tela do assistente: a conversa ficava
 * escura e agradável e, ao voltar para a home, a tela
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
    await expect(page.getByRole('heading', { name: 'O que posso fazer por você?' })).toBeVisible()
    await check('ideia')
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
    await check('perguntas')
    await answerIntake(page, INTAKE_ANSWERS)
    await page.getByRole('button', { name: 'Montar meu plano' }).click()
    await expect(page.locator('.plan-list .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('plano')
    // O fluxo escuro segue até o FIM: a primeira versão parava no plano, e a
    // criação, a verificação e o relato — as telas do pior momento — ficavam
    // sem varredura no escuro.
    await page.getByRole('button', { name: 'Aprovar este plano' }).click()
    await expect(page.getByRole('button', { name: 'Iniciar criação' })).toBeVisible()
    await check('criacao')
    await page.getByRole('button', { name: 'Iniciar criação' }).click()
    // O resultado chega na CONVERSA; o detalhamento continua inteiro, atrás do
    // painel. `tests/resultado.ts` tem o mapa de equivalência.
    await esperarResultado(page)
    await check('conversa')
    await abrirDetalhamento(page)
    await check('detalhamento')
    await fecharDetalhamento(page)

    await page.goto('/studio/ajuda')
    await expect(page.getByRole('heading', { name: 'Ajuda do DZ23 STUDIO' })).toBeVisible()
    await check('ajuda')
    // As telas que a primeira versão do tema escuro deixou brancas sobre
    // brancas. Elas ficam AQUI, e não numa lista à parte, porque foi
    // exatamente o "cobri o que me lembrei" que produziu a regressão.
    await page.goto('/studio/hub')
    await expect(page.locator('.hub-card').first()).toBeVisible({ timeout: 15_000 })
    await check('hub')
    await page.goto('/studio/progresso')
    await expect(page.locator('main, .team-panel, .task-card').first()).toBeVisible({ timeout: 15_000 })
    await check('equipe')
    expect(violations, violations.join('\n')).toEqual([])
  })
})
