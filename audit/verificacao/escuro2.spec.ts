import AxeBuilder from '@axe-core/playwright'
import { test } from '@playwright/test'
const origin = 'http://studio.dz23.localhost:4179'
test.use({ colorScheme: 'dark' })
test('login e gaveta no escuro', async ({ context, page }) => {
  const achados: string[] = []
  const check = async (tela: string) => {
    const r = await new AxeBuilder({ page }).analyze()
    for (const v of r.violations) for (const n of v.nodes) achados.push(`${tela}: ${v.id} :: ${n.html.slice(0, 110)} :: ${n.any.map(a => JSON.stringify(a.data)).join(' ')}`)
  }
  await page.goto('/login'); await page.waitForTimeout(800); await check('login')
  await context.addCookies([{ name: 'dz23_studio_session', value: 'e2e', url: origin }])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/studio/'); await page.waitForTimeout(800)
  await page.locator('button.mobile-menu').click()
  await page.waitForTimeout(600)
  await check('gaveta-390-escuro')
  console.log('\nACHADOS2:\n' + (achados.length === 0 ? '(nenhum)' : achados.join('\n')))
})
