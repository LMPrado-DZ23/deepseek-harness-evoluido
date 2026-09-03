import AxeBuilder from '@axe-core/playwright'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test('renders with no serious accessibility violations or external requests', async ({ page }) => {
  const external: string[] = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url()) })
  const response = await page.goto('/')
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(response?.headers()['x-content-type-options']).toBe('nosniff')
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  expect(response?.headers()['referrer-policy']).toBe('no-referrer')
  await expect(page.locator('h1')).toBeVisible()
  if (existsSync(resolve(process.cwd(), 'public/brand/logo.png'))) {
    await expect(page.getByRole('img', { name: /^Logotipo de /u })).toHaveAttribute('src', '/brand/logo.png')
  }
  const result = await new AxeBuilder({ page }).analyze()
  expect(result.violations.filter(item => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([])
  expect(external).toEqual([])
})
