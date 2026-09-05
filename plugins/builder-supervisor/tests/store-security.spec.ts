import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TEMPLATE_ENTRY_MAX_BYTES,
  TEMPLATE_STORE_MAX_ENTRIES,
  assertSafeStoreStat,
  assertSourceIdentity,
  canonicalSourceRoot,
  computeTemplateTreeSha256,
  imageDigestValue,
  isSafeStagingName,
  manifestReferencePath,
  parseTemplateStoreManifest,
  provisionIdentifier,
  sha256Value,
  templateEntryPath,
  templateVersion,
  type TemplateManifestEntry,
} from '../src/store-security.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('template store security contracts', () => {
  it('parses a strict sorted manifest and computes a domain-separated deterministic tree hash', () => {
    const entries: TemplateManifestEntry[] = [
      { path: 'z.txt', type: 'file', bytes: 1, sha256: 'b'.repeat(64) },
      { path: 'app', type: 'directory' },
      { path: 'app/a.txt', type: 'file', bytes: 0, sha256: 'a'.repeat(64) },
    ]
    const tree = computeTemplateTreeSha256('v1.2.3', entries)
    const parsed = parseTemplateStoreManifest({ version: 1, template_store_version: 'v1.2.3', tree_sha256: tree, entries })
    expect(parsed.entries.map(entry => entry.path)).toEqual(['app', 'app/a.txt', 'z.txt'])
    expect(tree).toMatch(/^[a-f0-9]{64}$/u)
    expect(computeTemplateTreeSha256('v1.2.4', entries)).not.toBe(tree)
    expect(() => computeTemplateTreeSha256('V1', entries)).toThrow('INVALID_TEMPLATE_STORE')
  })

  it.each([
    null, [], {},
    { version: 2, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries: [] },
    { version: 1, template_store_version: '../v1', tree_sha256: 'a'.repeat(64), entries: [] },
    { version: 1, template_store_version: 'v1', tree_sha256: 'z'.repeat(64), entries: [] },
    { version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries: 'bad' },
  ])('rejects malformed manifest envelope %#', value => {
    expect(() => parseTemplateStoreManifest(value)).toThrow('INVALID_TEMPLATE_STORE')
  })

  it('rejects unknown keys, duplicate paths, undeclared parents, malformed paths, bad file metadata and dishonest tree digests', () => {
    const invalidEntries: unknown[][] = [
      [{ path: 'a', type: 'directory', extra: true }],
      [{ path: 'a', type: 'directory' }, { path: 'a', type: 'directory' }],
      [{ path: 'App', type: 'directory' }, { path: 'app', type: 'directory' }],
      [{ path: 'a/b', type: 'file', bytes: 1, sha256: 'a'.repeat(64) }],
      [{ path: '../a', type: 'directory' }],
      [{ path: '/a', type: 'directory' }],
      [{ path: 'a\\b', type: 'directory' }],
      [{ path: 'café', type: 'directory' }],
      [{ path: 'a/', type: 'directory' }],
      [{ path: '.', type: 'directory' }],
      [{ path: 'a', type: 'file', bytes: -1, sha256: 'a'.repeat(64) }],
      [{ path: 'a', type: 'file', bytes: TEMPLATE_ENTRY_MAX_BYTES + 1, sha256: 'a'.repeat(64) }],
      [{ path: 'a', type: 'file', bytes: 1.5, sha256: 'a'.repeat(64) }],
      [{ path: 'a', type: 'file', bytes: 1, sha256: 'z'.repeat(64) }],
      [{ path: 'a', type: 'file', bytes: 1, sha256: 'a'.repeat(64), extra: true }],
      [null],
    ]
    for (const entries of invalidEntries) {
      expect(() => parseTemplateStoreManifest({ version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries })).toThrow('INVALID_TEMPLATE_STORE')
    }
    const entries = [{ path: 'a', type: 'directory' }]
    expect(() => parseTemplateStoreManifest({ version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries })).toThrow('INVALID_TEMPLATE_STORE')
  })

  it('rejects empty, excessive-entry and excessive-total-size manifests', () => {
    expect(() => parseTemplateStoreManifest({ version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries: [] })).toThrow('INVALID_TEMPLATE_STORE')
    const tooMany = Array.from({ length: TEMPLATE_STORE_MAX_ENTRIES + 1 }, (_, index) => ({ path: `f${index}`, type: 'file', bytes: 0, sha256: 'a'.repeat(64) }))
    expect(() => parseTemplateStoreManifest({ version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries: tooMany })).toThrow('INVALID_TEMPLATE_STORE')
    const huge = Array.from({ length: 9 }, (_, index) => ({ path: `f${index}`, type: 'file', bytes: TEMPLATE_ENTRY_MAX_BYTES, sha256: 'a'.repeat(64) }))
    expect(() => parseTemplateStoreManifest({ version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries: huge })).toThrow('INVALID_TEMPLATE_STORE')
  })

  it('validates identifiers, versions, digests, references, source roots and staging names', () => {
    expect(provisionIdentifier('tenant_one-2')).toBe('tenant_one-2')
    expect(templateVersion('v1.0.0@prod')).toBe('v1.0.0@prod')
    expect(sha256Value('a'.repeat(64))).toBe('a'.repeat(64))
    expect(imageDigestValue(`sha256:${'b'.repeat(64)}`)).toBe(`sha256:${'b'.repeat(64)}`)
    expect(canonicalSourceRoot('/opt/templates')).toBe('/opt/templates')
    expect(manifestReferencePath('file:/opt/manifest.json')).toBe('/opt/manifest.json')
    expect(isSafeStagingName(`.staging-${'a'.repeat(32)}`)).toBe(true)
    expect(isSafeStagingName(`.orphan-${'b'.repeat(32)}`)).toBe(true)
    expect(isSafeStagingName('.staging-../bad')).toBe(false)
    expect(templateEntryPath('app/(auth)/page.[id].tsx')).toBe('app/(auth)/page.[id].tsx')
    for (const value of ['', '../x', 'x/y', ' x', 'Tenant']) expect(() => provisionIdentifier(value)).toThrow()
    for (const value of ['', '../v', 'v/x', 'v '.padEnd(65, 'x')]) expect(() => templateVersion(value)).toThrow()
    expect(() => sha256Value('A'.repeat(64))).toThrow()
    expect(() => imageDigestValue(`sha256:${'A'.repeat(64)}`)).toThrow()
    for (const value of ['relative', '/', '/x/', '/x/../y', '/x\\y', 'http://x']) expect(() => canonicalSourceRoot(value)).toThrow()
    expect(() => manifestReferencePath('/opt/manifest.json')).toThrow()
  })

  it('classifies regular files/directories and rejects symlinks, hardlinks, wrong types and writable sealed entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-store-security-')); roots.push(root)
    const file = join(root, 'file'); const directory = join(root, 'dir'); const symbolic = join(root, 'symbolic'); const hard = join(root, 'hard')
    await writeFile(file, 'x', { mode: 0o444 }); await mkdir(directory, { mode: 0o555 }); await symlink(file, symbolic); await link(file, hard)
    const fileStat = await lstat(file); const directoryStat = await lstat(directory)
    expect(() => assertSafeStoreStat(directoryStat, 'directory', true)).not.toThrow()
    expect(() => assertSafeStoreStat(fileStat, 'file', false)).toThrow()
    await rm(hard)
    const single = await lstat(file)
    expect(() => assertSafeStoreStat(single, 'file', true)).not.toThrow()
    expect(() => assertSafeStoreStat(single, 'directory', false)).toThrow()
    expect(() => assertSafeStoreStat(directoryStat, 'file', false)).toThrow()
    const symbolicStat = await lstat(symbolic)
    expect(() => assertSafeStoreStat(symbolicStat, 'file', false)).toThrow()
    const writable = statWithMode(single, 0o644)
    expect(() => assertSafeStoreStat(writable, 'file', true)).toThrow()
    expect(() => assertSafeStoreStat(statWithMode(directoryStat, 0o755), 'directory', true)).toThrow()
    expect(() => assertSourceIdentity(single, single, 'file')).not.toThrow()
    expect(() => assertSourceIdentity(single, statWithInode(single, single.ino + 1), 'file')).toThrow()
    if (process.platform === 'linux') {
      const device = await lstat('/dev/null')
      expect(() => assertSafeStoreStat(device, 'file', false)).toThrow()
    }
  })

  it('rejects paths beyond the byte cap', () => {
    const longPath = 'a'.repeat(513)
    expect(() => parseTemplateStoreManifest({ version: 1, template_store_version: 'v1', tree_sha256: 'a'.repeat(64), entries: [{ path: longPath, type: 'directory' }] })).toThrow()
  })
})

function statWithMode(stat: Stats, mode: number): Stats {
  return new Proxy(stat, { get(target, property) { return property === 'mode' ? (target.mode & ~0o7777) | mode : Reflect.get(target, property, target) } })
}

function statWithInode(stat: Stats, ino: number): Stats {
  return new Proxy(stat, { get(target, property) { return property === 'ino' ? ino : Reflect.get(target, property, target) } })
}
