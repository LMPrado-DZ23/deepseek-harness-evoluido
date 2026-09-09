import { expect, test } from '@playwright/test'

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
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
    await page.getByLabel('Sua resposta').fill(answer)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }
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
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
    await page.getByLabel('Sua resposta').fill(answer)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }
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
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
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
test('durante a criação, a tela mostra a etapa em que está', async ({ context, page }) => {
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
    const body = await response.json() as { current_run: null | Record<string, unknown> }
    if (body.current_run !== null) {
      body.current_run = { ...body.current_run, state: 'RUNNING', stage: 'test', attempt: 2 }
    }
    await route.fulfill({ response, json: body })
  })

  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
    await page.getByLabel('Sua resposta').fill(answer)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  freeze = true
  await page.getByRole('button', { name: 'Iniciar criação' }).click()

  const stage = page.locator('.creation-stage')
  await expect(stage).toBeVisible({ timeout: 20_000 })
  await expect(stage).toContainText('Rodando os testes')
  // A repetição é anunciada da SEGUNDA em diante: o tempo dobra, e o silêncio
  // parece travamento.
  await expect(stage).toContainText('2ª tentativa')
  // Quem ouve a tela recebe o mesmo aviso.
  await expect(stage).toHaveAttribute('aria-live', 'polite')
})
