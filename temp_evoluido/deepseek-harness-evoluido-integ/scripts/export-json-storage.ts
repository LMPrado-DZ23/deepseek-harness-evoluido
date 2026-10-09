import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { STUDIO_DOMAIN_SPECS } from './studio-domain-specs.ts'
import { exportStorage, sha256 } from './storage-migration.ts'

/**
 * Export the Studio domains of a development instance that runs on the
 * Harness default `json` backend (`<DSH_HOME>/storages`) into the same bundle
 * the PostgreSQL import consumes. The Harness must be stopped: the JSON
 * backend has no cross-process lock.
 *
 *   pnpm storage:export-json --storages ~/.dsh/storages --out ./dev.bundle.json --confirm-harness-stopped --write
 */
const args = parseArgs(process.argv.slice(2))
if (args.confirmStopped !== true) throw new Error('Refusing to read the JSON storage until --confirm-harness-stopped is supplied.')
const root = resolve(args.storages)
const destination = resolve(args.out)
const sourceHash = sha256(await directoryDigest(root))
const bundle = await exportStorage(new JsonStorageBackend(root), STUDIO_DOMAIN_SPECS, sourceHash, new Date().toISOString(), 'json')
const counts = bundle.domains.map(domain => ({
  domain: domain.descriptor.name,
  records: Object.values(domain.snapshot.tables).reduce((total, table) => total + Object.keys(table).length, 0),
}))
if (args.write) await writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write(`${JSON.stringify({ mode: args.write ? 'write' : 'dry-run', destination: args.write ? destination : null, source: root, counts }, null, 2)}\n`)

/** Content digest of every file under the storage root, so the bundle records what it was taken from. */
async function directoryDigest(directory: string): Promise<string> {
  const entries = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
  const parts: string[] = []
  for (const file of entries) parts.push(`${file.slice(directory.length)}\0${sha256(await readFile(file))}`)
  return parts.join('\n')
}

function parseArgs(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(name)
    if (at < 0 || argv[at + 1] === undefined) throw new Error(`Missing ${name}`)
    return argv[at + 1]!
  }
  return {
    storages: value('--storages'),
    out: value('--out'),
    write: argv.includes('--write'),
    confirmStopped: argv.includes('--confirm-harness-stopped'),
  }
}
