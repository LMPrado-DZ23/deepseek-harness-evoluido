import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'pnpm start --hostname 127.0.0.1 --port 4173',
    env: { NODE_ENV: 'production', DZ23_STUDIO_VERIFICATION: '1', APP_OWNER_EMAIL: 'owner@example.test', APP_EMAIL_MODE: 'studio-capture', DATA_DIR: './data' },
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
