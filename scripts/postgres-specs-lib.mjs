import { readFile, readdir } from 'node:fs/promises'

export async function discoverPostgresSpecs({ testsDirectory, repositoryPrefix }) {
  if (!(testsDirectory instanceof URL) || testsDirectory.protocol !== 'file:') {
    throw new Error('PostgreSQL tests directory must be a file URL')
  }
  if (typeof repositoryPrefix !== 'string' || repositoryPrefix.length === 0 || repositoryPrefix.startsWith('/')) {
    throw new Error('PostgreSQL repository prefix must be a non-empty relative path')
  }
  const names = (await readdir(testsDirectory)).filter(name => name.endsWith('.spec.ts')).sort()
  const selected = []
  for (const name of names) {
    const contents = await readFile(new URL(name, testsDirectory), 'utf8')
    if (contents.includes('DZ23_POSTGRES_TEST_DSN')) selected.push(`${repositoryPrefix}/${name}`)
  }
  if (selected.length === 0) {
    throw new Error('No PostgreSQL integration specs were discovered; refusing an empty gate')
  }
  return selected
}
