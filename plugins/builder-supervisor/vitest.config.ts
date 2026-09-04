import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/artifact.ts',
        'src/docker-adapter.ts',
        'src/docker-engine.ts',
        'src/export-artifact.ts',
        'src/model.ts',
        'src/persistent-replay.ts',
        'src/protocol.ts',
        'src/replay.ts',
        'src/service.ts',
        'src/semaphore.ts',
        'src/state-machine.ts',
        'src/unix-server.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 95,
        'src/{model,protocol,replay,state-machine}.ts': { 100: true },
        'src/{docker-engine,unix-server}.ts': { statements: 80, branches: 70, functions: 85, lines: 95 },
      },
    },
  },
})
