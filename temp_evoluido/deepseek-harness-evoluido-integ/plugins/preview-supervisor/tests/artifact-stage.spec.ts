import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { hashTree } from '../../prompt-to-app/src/runner.js'
import {
  createPreviewDataSeedArchive,
  createVerifiedRuntimeArchive,
  MAX_PREVIEW_RUNTIME_BYTES,
  MAX_PREVIEW_SOURCE_BYTES,
} from '../src/artifact-stage.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
}, 60_000)

describe('verified preview runtime archive', () => {
  it('seeds preview data as owner-writable and group-readable only', () => {
    const entries = readTar(createPreviewDataSeedArchive())

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'data/', type: '5', mode: 0o750, uid: 10001, gid: 10001 })
  })

  it('uses the Prompt-to-App canonical hash and packages only standalone, public and static runtime files', async () => {
    const fixture = await runtimeFixture()
    const expected = await hashTree(fixture.source)

    const result = await createVerifiedRuntimeArchive(fixture.root, 'run', expected, new AbortController().signal)
    const entries = readTar(result.archive)

    expect(result.sourceSha256).toBe(expected)
    expect(result.sourceFiles).toBe(5)
    expect(entries.filter(entry => entry.type === '0').map(entry => entry.name)).toEqual([
      '.next/static/chunks/app.js',
      'node_modules/example/index.js',
      'public/logo.txt',
      'server.js',
    ])
    expect(entries.find(entry => entry.name === 'server.js')?.body.toString('utf8')).toBe('server')
    expect(entries.some(entry => entry.name === 'ignored-source.txt')).toBe(false)
    expect(entries.filter(entry => entry.type === '0').every(entry => entry.mode === 0o444)).toBe(true)
    expect(entries.filter(entry => entry.type === '5').every(entry => entry.mode === 0o555)).toBe(true)
    expect(entries.every(entry => entry.uid === 10001 && entry.gid === 10001 && entry.mtime === 0)).toBe(true)
  })

  it('rejects a source hash that differs by one byte', async () => {
    const fixture = await runtimeFixture()
    const expected = await hashTree(fixture.source)
    await writeFile(join(fixture.source, 'ignored-source.txt'), 'changed')

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', expected)).rejects.toThrow('ARTIFACT_HASH_MISMATCH')
  })

  it('rejects source traversal even when the target exists and has a valid canonical hash', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'artifacts')
    const outside = join(parent, 'outside')
    await mkdir(root)
    await writeRuntime(outside)

    await expect(createVerifiedRuntimeArchive(root, '../outside', await hashTree(outside))).rejects.toThrow('ARTIFACT_OUTSIDE_ROOT')
  })

  it.runIf(process.platform !== 'win32')('rejects symbolic links anywhere in the artifact tree', async () => {
    const fixture = await runtimeFixture()
    await symlink(join(fixture.source, 'public', 'logo.txt'), join(fixture.source, 'public', 'alias.txt'))

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', 'a'.repeat(64))).rejects.toThrow('ARTIFACT_SYMLINK')
  })

  it.runIf(process.platform !== 'win32')('rejects sockets and other special filesystem entries', async () => {
    const fixture = await runtimeFixture()
    const socketPath = join(fixture.source, 'public', 'runtime.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(createVerifiedRuntimeArchive(fixture.root, 'run', 'a'.repeat(64))).rejects.toThrow('ARTIFACT_UNSAFE_ENTRY')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('rejects hard-linked files instead of archiving shared inodes', async () => {
    const fixture = await runtimeFixture()
    await link(join(fixture.source, 'public', 'logo.txt'), join(fixture.source, 'public', 'alias.txt'))

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', await hashTree(fixture.source))).rejects.toThrow('ARTIFACT_UNSAFE_ENTRY')
  })

  it.runIf(process.platform !== 'win32')('rejects names that collide on case-insensitive filesystems', async () => {
    const fixture = await runtimeFixture()
    await writeFile(join(fixture.source, 'public', 'Logo.txt'), 'different')

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', await hashTree(fixture.source))).rejects.toThrow('ARTIFACT_CASE_COLLISION')
  })

  it('rejects a runtime archive path that cannot be represented safely by ustar', async () => {
    const fixture = await runtimeFixture()
    const longDirectory = 'a'.repeat(156)
    const longFile = `${'b'.repeat(101)}.js`
    await mkdir(join(fixture.source, '.next', 'standalone', longDirectory))
    await writeFile(join(fixture.source, '.next', 'standalone', longDirectory, longFile), 'long')

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', await hashTree(fixture.source))).rejects.toThrow('ARTIFACT_PATH_TOO_LONG')
  })

  it('rejects an artifact without the standalone server entry', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'artifacts')
    const source = join(root, 'run')
    await mkdir(join(source, '.next', 'static'), { recursive: true })
    await writeFile(join(source, '.next', 'static', 'app.js'), 'static')

    await expect(createVerifiedRuntimeArchive(root, 'run', await hashTree(source))).rejects.toThrow('STANDALONE_SERVER_MISSING')
  })

  it('enforces the 20,000-source-file ceiling before reading or archiving entries', async () => {
    const parent = await temporaryDirectory()
    const root = join(parent, 'artifacts')
    const source = join(root, 'run')
    await mkdir(source, { recursive: true })
    for (let offset = 0; offset < 20_001; offset += 500) {
      await Promise.all(Array.from({ length: Math.min(500, 20_001 - offset) }, (_, index) =>
        writeFile(join(source, `f-${String(offset + index).padStart(5, '0')}`), ''),
      ))
    }

    await expect(createVerifiedRuntimeArchive(root, 'run', 'a'.repeat(64))).rejects.toThrow('ARTIFACT_FILE_LIMIT')
  }, 30_000)

  it('rejects an oversized source from metadata before allocating its contents', async () => {
    const fixture = await runtimeFixture()
    const oversized = join(fixture.source, 'oversized-source.bin')
    const handle = await open(oversized, 'w')
    try { await handle.truncate(MAX_PREVIEW_SOURCE_BYTES + 1) } finally { await handle.close() }

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', 'a'.repeat(64))).rejects.toThrow('ARTIFACT_SIZE_LIMIT')
  })

  it('rejects an oversized runtime from metadata before allocating its contents', async () => {
    const fixture = await runtimeFixture()
    const oversized = join(fixture.source, '.next', 'standalone', 'oversized-runtime.bin')
    const handle = await open(oversized, 'w')
    try { await handle.truncate(MAX_PREVIEW_RUNTIME_BYTES + 1) } finally { await handle.close() }

    await expect(createVerifiedRuntimeArchive(fixture.root, 'run', 'a'.repeat(64))).rejects.toThrow('RUNTIME_SIZE_LIMIT')
  })

  it('stops staging immediately when supervisor shutdown aborts the request', async () => {
    const fixture = await runtimeFixture()
    const controller = new AbortController()
    controller.abort(new Error('SUPERVISOR_SHUTDOWN'))

    await expect(createVerifiedRuntimeArchive(
      fixture.root, 'run', await hashTree(fixture.source), controller.signal,
    )).rejects.toThrow('SUPERVISOR_SHUTDOWN')
  })
})

async function runtimeFixture(): Promise<{ readonly root: string; readonly source: string }> {
  const parent = await temporaryDirectory()
  const root = join(parent, 'artifacts')
  const source = join(root, 'run')
  await writeRuntime(source)
  await writeFile(join(source, 'ignored-source.txt'), 'source-only')
  return { root, source }
}

async function writeRuntime(source: string): Promise<void> {
  await mkdir(join(source, '.next', 'standalone', 'node_modules', 'example'), { recursive: true })
  await mkdir(join(source, '.next', 'static', 'chunks'), { recursive: true })
  await mkdir(join(source, 'public'), { recursive: true })
  await writeFile(join(source, '.next', 'standalone', 'server.js'), 'server')
  await writeFile(join(source, '.next', 'standalone', 'node_modules', 'example', 'index.js'), 'dependency')
  await writeFile(join(source, '.next', 'static', 'chunks', 'app.js'), 'static')
  await writeFile(join(source, 'public', 'logo.txt'), Buffer.alloc(512))
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dz23-preview-artifact-'))
  temporaryRoots.push(path)
  return path
}

interface TarEntry {
  readonly name: string
  readonly type: string
  readonly mode: number
  readonly uid: number
  readonly gid: number
  readonly mtime: number
  readonly body: Buffer
}

function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = text(header, 0, 100)
    const prefix = text(header, 345, 155)
    const size = octal(header, 124, 12)
    entries.push({
      name: prefix === '' ? name : `${prefix}/${name}`,
      type: String.fromCharCode(header[156] ?? 0),
      mode: octal(header, 100, 8),
      uid: octal(header, 108, 8),
      gid: octal(header, 116, 8),
      mtime: octal(header, 136, 12),
      body: archive.subarray(offset + 512, offset + 512 + size),
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function text(buffer: Buffer, offset: number, length: number): string {
  const zero = buffer.subarray(offset, offset + length).indexOf(0)
  return buffer.subarray(offset, offset + (zero < 0 ? length : zero)).toString('utf8')
}

function octal(buffer: Buffer, offset: number, length: number): number {
  return Number.parseInt(text(buffer, offset, length).trim() || '0', 8)
}
