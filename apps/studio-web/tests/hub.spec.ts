import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext } from '@playwright/test'

type Catalog = { title: string; back: string; smtp: Record<string, string>; integrations: Record<string, string>; exports: Record<string, string>; events: { title: string; action: Record<string, string> } }
// Read (not imported) so the same catalog the page compiles is what the test expects, without ESM import attributes.
const hub = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'hub.pt-BR.json'), 'utf8')) as Catalog

/**
 * Integration Hub panel against the REAL Studio (started by the proof script):
 * real identity session, real policy, real storage. The proof hands over the
 * session cookie, the CSRF token, a verified project id and the id of the
 * unsigned integration it registered.
 */
const origin = process.env.DZ23_HUB_ORIGIN!
const sessionToken = process.env.DZ23_HUB_SESSION!
const csrfToken = process.env.DZ23_HUB_CSRF!
const projectId = process.env.DZ23_HUB_PROJECT_ID!
const projectName = process.env.DZ23_HUB_PROJECT_NAME!

async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'dz23_studio_session', value: sessionToken, url: origin },
    { name: 'dz23_studio_csrf', value: csrfToken, url: origin },
  ])
}

test.beforeEach(({}, testInfo) => { testInfo.skip(origin === undefined || sessionToken === undefined, 'started outside the proof script') })

test('abre /studio/hub como tela própria, em pt-BR, sem tocar na aplicação principal', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/hub')
  await expect(page.getByRole('heading', { level: 1, name: hub.title })).toBeVisible()
  await expect(page.getByRole('link', { name: hub.back })).toHaveAttribute('href', '/studio/')
  await expect(page.getByRole('heading', { name: hub.smtp.title })).toBeVisible()
  await expect(page.getByRole('heading', { name: hub.integrations.title, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: hub.exports.title })).toBeVisible()
  await expect(page.getByRole('heading', { name: hub.events.title })).toBeVisible()
  // The main application is not rendered on this path.
  await expect(page.locator('.idea-panel')).toHaveCount(0)
})

test('guarda só o NOME do segredo de e-mail e mostra o teste como não executado, em palavras', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/hub')
  const state = page.getByTestId('smtp-state')
  await expect(state).toContainText(hub.smtp.status)
  await page.getByLabel(hub.smtp.refLabel).fill('DZ23_NAO_EXISTE')
  await page.getByRole('button', { name: hub.smtp.save }).click()
  await expect(page.getByRole('alert')).toContainText('cofre')
  await page.getByLabel(hub.smtp.refLabel).fill('DZ23_APP_SMTP')
  await page.getByRole('button', { name: hub.smtp.save }).click()
  await expect(page.getByRole('status')).toContainText(hub.smtp.saved)
  await expect(state).toContainText('DZ23_APP_SMTP')
  await page.getByLabel(hub.smtp.testLabel).fill('dona.do.negocio@example.test')
  await page.getByRole('button', { name: hub.smtp.test }).click()
  await expect(page.getByRole('status')).toContainText(hub.smtp.testNotExecuted)
  // The password configured in the server environment never reaches the page.
  expect(await page.content()).not.toContain('nunca-sai-do-servidor')
})

test('lista integrações com nível de confiança e não oferece ligar a que não tem assinatura', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/hub')
  const items = page.getByTestId('integration-item')
  await expect(items).toHaveCount(2)
  // Class filters: "Sem assinatura reconhecida" contains "assinatura reconhecida", so text alone would not separate them.
  const verified = items.filter({ has: page.locator('.hub-tag.verified') })
  const unverified = items.filter({ has: page.locator('.hub-tag.unverified') })
  await expect(verified.locator('.hub-tag.verified')).toHaveText(hub.integrations.verified)
  await expect(unverified.locator('.hub-tag.unverified')).toHaveText(hub.integrations.unverified)
  await expect(verified).toHaveCount(1)
  await expect(unverified).toHaveCount(1)
  await expect(unverified).toContainText('T2')
  await expect(unverified.getByRole('button', { name: hub.integrations.enable })).toBeDisabled()
  // Verified one is enabled by the proof; the panel offers to switch it off and back on.
  await expect(verified).toContainText(hub.integrations.enabled)
  await verified.getByRole('button', { name: hub.integrations.disable }).click()
  await expect(verified).toContainText(hub.integrations.disabled)
  await verified.getByRole('button', { name: hub.integrations.enable }).click()
  await expect(verified).toContainText(hub.integrations.enabled)
})

test('gera o pacote do protótipo verificado, mostra o SHA-256 e o download confere byte a byte', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/hub')
  const select = page.getByLabel(hub.exports.projectLabel)
  await expect(select).toBeVisible()
  await select.selectOption(projectId)
  await expect(select.locator('option:checked')).toHaveText(projectName)
  await page.getByRole('button', { name: hub.exports.create }).click()
  await expect(page.getByRole('status')).toContainText(hub.exports.created)
  const item = page.getByTestId('export-item').first()
  const digest = await item.locator('code').innerText()
  expect(digest).toMatch(/^[0-9a-f]{64}$/u)
  const link = item.getByRole('link')
  const href = await link.getAttribute('href')
  expect(href).toContain('/api/studio/hub/projects/')
  const downloaded = await page.request.get(href!)
  expect(downloaded.status()).toBe(200)
  expect(downloaded.headers()['content-type']).toBe('application/zip')
  expect(createHash('sha256').update(await downloaded.body()).digest('hex')).toBe(digest)
  await expect(page.getByTestId('event-list')).toContainText(hub.events.action['export.created'])
})

test('sem sessão, a tela e a API recusam antes de mostrar qualquer dado', async ({ page }) => {
  const response = await page.goto('/studio/hub')
  expect(response?.status()).toBe(401)
  const api = await page.request.get('/api/studio/hub/integrations')
  expect(api.status()).toBe(401)
})
