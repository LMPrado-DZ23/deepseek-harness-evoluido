import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The service worker version changes whenever the app version or its source changes, so an
// updated interface always installs a fresh shell cache (old caches are deleted on activate).
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version?: string }
const swVersion = `${pkg.version ?? '0'}-${Date.now().toString(36)}`

export default defineConfig({
  base: '/studio/', plugins: [react()],
  define: { __DZ23_SW_VERSION__: JSON.stringify(swVersion) },
  build: {
    outDir: 'dist', emptyOutDir: true,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), sw: resolve(__dirname, 'src/pwa/sw.ts') },
      output: {
        // The worker must keep a stable URL (/studio/sw.js); everything else stays hashed.
        entryFileNames: chunk => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
})
