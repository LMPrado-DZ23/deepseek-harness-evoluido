import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('o compositor conserva a resposta depois de falha e limpa depois de confirmar', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  const keys: string[] = []
  await context.route('**/api/studio/apps/projects/*/intake/answer', async route => {
    keys.push((route.request().postDataJSON() as { request_key: string }).request_key)
    if (keys.length === 1) await route.abort('failed')
    else await route.continue()
  })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  const field = page.locator('#dz-continuar')
  const text = 'Clientes e acompanhantes da clinica'
  await field.fill(text)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => keys.length).toBe(1)
  await expect(field).toHaveValue(text)
  await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[1]).toBe(keys[0])
  await expect(field).toHaveValue('')
  await expect(page.getByText(text, { exact: true })).toBeVisible()
})

test('falha ao reler a conversa conserva texto e chave de um envio ja gravado', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.locator('#dz-continuar')).toBeVisible()
  const keys: string[] = []
  let refuseRead = false
  await context.route('**/api/studio/apps/projects/*', async route => {
    if (refuseRead && route.request().method() === 'GET') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Leitura temporariamente indisponível' }) })
    else await route.continue()
  })
  await context.route('**/api/studio/apps/projects/*/intake/answer', async route => {
    keys.push((route.request().postDataJSON() as { request_key: string }).request_key)
    const url = new URL(route.request().url()); url.hostname = '127.0.0.1'
    const headers: Record<string, string> = { ...route.request().headers(), host: 'studio.dz23.localhost:4179' }
    delete headers['x-dz23-espera']
    const response = await route.fetch({ url: url.href, headers })
    expect(response.status()).toBe(200)
    refuseRead = keys.length === 1
    await route.fulfill({ response })
  })
  const text = 'moradores do bairro'
  const field = page.locator('#dz-continuar')
  await field.fill(text)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect(page.getByText('Leitura temporariamente indisponível', { exact: false })).toBeVisible()
  await expect(field).toHaveValue(text)
  refuseRead = false
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[1]).toBe(keys[0])
  await expect(field).toHaveValue('')
  const count = await page.evaluate(async value => {
    const id = new URL(location.href).searchParams.get('projeto')
    const response = await fetch(`/api/studio/apps/projects/${id}`)
    const body = await response.json() as { turns: Array<{ answer: string }> }
    return body.turns.filter(turn => turn.answer === value).length
  }, text)
  expect(count).toBe(1)
})

test('resposta antiga nao apaga texto escrito enquanto o envio estava em voo', async ({ context, page }) => {
  const origin = 'http://studio.dz23.localhost:4179'
  await context.addCookies([
    { name: 'dz23_studio_session', value: 'e2e', url: origin },
    { name: 'dz23_studio_csrf', value: 'csrf-e2e', url: origin },
  ])
  await context.addInitScript(() => { window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf-e2e') })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let saved = false
  await context.route('**/api/studio/apps/projects/*/intake/answer', async route => {
    const url = new URL(route.request().url()); url.hostname = '127.0.0.1'
    const headers: Record<string, string> = { ...route.request().headers(), host: 'studio.dz23.localhost:4179' }
    delete headers['x-dz23-espera']
    const response = await route.fetch({ url: url.href, headers })
    expect(response.status()).toBe(200)
    saved = true
    await held
    await route.fulfill({ response })
  })
  await page.goto('/studio/')
  await page.getByRole('button', { name: 'Página de apresentação' }).click()
  await page.getByRole('button', { name: 'Continuar' }).click()
  const field = page.locator('#dz-continuar')
  await field.fill('moradores do bairro')
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  try {
    await expect.poll(() => saved).toBe(true)
    await field.fill('Texto novo que ainda nao enviei')
  } finally { release() }
  await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toHaveAttribute('aria-busy', 'false')
  await expect(field).toHaveValue('Texto novo que ainda nao enviei')
  await expect(page.getByText('moradores do bairro', { exact: true })).toBeVisible()
})
