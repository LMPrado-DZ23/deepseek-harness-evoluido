import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext } from '@playwright/test'

type Catalog = { title: string; back: string; smtp: Record<string, string>; integrations: Record<string, string>; exports: Record<string, string>; confirm: Record<string, string>; events: { title: string; action: Record<string, string> } }
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
  /** How many decisions the server has issued so far, straight from its own history. */
  const approvalsIssued = async (): Promise<number> => {
    const body = await (await page.request.get('/api/studio/hub/events?limit=200')).json() as { events: Array<{ action: string }> }
    return body.events.filter(event => event.action === 'approval.requested').length
  }
  const state = page.getByTestId('smtp-state')
  await expect(state).toContainText(hub.smtp.status)
  const beforeAsking = await approvalsIssued()
  await page.getByLabel(hub.smtp.refLabel).fill('DZ23_NAO_EXISTE')
  await page.getByRole('button', { name: hub.smtp.save }).click()
  // T2: the panel asks first. Cancelling sends nothing at all.
  const confirmBox = page.getByTestId('hub-confirm')
  await expect(confirmBox).toContainText(hub.confirm.title)
  // And nothing was sent to open the box either: the decision is only asked for on confirmation, so
  // a person who reads the box and backs out leaves NO ticket and NO audit event behind.
  expect(await approvalsIssued()).toBe(beforeAsking)
  await confirmBox.getByRole('button', { name: hub.confirm.cancel }).click()
  await expect(confirmBox).toHaveCount(0)
  expect(await approvalsIssued()).toBe(beforeAsking)
  // Cancelling sent nothing: the name the proof configured before opening the panel is untouched.
  await expect(state).toContainText('DZ23_APP_SMTP')
  await page.getByRole('button', { name: hub.smtp.save }).click()
  await confirmBox.getByRole('button', { name: hub.confirm.confirm }).click()
  await expect(page.getByRole('alert')).toContainText('cofre')
  // Confirming DOES issue exactly one decision, so the assertion above is about the cancel and not
  // about a panel that never asks.
  expect(await approvalsIssued()).toBe(beforeAsking + 1)
  await page.getByLabel(hub.smtp.refLabel).fill('DZ23_APP_SMTP')
  await page.getByRole('button', { name: hub.smtp.save }).click()
  await confirmBox.getByRole('button', { name: hub.confirm.confirm }).click()
  await expect(page.getByRole('status')).toContainText(hub.smtp.saved)
  await expect(state).toContainText('DZ23_APP_SMTP')
  await page.getByLabel(hub.smtp.testLabel).fill('dona.do.negocio@example.test')
  await page.getByRole('button', { name: hub.smtp.test }).click()
  await confirmBox.getByRole('button', { name: hub.confirm.confirm }).click()
  await expect(page.getByRole('status')).toContainText(hub.smtp.testNotExecuted)
  // The password configured in the server environment never reaches the page.
  expect(await page.content()).not.toContain('nunca-sai-do-servidor')
})

test('lista integrações com nível de confiança e não oferece ligar a que não tem assinatura', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/hub')
  const items = page.getByTestId('integration-item')
  await expect(items).toHaveCount(3)
  // Class filters: "Sem assinatura reconhecida" contains "assinatura reconhecida", so text alone would not separate them.
  const verified = items.filter({ has: page.locator('.hub-tag.verified') })
  const unverified = items.filter({ has: page.locator('.hub-tag.unverified') })
  await expect(verified.locator('.hub-tag.verified').first()).toHaveText(hub.integrations.verified)
  await expect(unverified.locator('.hub-tag.unverified')).toHaveText(hub.integrations.unverified)
  await expect(verified).toHaveCount(2) // the read-only skill and the one that asks for the vault (T3)
  await expect(unverified).toHaveCount(1)
  await expect(unverified).toContainText('T2')
  await expect(unverified.getByRole('button', { name: hub.integrations.enable })).toBeDisabled()
  await expect(unverified.locator('.hub-why')).toHaveText(hub.integrations.cannotEnable)
  // The T0 one is enabled by the proof; the panel switches it off and back on with no confirmation (T0).
  const simple = items.filter({ hasText: 'Agenda local' }).filter({ hasNot: page.getByTestId('approval-note') })
  await expect(simple).toContainText(hub.integrations.enabled)
  await simple.getByRole('button', { name: hub.integrations.disable }).click()
  await expect(simple).toContainText(hub.integrations.disabled)
  await simple.getByRole('button', { name: hub.integrations.enable }).click()
  await expect(simple).toContainText(hub.integrations.enabled)
  await expect(simple.getByTestId('approval-note')).toHaveCount(0)
})

test('a integração que pede o cofre é T3: pede confirmação e ainda assim exige passkey', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/studio/hub')
  const item = page.getByTestId('integration-item').filter({ has: page.getByTestId('approval-note') })
  await expect(item).toHaveCount(1)
  await expect(item.getByTestId('approval-note')).toContainText('T3')
  await item.getByRole('button', { name: hub.integrations.enable }).click()
  const box = page.getByTestId('hub-confirm')
  await expect(box).toContainText(hub.confirm.T3)
  await box.getByRole('button', { name: hub.confirm.confirm }).click()
  // This session signed in by magic code: the server still refuses, in words, and the integration stays off.
  await expect(page.getByRole('alert')).toContainText('passkey')
  await expect(item).toContainText(hub.integrations.disabled)
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
