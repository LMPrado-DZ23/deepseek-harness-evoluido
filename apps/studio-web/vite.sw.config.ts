import { defineConfig } from 'vite'
import { swVersion } from './sw-version'

// The service worker is built on its own, as a single IIFE file at the stable
// URL /studio/sw.js. A classic worker cannot use `import`; a separate build
// guarantees that no chunk is ever shared with the interface bundle.
export default defineConfig({
  define: { __DZ23_SW_VERSION__: JSON.stringify(swVersion()) },
  build: {
    outDir: 'dist', emptyOutDir: false, sourcemap: false, minify: true,
    lib: { entry: 'src/pwa/sw.ts', formats: ['iife'], name: 'dz23StudioServiceWorker', fileName: () => 'sw.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
