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
        'src/unix-client.ts',
      ],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 95,
        'src/{model,protocol,replay,state-machine}.ts': { 100: true },
        'src/{docker-adapter,docker-engine,export-artifact,persistent-replay,service,unix-server}.ts': { 100: true },
        'src/unix-client.ts': { statements: 95, branches: 85, functions: 100, lines: 100 },
      },
    },
  },
})
