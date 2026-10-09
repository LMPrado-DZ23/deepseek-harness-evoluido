import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
test('renders and has no serious accessibility violations', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('h1')).toBeVisible()
  const result = await new AxeBuilder({ page }).analyze()
  expect(result.violations.filter(item => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
})
