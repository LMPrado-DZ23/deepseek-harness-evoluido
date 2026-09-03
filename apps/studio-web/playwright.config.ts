import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', timeout: 60_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/server.mjs', url: 'http://127.0.0.1:4179/healthz',
    reuseExistingServer: false, timeout: 30_000,
  },
})
