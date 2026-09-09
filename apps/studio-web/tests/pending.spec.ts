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
