import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Deterministic worker version: a digest of the app version and of every file
 * that ends up in the shell (interface sources, worker sources, manifest,
 * icons). Rebuilding the same commit yields the same version, so clients keep
 * their cache; any real change yields a new one, so old caches are dropped.
 */
export function swVersion(root = resolve(__dirname)): string {
  const hash = createHash('sha256')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }
  hash.update(pkg.version ?? '0')
  const files = [join(root, 'index.html'), ...walk(join(root, 'src')), ...walk(join(root, 'public'))]
  for (const file of files) hash.update(file.slice(root.length)).update(readFileSync(file))
  return `${pkg.version ?? '0'}-${hash.digest('hex').slice(0, 12)}`
}

function walk(path: string): string[] {
  const entries = readdirSync(path, { withFileTypes: true }).filter(entry => !entry.name.endsWith('.spec.ts'))
  return entries.flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]).sort()
}
