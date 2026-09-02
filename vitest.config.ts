import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@dz23-studio/identity': fileURLToPath(new URL('./plugins/identity/src/index.ts', import.meta.url)),
      '@dz23-studio/policy': fileURLToPath(new URL('./plugins/policy/src/index.ts', import.meta.url)),
      '@dz23-studio/tenancy': fileURLToPath(new URL('./plugins/tenancy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['plugins/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['plugins/*/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
})
