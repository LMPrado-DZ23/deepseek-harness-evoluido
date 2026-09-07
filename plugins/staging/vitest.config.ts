import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/artifact.ts', 'src/model.ts', 'src/security.ts', 'src/service.ts'],
      reporter: ['text', 'json', 'json-summary'],
      thresholds: {
        branches: 90,
        statements: 90,
        'src/artifact.ts': { 100: true },
        'src/security.ts': { 100: true },
      },
    },
  },
})
