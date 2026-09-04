import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import type { BuilderExecutionPort } from '../src/docker-adapter.js'
import type { BuildStep, StepResult } from '../src/model.js'
import { BuilderSupervisor } from '../src/service.js'

const roots: string[] = []
const req = (digit: string) => `req_${digit.repeat(32)}`
const ref = `build_${'f'.repeat(32)}`
const ok: StepResult = { exit_code: 0, stdout: 'ok', stderr: '', timed_out: false, output_limited: false }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('builder supervisor orchestration', () => {
  it('prepares a verified artifact, enforces every step and finishes with cleanup', async () => {
    const fixture = await artifactFixture()
    const adapter = fakeAdapter()
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal

    await expect(service.preflight({ request_id: req('0') }, signal)).resolves.toEqual({ state: 'OK' })
    await expect(service.prepare({ request_id: req('1'), build_id: 'run-1', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)).resolves.toEqual({ build_ref: ref, state: 'PREPARED' })
    const artifact = vi.mocked(adapter.prepare).mock.calls[0]?.[2]
    expect(artifact).toMatchObject({ sha256: fixture.hash, files: 2, bytes: 9 })
    expect(artifact?.archive.subarray(-1024).every(byte => byte === 0)).toBe(true)

    for (const [index, step] of (['install', 'build', 'unit', 'e2e'] as const).entries()) {
      const result = await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
      expect(result).toMatchObject({ build_ref: ref, step, result: ok })
    }
    await expect(service.listManaged({ request_id: req('6') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'run-1', state: 'E2E_OK' }] })
    await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).resolves.toEqual({ build_ref: ref, final_state: 'E2E_OK', cleaned: true })
    expect(adapter.finish).toHaveBeenCalledWith(ref, 'E2E_OK', signal)
    await expect(service.listManaged({ request_id: req('8') }, signal)).resolves.toEqual({ builds: [] })
  })

  it('rejects skips, duplicate builds, nonterminal finish, unknown builds and replay', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    const prepare = { request_id: req('1'), build_id: 'same', artifact_relative_path: 'run', artifact_sha256: fixture.hash }
    await service.prepare(prepare, signal)
    await expect(service.prepare({ ...prepare, request_id: req('2') }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    await expect(service.execute({ request_id: req('3'), build_ref: ref, step: 'build' }, signal)).rejects.toThrow('INVALID_STEP_ORDER')
    await expect(service.finish({ request_id: req('4'), build_ref: ref }, signal)).rejects.toThrow('BUILD_NOT_TERMINAL')
    await expect(service.cancel({ request_id: req('5'), build_ref: `build_${'e'.repeat(32)}` }, signal)).rejects.toThrow('BUILD_NOT_FOUND')
    await expect(service.listManaged({ request_id: req('5') }, signal)).rejects.toThrow('REQUEST_REPLAY')
  })

  it('marks a failed step terminal and allows explicit cleanup', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    vi.mocked(adapter.execute).mockResolvedValueOnce({ ...ok, exit_code: 1, stderr: 'failed' })
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'run-fail', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)
    await expect(service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)).resolves.toMatchObject({ state: 'FAILED' })
    await expect(service.execute({ request_id: req('3'), build_ref: ref, step: 'build' }, signal)).rejects.toThrow('INVALID_STEP_ORDER')
    await expect(service.cancel({ request_id: req('5'), build_ref: ref }, signal)).rejects.toThrow('INVALID_STEP_ORDER')
    await expect(service.finish({ request_id: req('4'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'FAILED', cleaned: true })
  })

  it('cancels an active execution and does not overwrite CANCELLED when the adapter unwinds', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    vi.mocked(adapter.execute).mockImplementation(async (_buildRef, _step, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'run-cancel', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)
    const pending = service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)
    await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalled())
    await expect(service.cancel({ request_id: req('3'), build_ref: ref }, signal)).resolves.toEqual({ build_ref: ref, state: 'CANCELLED' })
    await expect(pending).rejects.toThrow('BUILD_CANCELLED')
    await expect(service.listManaged({ request_id: req('4') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'run-cancel', state: 'CANCELLED' }] })
    await expect(service.finish({ request_id: req('5'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'CANCELLED' })
  })

  it('releases a build id after failed staging and rejects traversal outside the configured root', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await expect(service.prepare({ request_id: req('1'), build_id: 'retry', artifact_relative_path: 'run', artifact_sha256: 'a'.repeat(64) }, signal)).rejects.toThrow('ARTIFACT_HASH_MISMATCH')
    await expect(service.prepare({ request_id: req('2'), build_id: 'retry', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)).resolves.toMatchObject({ state: 'PREPARED' })
    const outside = `${fixture.root}-outside`; roots.push(outside); await mkdir(outside); await writeFile(join(outside, 'a'), 'a')
    await expect(createVerifiedBuildArchive(fixture.root, `../${basename(outside)}`, await hashTree(outside))).rejects.toThrow('ARTIFACT_OUTSIDE_ROOT')
  })

  it('marks unexpected adapter execution failures as FAILED', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    vi.mocked(adapter.execute).mockRejectedValueOnce(new Error('engine down'))
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'run-error', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)
    await expect(service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)).rejects.toThrow('engine down')
    await expect(service.listManaged({ request_id: req('3') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'run-error', state: 'FAILED' }] })
  })

  it('rejects a malformed or already-managed server-generated reference', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const signal = new AbortController().signal
    const malformed = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => 'bad' })
    await expect(malformed.prepare({ request_id: req('1'), build_id: 'bad-ref', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    vi.mocked(adapter.listManaged).mockResolvedValueOnce([ref])
    const occupied = new BuilderSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    await expect(occupied.prepare({ request_id: req('2'), build_id: 'occupied', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
  })

  it('creates a cryptographically random reference when no test factory is supplied', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const signal = new AbortController().signal
    const service = new BuilderSupervisor({ artifactRoot: fixture.root, adapter })
    await expect(service.prepare({ request_id: req('1'), build_id: 'random-ref', artifact_relative_path: 'run', artifact_sha256: fixture.hash }, signal)).resolves.toMatchObject({ build_ref: expect.stringMatching(/^build_[a-f0-9]{32}$/u) })
  })
})

describe('verified build archive', () => {
  it('rejects hard links and, where supported, symbolic links', async () => {
    const fixture = await artifactFixture()
    await link(join(fixture.source, 'a.txt'), join(fixture.source, 'alias.txt'))
    await expect(createVerifiedBuildArchive(fixture.root, 'run', await hashTree(fixture.source))).rejects.toThrow('ARTIFACT_UNSAFE_ENTRY')
    await rm(join(fixture.source, 'alias.txt'))
    if (process.platform !== 'win32') {
      await symlink(join(fixture.source, 'a.txt'), join(fixture.source, 'alias.txt'))
      await expect(createVerifiedBuildArchive(fixture.root, 'run', fixture.hash)).rejects.toThrow('ARTIFACT_UNSAFE_ENTRY')
    }
  })
})

function fakeAdapter(): BuilderExecutionPort {
  return {
    preflight: vi.fn(async () => 'OK' as const),
    prepare: vi.fn(async () => undefined),
    execute: vi.fn(async (_buildRef: string, _step: BuildStep) => ok),
    cancel: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
    listManaged: vi.fn(async () => []),
  }
}

async function artifactFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-builder-supervisor-')); roots.push(root)
  const source = join(root, 'run'); await mkdir(join(source, 'nested'), { recursive: true })
  await writeFile(join(source, 'a.txt'), 'alpha'); await writeFile(join(source, 'nested', 'b.txt'), 'beta')
  return { root, source, hash: await hashTree(source) }
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`; const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, relative)
      else hash.update(relative).update('\0').update(await readFile(path)).update('\0')
    }
  }
  await walk(root); return hash.digest('hex')
}
