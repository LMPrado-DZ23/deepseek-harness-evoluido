import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { swVersion } from './sw-version'

export default defineConfig({
  base: '/studio/', plugins: [react()],
  define: { __DZ23_SW_VERSION__: JSON.stringify(swVersion()) },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
        singleFork: true
      }
    }
  },
})
