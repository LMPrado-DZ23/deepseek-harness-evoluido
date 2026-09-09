import { expect, test } from '@playwright/test'

const IDEIA = 'quero um catalogo para mostrar meus bolos com foto e preco'

async function login(context: import('@playwright/test').BrowserContext) {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: 'http://studio.dz23.localhost:4179' },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: 'http://studio.dz23.localhost:4179' },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
}

async function conta(page: import('@playwright/test').Page, etapa: string) {
  const painel = (await page.locator('.idea-panel').innerText()).replace(/\s+/gu, ' ')
  const progresso = (await page.locator('.progress, aside, .steps').first().innerText().catch(() => '')).replace(/\s+/gu, ' ')
  console.log(`\n### ${etapa}\nURL: ${page.url()}\nESQUERDA: ${painel.slice(0, 500)}\nDIREITA: ${progresso.slice(0, 300)}`)
}

async function ateOPlano(page: import('@playwright/test').Page) {
  await page.locator('#brief').fill(IDEIA)
  await page.getByRole('button', { name: 'Continuar' }).click()
  for (const r of ['Meus clientes', 'Ver os bolos e o preco', 'Foto nome e preco']) {
    await page.getByLabel('Sua resposta').fill(r)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await expect(page.getByRole('button', { name: 'Aprovar este plano' })).toBeVisible({ timeout: 20_000 })
}

test('recarga em cada etapa', async ({ context, page }) => {
  await login(context)
  await page.goto('/studio/')
  await page.locator('#brief').fill(IDEIA)
  await expect(page.locator('.kind select')).toHaveValue('catalog')
  await conta(page, 'A) ideia escrita, antes')
  await page.reload()
  await conta(page, 'A) ideia escrita, DEPOIS da recarga')

  await page.locator('#brief').fill(IDEIA)
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.getByLabel('Sua resposta')).toBeVisible({ timeout: 15_000 })
  await conta(page, 'B) perguntas, antes')
  await page.reload()
  await page.waitForTimeout(1500)
  await conta(page, 'B) perguntas, DEPOIS da recarga')

  await page.goto('/studio/')
  await ateOPlano(page)
  await conta(page, 'C) plano proposto, antes')
  await page.reload()
  await page.waitForTimeout(1500)
  await conta(page, 'C) plano proposto, DEPOIS da recarga')

  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await expect(page.getByRole('button', { name: 'Iniciar criação' })).toBeVisible()
  await conta(page, 'D) plano aprovado, antes')
  await page.reload()
  await page.waitForTimeout(1500)
  await conta(page, 'D) plano aprovado, DEPOIS da recarga')
})

test('recarga depois que a criacao terminou', async ({ context, page }) => {
  await login(context)
  await page.goto('/studio/')
  await ateOPlano(page)
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await expect(page.getByRole('heading', { name: 'Resultado da verificação' })).toBeVisible({ timeout: 40_000 })
  await conta(page, 'E) criacao terminada, antes')
  await page.reload()
  await page.waitForTimeout(2500)
  await conta(page, 'E) criacao terminada, DEPOIS da recarga')
  console.log('TRUTH depois da recarga: ' + JSON.stringify(await page.locator('p.truth').allInnerTexts()))
  console.log('BOTOES depois da recarga: ' + JSON.stringify(await page.locator('.idea-panel button').allInnerTexts()))
  console.log('PROGRESSO depois da recarga: ' + (await page.locator('.progress-panel').innerText()).replace(/\s+/gu, ' '))
})
