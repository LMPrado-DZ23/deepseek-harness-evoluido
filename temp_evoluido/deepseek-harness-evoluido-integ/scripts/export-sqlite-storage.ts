import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { STUDIO_DOMAIN_SPECS } from './studio-domain-specs.ts'
import { exportStorage, sha256 } from './storage-migration.ts'

const args = parseArgs(process.argv.slice(2))
if (args.confirmStopped !== true) throw new Error('Refusing to read SQLite until --confirm-harness-stopped is supplied.')
const source = resolve(args.sqlite)
const destination = resolve(args.out)
const temporary = await mkdtemp(join(tmpdir(), 'dz23-storage-export-'))
const snapshot = join(temporary, basename(source))
try {
  const database = new DatabaseSync(source, { readOnly: true })
  try {
    database.prepare('VACUUM INTO ?').run(snapshot)
  } finally {
    database.close()
  }
  const sourceHash = sha256(await readFile(snapshot))
  const bundle = await exportStorage(new SqliteStorageBackend({ path: snapshot, journalMode: 'delete' }), STUDIO_DOMAIN_SPECS, sourceHash)
  const counts = bundle.domains.map(domain => ({
    domain: domain.descriptor.name,
    records: Object.values(domain.snapshot.tables).reduce((total, table) => total + Object.keys(table).length, 0),
  }))
  if (args.write) await writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ mode: args.write ? 'write' : 'dry-run', destination: args.write ? destination : null, counts }, null, 2)}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function parseArgs(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(name)
    if (at < 0 || argv[at + 1] === undefined) throw new Error(`Missing ${name}`)
    return argv[at + 1]!
  }
  return {
    sqlite: value('--sqlite'),
    out: value('--out'),
    write: argv.includes('--write'),
    confirmStopped: argv.includes('--confirm-harness-stopped'),
  }
}
