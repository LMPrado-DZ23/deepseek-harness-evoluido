import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/artifact.ts',
        'src/docker-adapter.ts',
        'src/model.ts',
        'src/protocol.ts',
        'src/replay.ts',
        'src/service.ts',
        'src/state-machine.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 95,
        'src/{model,protocol,replay,state-machine}.ts': { 100: true },
      },
    },
  },
})
