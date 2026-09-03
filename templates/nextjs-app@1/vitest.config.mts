import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**'],
  },
  resolve: { alias: { '@': new URL('./', import.meta.url).pathname } },
})
