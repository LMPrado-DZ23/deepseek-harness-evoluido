import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashTree, listTreeFiles, materializePreviewArtifact, PREVIEW_ARTIFACT_RELATIVE_PATH } from '../src/runner.js'

const onUnix = process.platform !== 'win32'
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
}, 60_000)

describe.skipIf(!onUnix)('preview artifact materialization', () => {
  it('dereferences an internal pnpm-style dependency link into regular entries with a stable canonical hash', async () => {
    const first = await linkedRuntimeFixture('first')
    const second = await linkedRuntimeFixture('second')

    const firstArtifact = await materializePreviewArtifact(first)
    const secondArtifact = await materializePreviewArtifact(second)
    const materializedPackage = join(firstArtifact.path, '.next', 'standalone', 'node_modules', 'example')
    const materializedFile = join(materializedPackage, 'index.js')

    expect((await lstat(materializedPackage)).isDirectory()).toBe(true)
    expect((await lstat(materializedPackage)).isSymbolicLink()).toBe(false)
    expect((await lstat(materializedFile)).isFile()).toBe(true)
    expect((await lstat(materializedFile)).isSymbolicLink()).toBe(false)
    expect(await readFile(materializedFile, 'utf8')).toBe('export const value = 23\n')
    expect(firstArtifact.sha256).toBe(await hashTree(firstArtifact.path))
    expect(secondArtifact.sha256).toBe(firstArtifact.sha256)
  })

  it('rejects a dependency link whose real target escapes the generated run', async () => {
    const parent = await temporaryDirectory('outside')
    const run = await baseRuntime(join(parent, 'run'))
    const outside = join(parent, 'outside-package')
    await mkdir(outside)
    await writeFile(join(outside, 'index.js'), 'outside')
    await mkdir(join(run, '.next', 'standalone', 'node_modules'), { recursive: true })
    await symlink(outside, join(run, '.next', 'standalone', 'node_modules', 'escaped'), 'dir')

    await expect(materializePreviewArtifact(run)).rejects.toThrow('PREVIEW_ARTIFACT_LINK_OUTSIDE_RUN')
  })

  it('rejects a symlink cycle before it can recurse or cross the supervisor boundary', async () => {
    const run = await baseRuntime(await temporaryDirectory('cycle'))
    const packageRoot = join(run, 'node_modules', 'cycle-package')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'index.js'), 'cycle')
    await symlink('.', join(packageRoot, 'back'), 'dir')
    await mkdir(join(run, '.next', 'standalone', 'node_modules'), { recursive: true })
    await symlink('../../../node_modules/cycle-package', join(run, '.next', 'standalone', 'node_modules', 'cycle-package'), 'dir')

    await expect(materializePreviewArtifact(run)).rejects.toThrow('PREVIEW_ARTIFACT_LINK_INVALID')
  })

  it('contains only standalone, static and public files', async () => {
    const run = await baseRuntime(await temporaryDirectory('allowlist'))
    await mkdir(join(run, 'src'), { recursive: true })
    await mkdir(join(run, 'private'), { recursive: true })
    await writeFile(join(run, 'src', 'secret.ts'), 'not runtime')
    await writeFile(join(run, 'private', 'credential.txt'), 'not runtime')
    await writeFile(join(run, '.env'), 'NOT_A_REAL_SECRET=test')

    const artifact = await materializePreviewArtifact(run)
    const files = await listTreeFiles(artifact.path)

    expect(relative(run, artifact.path).replaceAll('\\', '/')).toBe(PREVIEW_ARTIFACT_RELATIVE_PATH)
    expect(files).toEqual([
      '.next/standalone/server.js',
      '.next/static/chunks/app.js',
      'public/logo.txt',
    ])
    expect(JSON.stringify(files)).not.toContain('.env')
    expect(JSON.stringify(files)).not.toContain('secret')
    expect(JSON.stringify(files)).not.toContain('credential')
  })

  it('rejects a source tree above the 20,000-file ceiling', async () => {
    const run = await baseRuntime(await temporaryDirectory('file-limit'))
    const crowded = join(run, '.next', 'static', 'crowded')
    await mkdir(crowded, { recursive: true })
    for (let offset = 0; offset < 20_001; offset += 500) {
      await Promise.all(Array.from({ length: Math.min(500, 20_001 - offset) }, (_, index) =>
        writeFile(join(crowded, `f-${String(offset + index).padStart(5, '0')}`), ''),
      ))
    }

    await expect(materializePreviewArtifact(run)).rejects.toThrow('PREVIEW_ARTIFACT_LIMIT')
  }, 60_000)

  it('rejects a source tree above the 256 MiB byte ceiling before copying the oversized file', async () => {
    const run = await baseRuntime(await temporaryDirectory('byte-limit'))
    const oversized = join(run, '.next', 'static', 'oversized.bin')
    const file = await open(oversized, 'w')
    try { await file.truncate(256 * 1024 * 1024 + 1) } finally { await file.close() }

    await expect(materializePreviewArtifact(run)).rejects.toThrow('PREVIEW_ARTIFACT_LIMIT')
  })
})

async function linkedRuntimeFixture(name: string): Promise<string> {
  const run = await baseRuntime(await temporaryDirectory(name))
  const packageRoot = join(run, 'node_modules', 'example')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'index.js'), 'export const value = 23\n')
  await mkdir(join(run, '.next', 'standalone', 'node_modules'), { recursive: true })
  await symlink('../../../node_modules/example', join(run, '.next', 'standalone', 'node_modules', 'example'), 'dir')
  return run
}

async function baseRuntime(run: string): Promise<string> {
  await mkdir(join(run, '.next', 'standalone'), { recursive: true })
  await mkdir(join(run, '.next', 'static', 'chunks'), { recursive: true })
  await mkdir(join(run, 'public'), { recursive: true })
  await writeFile(join(run, '.next', 'standalone', 'server.js'), 'server')
  await writeFile(join(run, '.next', 'static', 'chunks', 'app.js'), 'static')
  await writeFile(join(run, 'public', 'logo.txt'), 'logo')
  return run
}

async function temporaryDirectory(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dz23-preview-${name}-`))
  temporaryRoots.push(path)
  return path
}
