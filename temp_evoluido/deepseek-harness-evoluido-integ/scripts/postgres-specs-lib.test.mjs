import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverPostgresSpecs } from './postgres-specs-lib.mjs'

const scratch = []

afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(files) {
  const directory = await mkdtemp(join(tmpdir(), 'dz23-postgres-specs-'))
  scratch.push(directory)
  for (const [name, contents] of Object.entries(files)) await writeFile(join(directory, name), contents, 'utf8')
  return new URL('./', pathToFileURL(join(directory, 'marker')))
}

describe('PostgreSQL integration spec discovery', () => {
  it('selects every declared database spec in deterministic order', async () => {
    const testsDirectory = await fixture({
      'zeta.spec.ts': "const dsn = process.env.DZ23_POSTGRES_TEST_DSN\n",
      'alpha.spec.ts': "const dsn = process.env.DZ23_POSTGRES_TEST_DSN\n",
      'unit.spec.ts': 'export const unitOnly = true\n',
      'ignored.txt': 'DZ23_POSTGRES_TEST_DSN\n',
    })

    assert.deepEqual(await discoverPostgresSpecs({ testsDirectory, repositoryPrefix: 'tests' }), [
      'tests/alpha.spec.ts',
      'tests/zeta.spec.ts',
    ])
  })

  it('fails closed when no integration spec is discoverable', async () => {
    const testsDirectory = await fixture({ 'unit.spec.ts': 'export const unitOnly = true\n' })
    await assert.rejects(
      discoverPostgresSpecs({ testsDirectory, repositoryPrefix: 'tests' }),
      /refusing an empty gate/u,
    )
  })

  it('rejects ambiguous directory and output contracts', async () => {
    const testsDirectory = await fixture({
      'database.spec.ts': "const dsn = process.env.DZ23_POSTGRES_TEST_DSN\n",
    })
    await assert.rejects(
      discoverPostgresSpecs({ testsDirectory: new URL('https://example.invalid/'), repositoryPrefix: 'tests' }),
      /file URL/u,
    )
    await assert.rejects(
      discoverPostgresSpecs({ testsDirectory, repositoryPrefix: '/absolute' }),
      /relative path/u,
    )
  })
})
