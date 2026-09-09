import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const origin = 'http://studio.dz23.localhost:4179'

/**
 * "Meus projetos" existia como item MUDO, marcado "em breve", enquanto
 * `GET /projects` já respondia no servidor. Faltava a tela — e sem ela quem
 * fechava o navegador no meio de uma criação não tinha caminho de volta pela
 * interface: o projeto continuava lá, inalcançável.
 */
test('a lista mostra o projeto criado e leva de volta para ele', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })

  // Um projeto de verdade, criado pela jornada — e não uma linha injetada.
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByLabel('Sua resposta').waitFor()

  await page.goto('/studio/projetos')
  await expect(page.getByRole('heading', { name: 'Meus projetos', level: 1 })).toBeVisible()

  // A situação aparece EM PORTUGUÊS. Um código de máquina aqui mandaria a
  // pessoa perguntar a alguém o que "DRAFT" quer dizer.
  //
  // `first()` porque a suíte inteira compartilha o mesmo espaço de trabalho: os
  // outros testes também criam projetos, e a lista os mostra todos. Exigir UM
  // resultado faria este teste depender da ordem de execução dos outros, que é
  // o tipo de amarra que reprova sozinha quando alguém acrescenta um caso.
  await expect(page.getByText('Respondendo as perguntas').first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText('DRAFT')

  const open = page.getByRole('link', { name: /^Abrir o projeto / }).first()
  await expect(open).toBeVisible()
  await open.click()
  // O endereço carrega o projeto: é o mesmo mecanismo da recarga.
  await expect(page).toHaveURL(/\/studio\/\?projeto=/u)
})

/**
 * A barra de navegação era da TELA INICIAL e de mais nenhuma.
 *
 * Quem clicava em "Ajuda", "Integrações" ou "Trabalho em equipe" caía numa
 * página sem barra lateral: sem saída, a não ser um link específico no meio do
 * conteúdo, quando havia. Num produto para quem não programa isso é um beco — a
 * pessoa vê a navegação, usa a navegação, e a navegação desaparece.
 */
test('as telas secundárias têm navegação, e ela leva de volta ao início', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])

  for (const path of ['/studio/ajuda', '/studio/projetos']) {
    await page.goto(path)
    const nav = page.getByRole('navigation')
    await expect(nav, path).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Início' }), path).toBeVisible()
  }

  await page.getByRole('navigation').getByRole('link', { name: 'Início' }).click()
  await expect(page).toHaveURL(/\/studio\/$/u)
  await expect(page.getByRole('heading', { name: 'Vamos criar seu aplicativo' })).toBeVisible()
})

test('"Meus projetos" deixou de ser um item mudo na navegação', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  await page.goto('/studio/')
  // Era um `<button disabled>` com "em breve" ao lado. Agora é um link.
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Meus projetos' })).toBeVisible()
})

test('a lista de projetos não tem violação de acessibilidade', async ({ context, page }) => {
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  await page.goto('/studio/projetos')
  await page.getByRole('heading', { name: 'Meus projetos', level: 1 }).waitFor()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('no escuro, a lista de projetos continua legível', async ({ browser }) => {
  // O modo escuro já produziu texto branco sobre fundo branco uma vez, quando o
  // bloco escuro era uma lista escrita à mão. Tela nova entra na varredura.
  const context = await browser.newContext({ colorScheme: 'dark' })
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  const page = await context.newPage()
  await page.goto('/studio/projetos')
  await page.getByRole('heading', { name: 'Meus projetos', level: 1 }).waitFor()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  await context.close()
})
