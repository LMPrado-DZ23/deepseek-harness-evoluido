import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const chromiumPath = process.env.DZ23_CHROMIUM_PATH?.trim() || undefined
if (chromiumPath !== undefined && (!isAbsolute(chromiumPath) || !existsSync(chromiumPath))) {
  throw new Error('DZ23_CHROMIUM_PATH deve apontar para um executável Chromium absoluto e existente.')
}

export default defineConfig({
  testDir: './tests', timeout: 60_000, workers: 1,
  outputDir: process.env.CI === 'true' ? '/tmp/dz23-studio-web-test-results' : './test-results',
  use: {
    baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure',
    ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
  },
  webServer: {
    command: 'node ../../node_modules/tsx/dist/cli.mjs tests/server.ts', url: 'http://127.0.0.1:4179/healthz',
    reuseExistingServer: false, timeout: 30_000,
  },
})
