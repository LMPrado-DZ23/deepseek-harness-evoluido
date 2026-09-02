import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugins/hello/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['plugins/hello/src/**/*.ts'],
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

