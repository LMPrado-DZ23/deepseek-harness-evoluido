import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('renders with no serious accessibility violations or external requests', async ({ page }) => {
  const external: string[] = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url()) })
  await page.goto('/')
  await expect(page.locator('h1')).toBeVisible()
  const result = await new AxeBuilder({ page }).analyze()
  expect(result.violations.filter(item => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
  expect(external).toEqual([])
})
