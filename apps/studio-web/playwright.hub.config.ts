import { defineConfig } from '@playwright/test'

// Runs against a Studio already started by scripts/prove-integration-hub.mjs (real profile, real
// identity). The proof passes origin and session through the environment; nothing is mocked here.
const executablePath = process.env.DZ23_CHROMIUM_PATH
const origin = process.env.DZ23_HUB_ORIGIN ?? 'http://127.0.0.1:0'

export default defineConfig({
  testDir: './tests', testMatch: /hub\.spec\.ts$/u, timeout: 60_000, workers: 1,
  outputDir: process.env.CI === 'true' ? '/tmp/dz23-studio-hub-test-results' : './test-results-hub',
  use: { baseURL: origin, trace: 'retain-on-failure', ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }) },
})
