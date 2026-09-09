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
