import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugins/storage-postgres/tests/restore-policy.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['plugins/storage-postgres/src/restore-policy.ts'],
      reporter: ['text'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
