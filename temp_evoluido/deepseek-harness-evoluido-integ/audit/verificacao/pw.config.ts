import { defineConfig, devices } from '@playwright/test'
const chromiumPath = process.env.DZ23_CHROMIUM_PATH?.trim() || undefined
export default defineConfig({
  testDir: '/home/claude/integ/audit/verificacao', timeout: 90_000, workers: 1,
  projects: [{ name: 'mesa', use: { ...devices['Desktop Chrome'] } }],
  outputDir: '/home/claude/integ/audit/verificacao/out',
  use: {
    baseURL: 'http://studio.dz23.localhost:4179',
    ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
  },
  webServer: {
    command: 'node /home/claude/integ/node_modules/tsx/dist/cli.mjs tests/server.ts',
    cwd: '/home/claude/integ/apps/studio-web',
    url: 'http://127.0.0.1:4179/healthz', reuseExistingServer: false, timeout: 30_000,
  },
})
