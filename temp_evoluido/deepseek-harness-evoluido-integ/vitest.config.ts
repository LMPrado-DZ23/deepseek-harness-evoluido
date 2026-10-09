import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const postgresEnabled = process.env.DZ23_POSTGRES_TEST_DSN !== undefined

export default defineConfig({
  resolve: {
    alias: {
      '@dz23-studio/action-approval': fileURLToPath(new URL('./plugins/action-approval/src/index.ts', import.meta.url)),
      '@dz23-studio/agents': fileURLToPath(new URL('./plugins/agents/src/index.ts', import.meta.url)),
      '@dz23-studio/agent-team': fileURLToPath(new URL('./plugins/agent-team/src/index.ts', import.meta.url)),
      '@dz23-studio/assistant-bridge': fileURLToPath(new URL('./plugins/assistant-bridge/src/index.ts', import.meta.url)),
      '@dz23-studio/builder-supervisor': fileURLToPath(new URL('./plugins/builder-supervisor/src/index.ts', import.meta.url)),
      '@dz23-studio/storage-postgres/operator': fileURLToPath(new URL('./plugins/storage-postgres/src/operator.ts', import.meta.url)),
      '@dz23-studio/emergency-stop': fileURLToPath(new URL('./plugins/emergency-stop/src/index.ts', import.meta.url)),
      '@dz23-studio/identity': fileURLToPath(new URL('./plugins/identity/src/index.ts', import.meta.url)),
      '@dz23-studio/integration-hub': fileURLToPath(new URL('./plugins/integration-hub/src/index.ts', import.meta.url)),
      '@dz23-studio/llm-cli': fileURLToPath(new URL('./plugins/llm-cli/src/index.ts', import.meta.url)),
      '@dz23-studio/mission': fileURLToPath(new URL('./plugins/mission/src/index.ts', import.meta.url)),
      '@dz23-studio/mcp-client': fileURLToPath(new URL('./plugins/mcp-client/src/index.ts', import.meta.url)),
      '@dz23-studio/policy': fileURLToPath(new URL('./plugins/policy/src/index.ts', import.meta.url)),
      '@dz23-studio/preview': fileURLToPath(new URL('./plugins/preview/src/index.ts', import.meta.url)),
      '@dz23-studio/preview-supervisor': fileURLToPath(new URL('./plugins/preview-supervisor/src/index.ts', import.meta.url)),
      '@dz23-studio/prompt-to-app': fileURLToPath(new URL('./plugins/prompt-to-app/src/index.ts', import.meta.url)),
      '@dz23-studio/route-health': fileURLToPath(new URL('./plugins/route-health/src/index.ts', import.meta.url)),
      '@dz23-studio/runtime-governor': fileURLToPath(new URL('./plugins/runtime-governor/src/index.ts', import.meta.url)),
      '@dz23-studio/storage-postgres': fileURLToPath(new URL('./plugins/storage-postgres/src/index.ts', import.meta.url)),
      '@dz23-studio/staging': fileURLToPath(new URL('./plugins/staging/src/index.ts', import.meta.url)),
      '@dz23-studio/tenancy': fileURLToPath(new URL('./plugins/tenancy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['plugins/*/tests/**/*.spec.ts', 'apps/studio-runtime/**/*.spec.mjs', 'scripts/**/*.spec.mjs'],
    coverage: {
      provider: 'v8',
      include: ['plugins/*/src/**/*.ts'],
      // Composition and operating-system adapters are exercised by real integration
      // proofs; the 100% threshold below is specifically for deterministic product logic.
      exclude: [
        ...(postgresEnabled ? [] : ['plugins/storage-postgres/src/**/*.ts']),
        'plugins/agents/src/index.ts',
        'plugins/agent-team/src/index.ts',
        'plugins/mission/src/index.ts',
        'plugins/agents/src/git.ts',
        'plugins/prompt-to-app/src/index.ts',
        // Composição: `apply` liga o despachante MCP ao hub e é exercida pelo
        // perfil real, do mesmo jeito que os `index.ts` acima. O protocolo, o
        // isolamento e os tetos deste plugin são cobertos contra um servidor MCP
        // de verdade em `plugins/mcp-client/tests`.
        'plugins/mcp-client/src/index.ts',
        'plugins/preview/src/index.ts',
        // Composição: `apply` liga o journal, a origem e o provedor local, e é
        // exercida pelo perfil real. A lógica está coberta em
        // `plugins/staging/tests`.
        'plugins/staging/src/plugin.ts',
        'plugins/route-health/src/index.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 90,
        statements: 90,
        'plugins/identity/src/**/*.ts': { 100: true },
        'plugins/policy/src/**/*.ts': { 100: true },
        'plugins/action-approval/src/{model,repository,tenant-repository,service,http}.ts': { 100: true },
        'plugins/tenancy/src/**/*.ts': { 100: true },
        'plugins/agents/src/{model,service}.ts': { 100: true },
        'plugins/agent-team/src/{model,service}.ts': { 100: true },
        'plugins/mission/src/{model,service,budget-port}.ts': { 100: true },
        'plugins/assistant-bridge/src/{approval,catalog,closed-tool,service}.ts': { 100: true },
        'plugins/studio-web/src/assistant-session.ts': { 100: true },
        'plugins/studio-web/src/assistant-conversation.ts': { 100: true },
        'plugins/studio-web/src/assistant-http.ts': { 100: true },
        'plugins/route-health/src/{model,service}.ts': { 100: true },
        'plugins/prompt-to-app/src/{model,security,state}.ts': { 100: true },
        'plugins/prompt-to-app/src/{data-generator,import-policy}.ts': { 100: true },
        'plugins/prompt-to-app/src/{builder-lifecycle,builder-resolver}.ts': { 100: true },
      },
    },
  },
})
