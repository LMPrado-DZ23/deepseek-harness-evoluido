import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { INTAKE_ANSWERS, answerIntake } from './answering'

// O Studio instala um service worker, e requisição que passa por ele NÃO é
// interceptada por `page.route`: foi assim que a primeira versão deste teste
// mediu zero POSTs e concluiu, errado, que o botão não ficava ocupado.
test.use({ serviceWorkers: 'block' })

const origin = 'http://studio.dz23.localhost:4179'

/**
 * O botão do fluxo principal diz que está trabalhando — e para de aceitar clique.
 *
 * Nenhum botão do caminho Ideia → Perguntas → Plano → Criação avisava nada: a
 * pessoa apertava, ficava segundos sem resposta e apertava de novo. Em leitor
 * de tela, silêncio. Este teste ATRASA a resposta do servidor de propósito,
 * porque o defeito só existe enquanto a chamada está no ar.
 */
test('enquanto o Studio responde, o botão fica ocupado e o clique duplo não passa', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  let posts = 0
  await page.route('**/api/studio/apps/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts += 1
    await new Promise(resolve => setTimeout(resolve, 1_500))
    await route.fallback()
  })
  await page.goto('/studio/')
  await page.getByRole('textbox').first().fill('quero uma agenda para minha clínica marcar consultas')
  const button = page.getByRole('button', { name: 'Continuar' })
  await button.click()
  // O texto muda para o gerúndio, o botão fica desabilitado e `aria-busy` conta
  // a mesma coisa para quem ouve a tela em vez de olhar.
  const busy = page.getByRole('button', { name: 'Enviando sua ideia…' })
  await expect(busy).toBeDisabled()
  await expect(busy).toHaveAttribute('aria-busy', 'true')
  // Um segundo clique enquanto isso não pode virar um segundo projeto.
  await busy.click({ force: true, timeout: 2_000 }).catch(() => undefined)
  await expect.poll(() => posts, { timeout: 10_000 }).toBe(1)
})

/**
 * Recarregar DEPOIS que a criação termina.
 *
 * Guardar o projeto no endereço resolveu perder o trabalho — e criou um beco:
 * a tela restaurava só o projeto, o estado e o plano. Quem recarregava depois
 * da criação (e a própria tela MANDA recarregar quando perde o acompanhamento)
 * ficava com a coluna da direita dizendo "Protótipo verificado" e a da
 * esquerda VAZIA: sem os critérios, sem o relato, sem os pontos seguros e sem
 * o botão de ver o protótipo.
 */
test('depois de recarregar, o resultado da criação continua na tela', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await expect(page.getByText('As verificações declaradas passaram neste computador.')).toBeVisible({ timeout: 40_000 })
  expect(new URL(page.url()).searchParams.get('projeto')).not.toBeNull()

  await page.reload()

  await expect(page.getByText('As verificações declaradas passaram neste computador.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'O que aconteceu na criação' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Pontos para onde você pode voltar' })).toBeVisible()
  await expect(page.getByText('A página Início existe: Passou')).toBeVisible()
})

/**
 * "Ver meu protótipo" também é um pedido ao servidor.
 *
 * O commit anterior dizia "nenhum botão do fluxo principal manda pedido sem
 * avisar", e um auditor mostrou que a frase generalizava além do feito: dois
 * cliques em "Ver meu protótipo" mandavam DOIS `POST /previews`. Este teste
 * ATRASA a resposta, porque o defeito só existe enquanto a chamada está no ar.
 */
test('o botão de ver o protótipo fica ocupado, e o clique duplo não abre duas prévias', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  let previews = 0
  await page.route('**/previews', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    previews += 1
    await new Promise(resolve => setTimeout(resolve, 1_500))
    await route.fallback()
  })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await expect(page.getByRole('button', { name: 'Ver meu protótipo' })).toBeVisible({ timeout: 40_000 })

  await page.getByRole('button', { name: 'Ver meu protótipo' }).click()
  const busy = page.getByRole('button', { name: 'Abrindo o protótipo…' })
  await expect(busy).toBeDisabled()
  await expect(busy).toHaveAttribute('aria-busy', 'true')
  await busy.click({ force: true, timeout: 2_000 }).catch(() => undefined)
  await expect.poll(() => previews, { timeout: 10_000 }).toBe(1)
})

/**
 * Os três botões da tela das perguntas.
 *
 * Nenhum deles aparecia em teste nenhum do repositório: um auditor desfez um
 * dos três e a suíte inteira — 344 de unidade, 62 de navegador, axe incluído —
 * continuou verde. O que não é afirmado por teste não está corrigido; está
 * apenas escrito.
 */
test('os três botões da tela de perguntas avisam que estão trabalhando', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  let answers = 0
  await page.route('**/intake/answer', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    answers += 1
    await new Promise(resolve => setTimeout(resolve, 1_500))
    await route.fallback()
  })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()

  // "Não sei — recomende para mim" também é um pedido ao servidor.
  await page.getByRole('button', { name: 'Não sei — recomende para mim' }).click()
  const busy = page.getByRole('button', { name: 'Buscando uma recomendação…' })
  await expect(busy).toBeDisabled()
  await expect(busy).toHaveAttribute('aria-busy', 'true')
  await busy.click({ force: true, timeout: 2_000 }).catch(() => undefined)
  await expect.poll(() => answers, { timeout: 10_000 }).toBe(1)
})

/**
 * A criação DIZ o que está fazendo, em vez de mostrar um texto imóvel.
 *
 * O servidor grava um registro a cada mudança de etapa e a tela já lia esse
 * registro a cada 1,5 segundo — para jogar a etapa fora. Durante os minutos
 * mais longos do produto a pessoa via a mesma frase do começo ao fim e não
 * tinha como saber se alguma coisa estava andando.
 *
 * O teste FIXA a resposta do servidor em `RUNNING` na etapa de testes, em vez
 * de tentar pegar a execução no meio: com o construtor de fixture terminando em
 * milissegundos, esperar pelo instante certo seria uma corrida — o teste
 * reprovaria por relógio, e não por defeito.
 */
test('sem passos registrados, a tela ainda mostra a etapa em que está', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })

  let freeze = false
  await page.route('**/api/studio/apps/projects/*', async route => {
    if (route.request().method() !== 'GET' || !freeze) return route.fallback()
    // `route.fetch` corre no Node, e o Node NÃO resolve `*.localhost` como o
    // Chromium resolve. O endereço vai para o laço local; `127.0.0.1:4179` está
    // na lista de hosts aceitos do servidor de teste.
    const response = await route.fetch({ url: route.request().url().replace('studio.dz23.localhost', '127.0.0.1') })
    const body = await response.json() as { project: Record<string, unknown>; current_run: null | Record<string, unknown> }
    if (body.current_run !== null) {
      // O ESTADO DO PROJETO também é fixado. Sem isso o teste dependia de o
      // construtor de fixture ainda não ter terminado quando a primeira leitura
      // chega — e com a máquina carregada, na suíte inteira, ele já terminou: a
      // tela mostrava a verificação, não a criação. Era corrida, e reprovava por
      // relógio.
      body.project = { ...body.project, state: 'GENERATING' }
      body.current_run = { ...body.current_run, state: 'RUNNING', stage: 'test', attempt: 2 }
      // `steps` é APAGADO de propósito, e é isso que este teste passou a
      // guardar: a execução SEM passos registrados.
      //
      // O campo é opcional e a versão do domínio não sobe, então toda execução
      // gravada antes dele - e toda instalação que ainda não atualizou o
      // servidor - chega aqui sem ele. Quando há passos, a linha do tempo
      // substitui esta frase (mostrar as duas repetia a mesma palavra duas
      // vezes na tela). Quando não há, a frase da etapa é a ÚNICA coisa que
      // separa "trabalhando" de "travado" - e some-la seria deixar a tela
      // muda justamente para quem tem o servidor mais antigo.
      delete body.current_run.steps
    }
    await route.fulfill({ response, json: body })
  })

  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  freeze = true
  await page.getByRole('button', { name: 'Iniciar criação' }).click()

  const stage = page.locator('.creation-stage')
  await expect(stage).toBeVisible({ timeout: 20_000 })
  // Sem passos, NÃO há linha do tempo: a frase da etapa é o que sobra.
  await expect(page.locator('.build-steps')).toHaveCount(0)
  await expect(stage).toContainText('Rodando os testes')
  // A repetição é anunciada da SEGUNDA em diante: o tempo dobra, e o silêncio
  // parece travamento.
  await expect(stage).toContainText('2ª tentativa')
  // Quem ouve a tela recebe o mesmo aviso.
  await expect(stage).toHaveAttribute('aria-live', 'polite')
})


/**
 * A linha do tempo da construção.
 *
 * "A ideia desse projeto é ver a construção em tempo real", disse o Prado. A
 * tela mostrava UMA frase por etapa — `build` ou `test` — e o construtor roda
 * quatro passos dentro dessas duas: `install`, `build`, `test`, `e2e`. Durante
 * os minutos mais longos do produto a pessoa via um texto imóvel enquanto
 * quatro coisas diferentes aconteciam, e "trabalhando" e "travado" tinham a
 * mesma aparência.
 *
 * Mesma técnica do teste acima, e pelo mesmo motivo: a resposta é FIXADA no
 * meio da execução, porque o construtor de fixture termina em milissegundos e
 * esperar o instante certo seria uma corrida contra o relógio.
 */
test('durante a criação, a tela mostra cada passo do construtor', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })

  let freeze = false
  await page.route('**/api/studio/apps/projects/*', async route => {
    if (route.request().method() !== 'GET' || !freeze) return route.fallback()
    const response = await route.fetch({ url: route.request().url().replace('studio.dz23.localhost', '127.0.0.1') })
    const body = await response.json() as { project: Record<string, unknown>; current_run: null | Record<string, unknown> }
    if (body.current_run !== null) {
      body.project = { ...body.project, state: 'GENERATING' }
      body.current_run = {
        ...body.current_run, state: 'RUNNING', stage: 'build', attempt: 1,
        steps: [
          { step: 'install', state: 'PASSED', started_at: '2026-09-09T12:00:00.000Z', finished_at: '2026-09-09T12:00:07.000Z' },
          { step: 'build', state: 'RUNNING', started_at: '2026-09-09T12:00:07.000Z', finished_at: null },
        ],
      }
    }
    await route.fulfill({ response, json: body })
  })

  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  freeze = true
  await page.getByRole('button', { name: 'Iniciar criação' }).click()

  const steps = page.locator('.build-steps')
  await expect(steps).toBeVisible({ timeout: 20_000 })

  // Os QUATRO passos aparecem, e não só os que já começaram: quem espera
  // precisa saber quanto ainda falta, não só onde está.
  const items = steps.locator('li')
  await expect(items).toHaveCount(4)

  // O passo terminado traz o tempo que levou — é isso que separa "andando" de
  // "parado" quando a tela fica minutos na mesma etapa.
  await expect(items.nth(0)).toContainText('Buscando as peças')
  await expect(items.nth(0)).toContainText('concluído')
  await expect(items.nth(0)).toContainText('7s')

  await expect(items.nth(1)).toContainText('em andamento')
  // O que ainda não começou diz que ainda vai acontecer — e não fica em branco.
  await expect(items.nth(3)).toContainText('ainda vai acontecer')

  // O estado NUNCA é só cor: quem não distingue verde de vermelho, e quem ouve
  // a tela, recebem a mesma informação em palavras.
  await expect(steps.getByRole('list')).toHaveAttribute('aria-live', 'polite')

  // A varredura do fluxo principal NÃO passa por aqui: a linha do tempo só
  // existe com uma execução congelada no meio, e nenhum outro teste congela
  // uma. Sem esta chamada, a única tela que a pessoa encara por minutos seria
  // também a única que o axe nunca vê.
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  // E no escuro, onde a cor sozinha desaparece de vez.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(steps).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})
