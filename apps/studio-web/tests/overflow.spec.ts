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
  await expect(page.getByRole('heading', { name: 'Ajuda do FRIGG' })).toBeVisible()
  await overflow('ajuda')
})

/**
 * A conversa não pode ser espremida para fora da tela.
 *
 * Medido em 20/09/2026 no Chrome do titular: notebook com escala de 150%,
 * 1280×495 de área útil. As ações, o cartão da parada de emergência e o
 * compositor ficavam fixos abaixo da conversa, e ela ficava com 32px.
 */
test.describe('tela baixa', () => {
// O worker da casca responderia antes da rota simulada: aqui ele fica de fora.
test.use({ serviceWorkers: 'block' })

test('numa tela baixa a conversa continua legível', async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 495 })
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  // O servidor de e2e não monta a parada; aqui ela responde "funcionando",
  // que é o estado de todo dia — e o único em que o cartão encolhe.
  await page.route('**/api/studio/apps/emergency-stop', rota => rota.fulfill({ json: { emergency_stop: {
    stopped: false, engaged_by: null, engaged_at: null, reason: null, released_by: null, released_at: null, release_reason: null,
  } } }))
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  const conversa = page.getByLabel('Conversa desta tarefa')
  await expect(conversa).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.emergency-stop')).toBeVisible()
  const altura = await conversa.evaluate(elemento => elemento.getBoundingClientRect().height)
  expect(altura, `a conversa ficou com ${Math.round(altura)}px`).toBeGreaterThanOrEqual(150)
  // O compositor nunca sai da tela: é por ele que a pessoa continua.
  const compositor = await page.locator('#dz-continuar').evaluate(elemento => {
    const caixa = elemento.getBoundingClientRect()
    return { topo: caixa.top, base: caixa.bottom, tela: window.innerHeight }
  })
  expect(compositor.base, 'o compositor saiu da tela').toBeLessThanOrEqual(compositor.tela)
  expect(compositor.topo).toBeGreaterThan(0)
  // O botão de parar continua ao alcance, na versão de uma linha.
  // Ao abrir, a pessoa está no FIM da tarefa: o botão de parar aparece
  // inteiro — estar na tela não basta, o compositor preso embaixo pode estar
  // POR CIMA dele.
  const parar = page.locator('.emergency-stop-compacto .emergency-danger')
  const livre = () => parar.evaluate(botao => {
    const caixa = botao.getBoundingClientRect()
    const noPonto = document.elementFromPoint(caixa.left + caixa.width / 2, caixa.top + caixa.height / 2)
    return noPonto !== null && botao.contains(noPonto)
  })
  await expect.poll(livre).toBe(true)
  // E a coluna rola com a RODA do mouse, como a pessoa faz — rolar por código
  // passaria mesmo numa coluna que não rola.
  const coluna = page.locator('.dz-tarefa-conversa')
  const antes = await coluna.evaluate(elemento => elemento.scrollTop)
  expect(antes, 'nesta altura a coluna precisa rolar').toBeGreaterThan(0)
  const caixa = (await page.locator('.dz-compositor-inferior').boundingBox())!
  await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + 10)
  await page.mouse.wheel(0, -2_000)
  await expect.poll(() => coluna.evaluate(elemento => elemento.scrollTop)).toBeLessThan(antes)
  // Rolado para cima, o compositor continua preso embaixo e livre.
  const livreNaTela = (seletor: string) => page.locator(seletor).first().evaluate(elemento => {
    const caixa = elemento.getBoundingClientRect()
    if (caixa.bottom > window.innerHeight || caixa.top < 0) return false
    const noPonto = document.elementFromPoint(caixa.left + caixa.width / 2, caixa.top + caixa.height / 2)
    return noPonto !== null && elemento.contains(noPonto)
  })
  await expect.poll(() => livreNaTela('#dz-continuar')).toBe(true)
  // A oferta de instalar, quando aparece, não cobre o botão de enviar.
  await page.evaluate(() => {
    const evento = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(evento, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'dismissed' }) })
    window.dispatchEvent(evento)
  })
  await expect(page.locator('.pwa-install')).toBeVisible()
  await expect.poll(() => livreNaTela('.dz-compositor-inferior .dz-enviar-redondo')).toBe(true)
  // Nem encosta no compositor: no Chrome do titular, com o compositor mais
  // alto, ela caía exatamente em cima do botão de enviar.
  const sobrepoe = await page.evaluate(() => {
    const compositor = document.querySelector('.dz-compositor-inferior')!.getBoundingClientRect()
    return [...document.querySelectorAll('.pwa-install, .pwa-install-dismiss')].some(oferta => {
      const caixa = oferta.getBoundingClientRect()
      return caixa.left < compositor.right && caixa.right > compositor.left && caixa.top < compositor.bottom && caixa.bottom > compositor.top
    })
  })
  expect(sobrepoe, 'a oferta de instalar ficou por cima do compositor').toBe(false)
})
})
