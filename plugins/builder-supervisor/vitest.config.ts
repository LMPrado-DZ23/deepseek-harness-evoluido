import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Real Unix socket deadlines and filesystem race tests share host I/O.
    // Serialization keeps their wall-clock assertions deterministic under coverage.
    maxWorkers: 1,
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
        'src/runtime-scope.ts',
        'src/service.ts',
        'src/semaphore.ts',
        'src/state-machine.ts',
        'src/unix-server.ts',
        'src/unix-client.ts',
        'src/supervisor-config.ts',
        'src/supervisor-main.ts',
      ],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 95,
        'src/{model,protocol,replay,runtime-scope,state-machine}.ts': { 100: true },
        'src/{docker-adapter,docker-engine,export-artifact,persistent-replay,service,unix-server}.ts': { 100: true },
        'src/unix-client.ts': { statements: 95, branches: 80, functions: 100, lines: 100 },
        'src/supervisor-config.ts': { statements: 95, branches: 85, functions: 100, lines: 100 },
        'src/supervisor-main.ts': { statements: 90, branches: 80, functions: 90, lines: 95 },
      },
    },
  },
})
