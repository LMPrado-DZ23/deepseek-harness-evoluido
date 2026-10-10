import { expect, test } from '@playwright/test'
import { answerIntake, INTAKE_ANSWERS } from './answering'
import { esperarResultado } from './resultado'

test.use({ serviceWorkers: 'block' })

test('continua atualizando quando a execucao termina antes do estado do projeto', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e'))
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await answerIntake(page, INTAKE_ANSWERS)
  await page.getByRole('button', { name: 'Montar meu plano' }).click()
  await page.getByRole('button', { name: 'Aprovar este plano' }).click()
  let completedReads = 0
  await context.route('**/api/studio/apps/projects/*', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const url = new URL(route.request().url()); url.hostname = '127.0.0.1'
    const response = await route.fetch({ url: url.href, headers: { ...route.request().headers(), host: 'studio.dz23.localhost:4179' } })
    const body = await response.json() as { project: { state: string }; current_run?: { state: string } }
    if (body.current_run?.state === 'PASSED') {
      completedReads++
      if (completedReads === 1) body.project.state = 'GENERATING'
    }
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await esperarResultado(page)
  await expect.poll(() => completedReads).toBeGreaterThanOrEqual(2)
  await page.getByRole('radio', { name: 'Pedir alteração' }).check()
  await page.locator('#dz-continuar').fill('Adicionar horarios de atendimento')
  await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeEnabled()
})
