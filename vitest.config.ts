import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const postgresEnabled = process.env.DZ23_POSTGRES_TEST_DSN !== undefined

export default defineConfig({
  resolve: {
    alias: {
      '@dz23-studio/storage-postgres/operator': fileURLToPath(new URL('./plugins/storage-postgres/src/operator.ts', import.meta.url)),
      '@dz23-studio/identity': fileURLToPath(new URL('./plugins/identity/src/index.ts', import.meta.url)),
      '@dz23-studio/integration-hub': fileURLToPath(new URL('./plugins/integration-hub/src/index.ts', import.meta.url)),
      '@dz23-studio/policy': fileURLToPath(new URL('./plugins/policy/src/index.ts', import.meta.url)),
      '@dz23-studio/preview': fileURLToPath(new URL('./plugins/preview/src/index.ts', import.meta.url)),
      '@dz23-studio/prompt-to-app': fileURLToPath(new URL('./plugins/prompt-to-app/src/index.ts', import.meta.url)),
      '@dz23-studio/route-health': fileURLToPath(new URL('./plugins/route-health/src/index.ts', import.meta.url)),
      '@dz23-studio/storage-postgres': fileURLToPath(new URL('./plugins/storage-postgres/src/index.ts', import.meta.url)),
      '@dz23-studio/tenancy': fileURLToPath(new URL('./plugins/tenancy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['plugins/*/tests/**/*.spec.ts', 'apps/studio-runtime/**/*.spec.mjs'],
    coverage: {
      provider: 'v8',
      include: ['plugins/*/src/**/*.ts'],
      // Composition and operating-system adapters are exercised by real integration
      // proofs; the 100% threshold below is specifically for deterministic product logic.
      exclude: [
        ...(postgresEnabled ? [] : ['plugins/storage-postgres/src/**/*.ts']),
        'plugins/agents/src/index.ts',
        'plugins/agents/src/git.ts',
        'plugins/prompt-to-app/src/index.ts',
        'plugins/preview/src/index.ts',
        'plugins/route-health/src/index.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 90,
        statements: 90,
        'plugins/identity/src/**/*.ts': { 100: true },
        'plugins/policy/src/**/*.ts': { 100: true },
        'plugins/tenancy/src/**/*.ts': { 100: true },
        'plugins/agents/src/{model,service}.ts': { 100: true },
        'plugins/route-health/src/{model,service}.ts': { 100: true },
        'plugins/prompt-to-app/src/{model,security,state}.ts': { 100: true },
        'plugins/prompt-to-app/src/{data-generator,import-policy}.ts': { 100: true },
      },
    },
  },
})
