import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
const origin = 'http://studio.dz23.localhost:4179'

test.use({ colorScheme: 'dark' })

test('telas que o e2e nao varre no escuro', async ({ context, page }) => {
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  const achados: string[] = []
  const check = async (tela: string) => {
    const r = await new AxeBuilder({ page }).analyze()
    for (const v of r.violations) for (const n of v.nodes) achados.push(`${tela}: ${v.id} :: ${n.html.slice(0, 130)} :: ${n.any.map(a => JSON.stringify(a.data)).join(' ')}`)
  }
  for (const [tela, url] of [['hub', '/studio/hub'], ['equipe', '/studio/progresso'], ['assistente', '/studio/conversa']] as const) {
    await page.goto(url)
    await page.waitForTimeout(1200)
    await check(tela)
  }
  // fluxo ate a verificacao + relato + checkpoints, no escuro
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Quero uma página para apresentar meu trabalho ou negócio.' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.getByRole('heading', { name: 'Só mais alguns detalhes' })).toBeVisible({ timeout: 15_000 })
  for (const a of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
    await page.getByLabel('Sua resposta').fill(a)
    await page.getByRole('button', { name: 'Responder e continuar' }).click()
  }
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await expect(page.getByRole('heading', { name: 'Resultado da verificação' })).toBeVisible({ timeout: 40_000 })
  await page.waitForTimeout(1500)
  await check('verificacao+relato+pontos-seguros')
  await page.locator('.result-technical > summary').click()
  await page.locator('.run-report .run-stage details summary').first().click()
  await check('detalhes-tecnicos-abertos')
  console.log('\nACHADOS ESCURO:\n' + (achados.length === 0 ? '(nenhum)' : achados.join('\n')))
  expect(achados, achados.join('\n')).toEqual([])
})
