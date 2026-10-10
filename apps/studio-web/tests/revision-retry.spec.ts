import { expect, test } from '@playwright/test'
import { answerIntake, INTAKE_ANSWERS } from './answering'
import { esperarResultado } from './resultado'

test.use({ serviceWorkers: 'block' })

for (const failureStatus of [0, 500, 409, 200]) test(`revisao recupera a mesma chave depois de fechar a aba: falha=${failureStatus}`, async ({ context, page }) => {
  const interrupted = failureStatus === 500 || failureStatus === 409
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
  await page.getByRole('button', { name: 'Iniciar criação' }).click()
  await esperarResultado(page)
  if (!interrupted) {
    await page.getByRole('radio', { name: 'Pedir alteração' }).check()
    await page.locator('#dz-continuar').fill('x')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('#dz-continuar')).toHaveValue('x')
  }
  if (interrupted) await page.evaluate(async () => {
    const id = new URL(location.href).searchParams.get('projeto')
    await fetch(`/e2e/fail-revision-approval?project=${id}`)
  })
  const keys: string[] = []
  const specs: string[] = []
  await context.route('**/api/studio/apps/projects/*/revise', async route => {
    keys.push((route.request().postDataJSON() as { request_key: string }).request_key)
    const url = new URL(route.request().url()); url.hostname = '127.0.0.1'
    const headers: Record<string, string> = { ...route.request().headers(), host: 'studio.dz23.localhost:4179' }
    delete headers['x-dz23-espera']
    const response = await route.fetch({ url: url.href, headers })
    if (interrupted && keys.length === 1) {
      expect(response.status()).toBe(500)
      await route.fulfill({ response, status: failureStatus }); return
    }
    expect(response.status()).toBe(200)
    const body = await response.json() as { spec_id: string }
    specs.push(body.spec_id)
    if (keys.length === 1 && failureStatus === 200) await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
    else if (keys.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  const request = 'Adicionar uma secao com horarios de atendimento'
  await page.getByRole('radio', { name: 'Pedir alteração' }).check()
  await page.locator('#dz-continuar').fill(request)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  if (interrupted) await expect(page.getByText('Uma revisão está aguardando confirmação.', { exact: false })).toBeVisible()
  else await expect.poll(() => specs.length).toBe(1)
  const metadata = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('frigg.plan-intents.v1', 1)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try { return await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('pending').objectStore('pending').getAll()
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    }) } finally { database.close() }
  })
  expect(metadata).toHaveLength(1)
  expect(Object.keys(metadata[0] as object).sort()).toEqual(['baseRevision', 'digest', 'key', 'slot'])
  expect(JSON.stringify(metadata)).not.toContain(request)
  const address = page.url()
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto(address)
  if (interrupted) {
    await expect(reopened.getByText('Uma revisão está aguardando confirmação.', { exact: false })).toBeVisible()
    await expect(reopened.getByRole('button', { name: 'Montar meu plano' })).toHaveCount(0)
    await reopened.locator('#dz-continuar').fill('Outro pedido nao deve apagar a chave anterior')
    await reopened.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect(reopened.getByText('Reenvie o texto original', { exact: false })).toBeVisible()
    expect(keys).toHaveLength(1)
  }
  await reopened.getByRole('radio', { name: 'Pedir alteração' }).check()
  await reopened.locator('#dz-continuar').fill(request)
  await reopened.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect.poll(() => keys.length).toBe(2)
  expect(keys[1]).toBe(keys[0])
  await expect.poll(() => specs.length).toBe(interrupted ? 1 : 2)
  if (!interrupted) expect(specs[1]).toBe(specs[0])
  await expect(reopened.getByText('Uma revisão está aguardando confirmação.', { exact: false })).toHaveCount(0)
  await expect(reopened.locator('#dz-continuar')).toHaveValue('')
  const count = await reopened.evaluate(async () => {
    const database = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('frigg.plan-intents.v1', 1); request.onsuccess = () => resolve(request.result)
    })
    try { return await new Promise<number>(resolve => {
      const request = database.transaction('pending').objectStore('pending').count(); request.onsuccess = () => resolve(request.result)
    }) } finally { database.close() }
  })
  expect(count).toBe(0)
  if (!interrupted) {
    await reopened.evaluate(() => { indexedDB.open = () => { throw new Error('storage denied') } })
    await reopened.locator('#dz-continuar').fill('Adicionar um mapa no rodape')
    await reopened.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect(reopened.getByText('Não consegui preservar este envio', { exact: false })).toBeVisible()
    expect(keys).toHaveLength(2)
  }
})
