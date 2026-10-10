import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('pergunta recupera o mesmo turno depois de fechar a aba com resposta perdida', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e'))
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  const keys: string[] = []
  const turns: string[] = []
  await context.route('**/api/studio/apps/projects/*/ask', async route => {
    keys.push((route.request().postDataJSON() as { request_key: string }).request_key)
    const url = new URL(route.request().url()); url.hostname = '127.0.0.1'
    const headers: Record<string, string> = { ...route.request().headers(), host: 'studio.dz23.localhost:4179' }
    delete headers['x-dz23-espera']
    const response = await route.fetch({ url: url.href, headers })
    expect(response.status()).toBe(201)
    const body = await response.json() as { turn: { turn_id: string } }
    turns.push(body.turn.turn_id)
    if (keys.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  const question = 'Qual e o estado desta tarefa?'
  await page.getByRole('radio', { name: 'Perguntar', exact: true }).check()
  await page.locator('#dz-continuar').fill(question)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => turns.length).toBe(1)
  const address = page.url()
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto(address)
  await reopened.getByRole('radio', { name: 'Perguntar', exact: true }).check()
  await reopened.locator('#dz-continuar').fill(question)
  await reopened.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => turns.length).toBe(2)
  expect(keys[1]).toBe(keys[0])
  expect(turns[1]).toBe(turns[0])
  await expect(reopened.locator('#dz-continuar')).toHaveValue('')
  await reopened.locator('#dz-continuar').fill(question)
  await reopened.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => turns.length).toBe(3)
  expect(keys[2]).not.toBe(keys[1])
  expect(turns[2]).not.toBe(turns[1])
  await expect(reopened.locator('#dz-continuar')).toHaveValue('')
  await reopened.evaluate(() => { indexedDB.open = () => { throw new Error('storage denied') } })
  await reopened.locator('#dz-continuar').fill('Quanto falta para terminar?')
  await reopened.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect(reopened.getByText('Não consegui preservar este envio', { exact: false })).toBeVisible()
  expect(keys).toHaveLength(3)
})
