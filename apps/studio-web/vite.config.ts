import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  base: '/studio/', plugins: [react()], build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['src/**/*.spec.ts'] },
})
