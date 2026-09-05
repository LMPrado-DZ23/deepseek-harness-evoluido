import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'apps/studio-runtime/operator.spec.mjs',
      'plugins/storage-postgres/tests/backup.spec.ts',
      'plugins/storage-postgres/tests/import-file.spec.ts',
      'plugins/storage-postgres/tests/restore-core.spec.ts',
      'plugins/storage-postgres/tests/restore-journal.spec.ts',
      'plugins/storage-postgres/tests/restore-policy.spec.ts',
      'plugins/storage-postgres/tests/safe-path.spec.ts',
      'plugins/storage-postgres/tests/safe-path-failures.spec.ts',
      'plugins/storage-postgres/tests/safety-backup.spec.ts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'apps/studio-runtime/operator.mjs',
        'plugins/storage-postgres/src/import-file.ts',
        'plugins/storage-postgres/src/restore-journal.ts',
        'plugins/storage-postgres/src/restore-policy.ts',
        'plugins/storage-postgres/src/restore.ts',
        'plugins/storage-postgres/src/safe-path.ts',
      ],
      reporter: ['text'],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 85,
        lines: 98,
        'apps/studio-runtime/operator.mjs': { functions: 100, lines: 100 },
        'plugins/storage-postgres/src/restore-policy.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'plugins/storage-postgres/src/safe-path.ts': { functions: 100, lines: 100 },
        'plugins/storage-postgres/src/restore.ts': { lines: 98 },
        'plugins/storage-postgres/src/import-file.ts': { lines: 96 },
        'plugins/storage-postgres/src/restore-journal.ts': { lines: 93 },
      },
    },
  },
})
