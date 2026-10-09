import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import { ArtifactIngressError, type ArtifactIngressPort } from '../src/artifact-ingress.js'
import type { BuilderExecutionPort } from '../src/docker-adapter.js'
import { BuilderSupervisorError, type BuildStep, type StepResult } from '../src/model.js'
import { FileBuildIdGuard, type BuildIdClaimPort, type BuildJournalRecord } from '../src/persistent-replay.js'
import { BuilderSupervisor, type BuilderSupervisorOptions } from '../src/service.js'

const roots: string[] = []
const req = (digit: string) => `req_${digit.repeat(32)}`
const ref = `build_${'f'.repeat(32)}`
const uploadRef = `upload_${'a'.repeat(32)}`
const ok: StepResult = { exit_code: 0, stdout: 'ok', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false }

function testSupervisor(options: Omit<BuilderSupervisorOptions, 'buildClaims' | 'artifactIngress'> & { readonly artifactRoot: string; readonly artifactIngress?: ArtifactIngressPort; readonly buildClaims?: Partial<BuildIdClaimPort> }): BuilderSupervisor {
  const journal = memoryJournal(); const custom = options.buildClaims
  const buildClaims: BuildIdClaimPort = {
    claim: async (id, buildRef) => { await custom?.claim?.(id, buildRef); await journal.claim(id, buildRef) },
    update: async record => { await custom?.update?.(record); await journal.update(record) },
    release: async id => { await custom?.release?.(id); await journal.release(id) },
    complete: async record => { await custom?.complete?.(record); await journal.complete(record) },
    list: custom?.list ?? journal.list,
  }
  const { artifactRoot, artifactIngress = fixtureIngress(artifactRoot), ...rest } = options
  return new BuilderSupervisor({ ...rest, artifactIngress, buildClaims })
}

function fixtureIngress(root: string): ArtifactIngressPort {
  return {
    begin: async () => { throw new Error('TEST_ONLY') },
    upload: async () => { throw new Error('TEST_ONLY') },
    abort: async () => undefined,
    sweep: async () => 0,
    claim: async () => {
      const artifact = await createVerifiedBuildArchive(root, 'run')
      let settled = false
      const settle = async () => { if (!settled) { settled = true; await artifact.dispose() } }
      return { artifact, complete: settle, fail: settle }
    },
  }
}

function memoryJournal(): BuildIdClaimPort {
  const records = new Map<string, BuildJournalRecord>()
  return {
    claim: async (buildId, buildRef) => { if (records.has(buildId)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS'); records.set(buildId, { build_id: buildId, build_ref: buildRef, build_state: 'PREPARED', exported: null, cleanup_pending: false, finish_result: null, finish_error: null }) },
    update: async record => { if (!records.has(record.build_id)) throw new BuilderSupervisorError('RECOVERY_FAILED'); records.set(record.build_id, structuredClone(record)) },
    release: async buildId => { records.delete(buildId) },
    complete: async record => { if (!records.has(record.build_id)) throw new BuilderSupervisorError('RECOVERY_FAILED'); records.set(record.build_id, structuredClone(record)) },
    list: async () => [...records.values()].map(record => structuredClone(record)),
  }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('builder supervisor orchestration', () => {
  it('validates the managed-build limit at both boundaries', () => {
    const adapter = fakeAdapter()
    for (const maxBuilds of [Number.NaN, 0, 1_001]) {
      expect(() => testSupervisor({ artifactRoot: 'unused', adapter, maxBuilds })).toThrow('INVALID_BUILD_LIMIT')
    }
    expect(() => testSupervisor({ artifactRoot: 'unused', adapter, maxBuilds: 1 })).not.toThrow()
    expect(() => testSupervisor({ artifactRoot: 'unused', adapter, maxBuilds: 1_000 })).not.toThrow()
  })

  it('initializes once, retries a failed reconciliation and rejects ambiguous recovered ownership', async () => {
    const signal = new AbortController().signal
    const retryAdapter = fakeAdapter()
    vi.mocked(retryAdapter.reconcile).mockRejectedValueOnce(new Error('reconcile unavailable')).mockResolvedValueOnce([])
    const retrying = testSupervisor({ artifactRoot: 'unused', adapter: retryAdapter })
    await expect(retrying.initialize(signal)).rejects.toThrow('reconcile unavailable')
    await expect(retrying.initialize(signal)).resolves.toBeUndefined()
    await expect(retrying.initialize(signal)).resolves.toBeUndefined()
    expect(retryAdapter.reconcile).toHaveBeenCalledTimes(2)

    const recoveredRef = `build_${'a'.repeat(32)}`; const secondRef = `build_${'b'.repeat(32)}`
    for (const recovered of [
      [{ build_ref: recoveredRef, build_id: 'one' }, { build_ref: secondRef, build_id: 'one' }],
      [{ build_ref: recoveredRef, build_id: 'one' }, { build_ref: recoveredRef, build_id: 'two' }],
    ]) {
      const adapter = fakeAdapter(); vi.mocked(adapter.reconcile).mockResolvedValueOnce(recovered)
      await expect(testSupervisor({ artifactRoot: 'unused', adapter }).initialize(signal)).rejects.toThrow('RECOVERY_FAILED')
    }
    const duplicate: BuildIdClaimPort = { ...memoryJournal(), list: async () => [
      { build_id: 'same', build_ref: recoveredRef, build_state: 'CANCELLED', exported: null, cleanup_pending: false, finish_result: { build_ref: recoveredRef, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true }, finish_error: null },
      { build_id: 'same', build_ref: secondRef, build_state: 'CANCELLED', exported: null, cleanup_pending: false, finish_result: { build_ref: secondRef, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true }, finish_error: null },
    ] }
    await expect(new BuilderSupervisor({ artifactIngress: fixtureIngress('unused'), adapter: fakeAdapter(), buildClaims: duplicate }).initialize(signal)).rejects.toThrow('RECOVERY_FAILED')
  })

  it('restores a durable terminal error and matching Docker ownership without redispatch', async () => {
    const signal = new AbortController().signal; const adapter = fakeAdapter(); const finishError: BuildJournalRecord = { build_id: 'stored-error', build_ref: ref, build_state: 'E2E_OK', exported: null, cleanup_pending: false, finish_result: null, finish_error: 'EXPORT_INVALID' }
    const journal: BuildIdClaimPort = { ...memoryJournal(), list: async () => [finishError] }; vi.mocked(adapter.reconcile).mockResolvedValueOnce([{ build_ref: ref, build_id: 'stored-error' }])
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress('unused'), adapter, buildClaims: journal })
    await service.initialize(signal); await expect(service.finish({ request_id: req('1'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID'); expect(adapter.exportArtifact).not.toHaveBeenCalled()
  })

  it('prepares a verified artifact, enforces every step and finishes with cleanup', async () => {
    const fixture = await artifactFixture()
    const adapter = fakeAdapter()
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal

    await expect(service.preflight({ request_id: req('0') }, signal)).resolves.toMatchObject({ state: 'OK', protocol_version: 1 })
    await expect(service.prepare({ request_id: req('1'), build_id: 'run-1', upload_ref: uploadRef }, signal)).resolves.toEqual({ build_ref: ref, state: 'PREPARED' })
    const artifact = vi.mocked(adapter.prepare).mock.calls[0]?.[2]
    expect(artifact).toMatchObject({ sha256: fixture.hash, files: 2, bytes: 9 })
    expect(artifact).toMatchObject({ archivePath: expect.stringMatching(/input\.tar$/u), archiveBytes: expect.any(Number) })

    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) {
      const result = await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
      expect(result).toMatchObject({ build_ref: ref, step, result: ok })
    }
    await expect(service.listManaged({ request_id: req('6') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'run-1', state: 'E2E_OK', exported: false, cleanup_pending: false }] })
    await expect(service.listManaged({ request_id: req('9'), build_id: 'another-run' }, signal)).resolves.toEqual({ builds: [] })
    await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).resolves.toEqual({ build_ref: ref, final_state: 'E2E_OK', exported: { relative_path: `exports/${ref}`, sha256: 'e'.repeat(64), files: 1, bytes: 1 }, cleanup_pending: false, cleaned: true })
    expect(adapter.exportArtifact).toHaveBeenCalledWith(ref, expect.any(AbortSignal)); expect(vi.mocked(adapter.exportArtifact).mock.calls[0]![1]).not.toBe(signal); expect(adapter.cleanup).toHaveBeenCalledWith(ref, expect.any(AbortSignal)); expect(vi.mocked(adapter.cleanup).mock.calls[0]![1]).not.toBe(signal)
    await expect(service.finish({ request_id: req('8'), build_ref: ref }, signal)).resolves.toMatchObject({ cleaned: true })
    expect(adapter.exportArtifact).toHaveBeenCalledTimes(1); expect(adapter.cleanup).toHaveBeenCalledTimes(1)
  })

  it('sorts more than one managed build by its opaque reference', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const refs = [`build_${'b'.repeat(32)}`, `build_${'a'.repeat(32)}`]; let index = 0
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => refs[index++]! }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'second', upload_ref: uploadRef }, signal)
    await service.prepare({ request_id: req('2'), build_id: 'first', upload_ref: uploadRef }, signal)
    const result = await service.listManaged({ request_id: req('3') }, signal)
    expect(result.builds.map(build => build.build_ref)).toEqual([refs[1], refs[0]])
  })

  it('rejects skips, duplicate builds, nonterminal finish, unknown builds and replay', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    const prepare = { request_id: req('1'), build_id: 'same', upload_ref: uploadRef }
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
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'run-fail', upload_ref: uploadRef }, signal)
    await expect(service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)).resolves.toMatchObject({ state: 'FAILED' })
    await expect(service.execute({ request_id: req('3'), build_ref: ref, step: 'build' }, signal)).rejects.toThrow('INVALID_STEP_ORDER')
    await expect(service.cancel({ request_id: req('5'), build_ref: ref }, signal)).rejects.toThrow('INVALID_STEP_ORDER')
    await expect(service.finish({ request_id: req('4'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'FAILED', cleaned: true })
  })

  it('marks the durable build-id claim complete only after observed cleanup', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); vi.mocked(adapter.execute).mockResolvedValueOnce({ ...ok, exit_code: 1 })
    const claims = { claim: vi.fn(async () => undefined), release: vi.fn(async () => undefined), complete: vi.fn(async () => undefined) }
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref, buildClaims: claims }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'completed-claim', upload_ref: uploadRef }, signal)
    await service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)
    expect(claims.complete).not.toHaveBeenCalled()
    await service.finish({ request_id: req('3'), build_ref: ref }, signal)
    expect(claims.complete).toHaveBeenCalledWith(expect.objectContaining({ build_id: 'completed-claim', finish_result: expect.objectContaining({ cleaned: true }) }))
  })

  it('cancels an active execution and does not overwrite CANCELLED when the adapter unwinds', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    vi.mocked(adapter.execute).mockImplementation(async (_buildRef, _step, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'run-cancel', upload_ref: uploadRef }, signal)
    const pending = service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)
    await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalled())
    await expect(service.cancel({ request_id: req('3'), build_ref: ref }, signal)).resolves.toEqual({ build_ref: ref, state: 'CANCELLED' })
    expect(vi.mocked(adapter.cancel).mock.calls[0]![1]).not.toBe(signal)
    await expect(pending).rejects.toThrow('BUILD_CANCELLED')
    await expect(service.listManaged({ request_id: req('4') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'run-cancel', state: 'CANCELLED', exported: false, cleanup_pending: true }] })
    await expect(service.finish({ request_id: req('5'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'CANCELLED' })
  })

  it('keeps CANCELLED when a cooperative adapter resolves after cancellation', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); let resolveExecution!: (value: StepResult) => void
    vi.mocked(adapter.execute).mockImplementation(async () => new Promise<StepResult>(resolve => { resolveExecution = resolve }))
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'cancel-resolve', upload_ref: uploadRef }, signal)
    const pending = service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)
    await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalled())
    await service.cancel({ request_id: req('3'), build_ref: ref }, signal); resolveExecution(ok)
    await expect(pending).resolves.toMatchObject({ state: 'CANCELLED' })
  })

  it('releases a build id after failed staging and rejects traversal outside the configured root', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    const validIngress = fixtureIngress(fixture.root); let attempt = 0
    const service = testSupervisor({ artifactRoot: fixture.root, artifactIngress: { ...validIngress, claim: async (...args) => { if (attempt++ === 0) throw new BuilderSupervisorError('ARTIFACT_HASH_MISMATCH'); return validIngress.claim(...args) } }, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await expect(service.prepare({ request_id: req('1'), build_id: 'retry', upload_ref: uploadRef }, signal)).rejects.toThrow('ARTIFACT_HASH_MISMATCH')
    await expect(service.prepare({ request_id: req('2'), build_id: 'retry', upload_ref: uploadRef }, signal)).resolves.toMatchObject({ state: 'PREPARED' })
    const outside = `${fixture.root}-outside`; roots.push(outside); await mkdir(outside); await writeFile(join(outside, 'a'), 'a')
    await expect(createVerifiedBuildArchive(fixture.root, `../${basename(outside)}`, await hashTree(outside))).rejects.toThrow('ARTIFACT_OUTSIDE_ROOT')
  })

  it.each([
    [new ArtifactIngressError('INVALID_CONFIGURATION'), 'RECOVERY_FAILED'],
    [new ArtifactIngressError('ARTIFACT_NOT_READY'), 'ARTIFACT_NOT_READY'],
    [{ private: 'opaque' }, 'RECOVERY_FAILED'],
  ] as const)('maps an ingress claim failure to its bounded public error', async (failure, expected) => {
    const fixture = await artifactFixture(); const ingress = fixtureIngress(fixture.root)
    const service = testSupervisor({ artifactRoot: fixture.root, adapter: fakeAdapter(), artifactIngress: { ...ingress, claim: async () => { throw failure } }, createReference: () => ref })
    await expect(service.prepare({ request_id: req('1'), build_id: 'claim-failure', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow(expected)
  })

  it('fails closed when the supervisor was composed without artifact ingress', async () => {
    const service = new BuilderSupervisor({ adapter: fakeAdapter(), buildClaims: memoryJournal(), createReference: () => ref })
    await expect(service.prepare({ request_id: req('1'), build_id: 'missing-ingress', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('RECOVERY_FAILED')
  })

  it.each([false, true])('settles an upload after build-id claim failure (settlement fails: %s)', async settlementFails => {
    const fixture = await artifactFixture(); const baseIngress = fixtureIngress(fixture.root); const fail = vi.fn(async () => undefined)
    const ingress: ArtifactIngressPort = { ...baseIngress, claim: async (...args) => {
      const claimed = await baseIngress.claim(...args)
      return { ...claimed, fail: async () => { await claimed.fail(); await fail(); if (settlementFails) throw new Error('private settlement failure') } }
    } }
    const service = testSupervisor({ artifactRoot: fixture.root, adapter: fakeAdapter(), artifactIngress: ingress, createReference: () => ref, buildClaims: { claim: async () => { throw new Error('claim failed') } } })
    await expect(service.prepare({ request_id: req('1'), build_id: 'claim-rollback', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow(settlementFails ? 'CLEANUP_INCOMPLETE' : 'claim failed')
    expect(fail).toHaveBeenCalledOnce()
  })

  it('releases a durable build-id claim only after a clean prepare rollback', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const claimed = new Set<string>()
    const claims = { claim: vi.fn(async (id: string) => { if (claimed.has(id)) throw new Error('duplicate'); claimed.add(id) }), release: vi.fn(async (id: string) => { claimed.delete(id) }) }
    vi.mocked(adapter.prepare).mockRejectedValueOnce(new Error('stage failed')).mockImplementationOnce(async buildRef => { /* fake Engine accepted it */ })
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref, buildClaims: claims }); const signal = new AbortController().signal
    const body = { build_id: 'durable-retry', upload_ref: uploadRef }
    await expect(service.prepare({ ...body, request_id: req('1') }, signal)).rejects.toThrow('stage failed')
    expect(claims.release).toHaveBeenCalledWith('durable-retry')
    await expect(service.prepare({ ...body, request_id: req('2') }, signal)).resolves.toMatchObject({ state: 'PREPARED' })
  })

  it('reports incomplete cleanup when a rejected prepare cannot settle its claimed upload', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const baseIngress = fixtureIngress(fixture.root); const fail = vi.fn(async () => { throw new Error('private settlement failure') })
    const ingress: ArtifactIngressPort = {
      ...baseIngress,
      claim: async (...args) => ({ ...(await baseIngress.claim(...args)), fail }),
    }
    vi.mocked(adapter.prepare).mockRejectedValueOnce(new Error('stage failed'))
    const release = vi.fn(async () => undefined)
    const service = testSupervisor({ artifactRoot: fixture.root, artifactIngress: ingress, adapter, createReference: () => ref, buildClaims: { release } })
    await expect(service.prepare({ request_id: req('1'), build_id: 'settlement-rollback', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    expect(release).toHaveBeenCalledWith('settlement-rollback'); expect(fail).toHaveBeenCalledOnce()
  })

  it.each([
    ['release', new Error('stage failed')],
    ['update', new BuilderSupervisorError('CLEANUP_INCOMPLETE')],
  ] as const)('settles the claimed upload when prepare rollback cannot persist through %s', async (failurePoint, prepareError) => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const baseIngress = fixtureIngress(fixture.root); const fail = vi.fn(async () => undefined)
    const ingress: ArtifactIngressPort = {
      ...baseIngress,
      claim: async (...args) => {
        const claimed = await baseIngress.claim(...args)
        return { ...claimed, fail: async () => { await fail(); await claimed.fail() } }
      },
    }
    vi.mocked(adapter.prepare).mockRejectedValueOnce(prepareError)
    const claims = failurePoint === 'release'
      ? { release: vi.fn(async () => { throw new Error('journal unavailable') }) }
      : { update: vi.fn(async () => { throw new Error('journal unavailable') }) }
    const service = testSupervisor({ artifactRoot: fixture.root, artifactIngress: ingress, adapter, createReference: () => ref, buildClaims: claims })
    await expect(service.prepare({ request_id: req('1'), build_id: `rollback-${failurePoint}`, upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    expect(fail).toHaveBeenCalledOnce()
  })

  it('rolls back Docker and settles the upload when the prepared journal update fails', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const baseIngress = fixtureIngress(fixture.root); const fail = vi.fn(async () => undefined); let updates = 0
    const ingress: ArtifactIngressPort = {
      ...baseIngress,
      claim: async (...args) => {
        const claimed = await baseIngress.claim(...args)
        return { ...claimed, fail: async () => { await fail(); await claimed.fail() } }
      },
    }
    const service = testSupervisor({ artifactRoot: fixture.root, artifactIngress: ingress, adapter, createReference: () => ref, buildClaims: {
      update: vi.fn(async () => { if (updates++ === 0) throw new Error('journal unavailable') }),
    } })
    await expect(service.prepare({ request_id: req('1'), build_id: 'prepared-journal-failure', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('journal unavailable')
    expect(adapter.cleanup).toHaveBeenCalledWith(ref, expect.any(AbortSignal)); expect(fail).toHaveBeenCalledOnce()
  })

  it('reports incomplete cleanup when journal publication and Docker rollback both fail', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    vi.mocked(adapter.cleanup).mockRejectedValueOnce(new Error('private cleanup failure'))
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref, buildClaims: { update: async () => { throw new Error('journal unavailable') } } })
    await expect(service.prepare({ request_id: req('1'), build_id: 'double-rollback-failure', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('reports incomplete cleanup when unpublished rollback cannot settle its claimed upload', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const baseIngress = fixtureIngress(fixture.root); const fail = vi.fn(async () => { throw new Error('private settlement failure') })
    const ingress: ArtifactIngressPort = {
      ...baseIngress,
      claim: async (...args) => ({ ...(await baseIngress.claim(...args)), fail }),
    }
    const service = testSupervisor({ artifactRoot: fixture.root, artifactIngress: ingress, adapter, createReference: () => ref, buildClaims: { update: async () => { throw new Error('journal unavailable') } } })
    await expect(service.prepare({ request_id: req('1'), build_id: 'unpublished-settlement-failure', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    expect(adapter.cleanup).toHaveBeenCalledWith(ref, expect.any(AbortSignal)); expect(fail).toHaveBeenCalledOnce()
  })

  it('rolls back a prepared build when artifact completion is not durably confirmed', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const baseIngress = fixtureIngress(fixture.root); const complete = vi.fn(async () => { throw new Error('private settlement failure') }); const fail = vi.fn(async () => undefined)
    const ingress: ArtifactIngressPort = {
      ...baseIngress,
      claim: async (...args) => ({ ...(await baseIngress.claim(...args)), complete, fail }),
    }
    const service = testSupervisor({ artifactRoot: fixture.root, artifactIngress: ingress, adapter, createReference: () => ref })
    await expect(service.prepare({ request_id: req('1'), build_id: 'completion-failure', upload_ref: uploadRef }, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    expect(complete).toHaveBeenCalledOnce(); expect(fail).not.toHaveBeenCalled(); expect(adapter.cleanup).toHaveBeenCalledWith(ref, expect.any(AbortSignal))
  })

  it('keeps a failed prepare claim discoverable until incomplete cleanup is retried', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const claims = { claim: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    vi.mocked(adapter.prepare).mockRejectedValueOnce(new BuilderSupervisorError('CLEANUP_INCOMPLETE'))
    vi.mocked(adapter.listManaged).mockResolvedValueOnce([]).mockResolvedValueOnce([ref])
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref, buildClaims: claims }); const signal = new AbortController().signal
    await expect(service.prepare({ request_id: req('1'), build_id: 'staging-cleanup', upload_ref: uploadRef }, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    expect(claims.release).not.toHaveBeenCalled()
    await expect(service.listManaged({ request_id: req('2'), build_id: 'staging-cleanup' }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'staging-cleanup', state: 'CANCELLED', exported: false, cleanup_pending: true }] })
    await expect(service.finish({ request_id: req('3'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'CANCELLED', cleaned: true })
  })

  it('marks unexpected adapter execution failures as FAILED', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter()
    vi.mocked(adapter.execute).mockRejectedValueOnce(new Error('engine down'))
    const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'run-error', upload_ref: uploadRef }, signal)
    await expect(service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)).rejects.toThrow('engine down')
    await expect(service.listManaged({ request_id: req('3') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'run-error', state: 'FAILED', exported: false, cleanup_pending: false }] })
  })

  it('rejects a malformed or already-managed server-generated reference', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const signal = new AbortController().signal
    const malformed = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => 'bad' })
    await expect(malformed.prepare({ request_id: req('1'), build_id: 'bad-ref', upload_ref: uploadRef }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    vi.mocked(adapter.listManaged).mockResolvedValueOnce([ref])
    const occupied = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
    await expect(occupied.prepare({ request_id: req('2'), build_id: 'occupied', upload_ref: uploadRef }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
  })

  it('creates a cryptographically random reference when no test factory is supplied', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const signal = new AbortController().signal
    const service = testSupervisor({ artifactRoot: fixture.root, adapter })
    await expect(service.prepare({ request_id: req('1'), build_id: 'random-ref', upload_ref: uploadRef }, signal)).resolves.toMatchObject({ build_ref: expect.stringMatching(/^build_[a-f0-9]{32}$/u) })
  })

  it('reconciles before serving and permanently reserves recovered build ids and refs', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const recoveredRef = `build_${'d'.repeat(32)}`
    const journal = memoryJournal(); await journal.claim('recovered-run', recoveredRef)
    vi.mocked(adapter.reconcile).mockResolvedValueOnce([{ build_ref: recoveredRef, build_id: 'recovered-run' }])
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, createReference: () => recoveredRef, buildClaims: journal }); const signal = new AbortController().signal
    await expect(service.preflight({ request_id: req('1') }, signal)).resolves.toMatchObject({ state: 'OK', protocol_version: 1 })
    expect(adapter.reconcile).toHaveBeenCalledTimes(1)
    await expect(service.listManaged({ request_id: req('4'), build_id: 'recovered-run' }, signal)).resolves.toEqual({ builds: [] })
    await expect(service.finish({ request_id: req('5'), build_ref: recoveredRef }, signal)).resolves.toEqual({ build_ref: recoveredRef, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true })
    await expect(service.prepare({ request_id: req('2'), build_id: 'recovered-run', upload_ref: uploadRef }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    await expect(service.prepare({ request_id: req('3'), build_id: 'new-run', upload_ref: uploadRef }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
  })

  it('keeps exported tracking while cleanup is pending and retries cleanup without re-exporting', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'retry-cleanup', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.cleanup).mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(undefined)
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    await expect(service.listManaged({ request_id: req('7') }, signal)).resolves.toEqual({ builds: [{ build_ref: ref, build_id: 'retry-cleanup', state: 'E2E_OK', exported: true, cleanup_pending: true }] })
    await expect(service.finish({ request_id: req('8'), build_ref: ref }, signal)).resolves.toMatchObject({ exported: { relative_path: `exports/${ref}` }, cleanup_pending: false, cleaned: true })
    expect(adapter.exportArtifact).toHaveBeenCalledTimes(1); expect(adapter.cleanup).toHaveBeenCalledTimes(2)
  })

  it('linearizes concurrent finish calls through export, cleanup and durable completion', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'finish-race', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve })
    vi.mocked(adapter.cleanup).mockImplementationOnce(async buildRef => { await blocked; vi.mocked(adapter.listManaged).mockResolvedValue([]); void buildRef })
    const first = service.finish({ request_id: req('6'), build_ref: ref }, signal); await vi.waitFor(() => expect(adapter.cleanup).toHaveBeenCalledTimes(1))
    const second = service.finish({ request_id: req('7'), build_ref: ref }, signal); release()
    const [left, right] = await Promise.all([first, second]); expect(left).toEqual(right)
    expect(adapter.exportArtifact).toHaveBeenCalledTimes(1); expect(adapter.cleanup).toHaveBeenCalledTimes(1)
  })

  it('keeps a published artifact retryable until retention commits after journal-safe pinning', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'retention-gap', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.commitArtifact).mockRejectedValueOnce(new BuilderSupervisorError('CAPACITY_EXCEEDED')).mockResolvedValueOnce(undefined)
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).rejects.toThrow('CAPACITY_EXCEEDED')
    await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'E2E_OK', cleaned: true })
    expect(adapter.exportArtifact).toHaveBeenCalledTimes(1); expect(adapter.cleanup).toHaveBeenCalledTimes(2); expect(adapter.commitArtifact).toHaveBeenCalledTimes(2)
  })
  it('pins another active publication while concurrent finishes cross the journal commit boundary', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const refs = [`build_${'a'.repeat(32)}`, `build_${'b'.repeat(32)}`]; let index = 0; const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => refs[index++]! }); const signal = new AbortController().signal
    for (const [position, buildRef] of refs.entries()) {
      await service.prepare({ request_id: req(position === 0 ? '1' : '7'), build_id: `pin-${position}`, upload_ref: uploadRef }, signal)
      for (const [stepIndex, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req((position === 0 ? stepIndex + 2 : stepIndex + 8).toString(16)), build_ref: buildRef, step }, signal)
    }
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve }); vi.mocked(adapter.commitArtifact).mockImplementationOnce(async () => blocked).mockResolvedValue(undefined)
    const first = service.finish({ request_id: req('6'), build_ref: refs[0]! }, signal); await vi.waitFor(() => expect(adapter.commitArtifact).toHaveBeenCalledTimes(1))
    const second = service.finish({ request_id: req('c'), build_ref: refs[1]! }, signal); await vi.waitFor(() => expect(adapter.commitArtifact).toHaveBeenCalledTimes(2))
    expect(vi.mocked(adapter.commitArtifact).mock.calls[1]![1].has(refs[0]!)).toBe(true); release(); await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('shares one finish failure with concurrent callers and permits one explicit retry', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'finish-error-race', upload_ref: uploadRef }, signal)
    vi.mocked(adapter.execute).mockResolvedValueOnce({ ...ok, exit_code: 1 }); await service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal)
    let release!: () => void; vi.mocked(adapter.cleanup).mockImplementationOnce(async () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error('busy')) })).mockResolvedValueOnce(undefined)
    const first = service.finish({ request_id: req('3'), build_ref: ref }, signal); await vi.waitFor(() => expect(adapter.cleanup).toHaveBeenCalledTimes(1)); const second = service.finish({ request_id: req('4'), build_ref: ref }, signal); release()
    const failures = await Promise.allSettled([first, second]); expect(failures.every(item => item.status === 'rejected' && item.reason instanceof BuilderSupervisorError && item.reason.code === 'CLEANUP_INCOMPLETE')).toBe(true); expect(adapter.cleanup).toHaveBeenCalledTimes(1)
    await expect(service.finish({ request_id: req('5'), build_ref: ref }, signal)).resolves.toMatchObject({ cleaned: true }); expect(adapter.cleanup).toHaveBeenCalledTimes(2)
  })

  it('serializes cancel behind an in-flight finish without mutating its terminal result', async () => {
    const signal = new AbortController().signal
    for (const [suffix, cancelBeforeFinish, cancelSucceeds] of [['cancelled', true, true], ['e2e', false, false]] as const) {
      const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref })
      await service.prepare({ request_id: req('1'), build_id: `finish-cancel-${suffix}`, upload_ref: uploadRef }, signal)
      if (cancelBeforeFinish) await service.cancel({ request_id: req('3'), build_ref: ref }, signal)
      else for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
      let release!: () => void; vi.mocked(adapter.cleanup).mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
      const finishing = service.finish({ request_id: req('6'), build_ref: ref }, signal); await vi.waitFor(() => expect(adapter.cleanup).toHaveBeenCalledTimes(1))
      const cancelling = service.cancel({ request_id: req('7'), build_ref: ref }, signal); release()
      await expect(finishing).resolves.toMatchObject({ final_state: cancelSucceeds ? 'CANCELLED' : 'E2E_OK', cleaned: true })
      if (cancelSucceeds) await expect(cancelling).resolves.toEqual({ build_ref: ref, state: 'CANCELLED' })
      else await expect(cancelling).rejects.toThrow('INVALID_STEP_ORDER')
    }
  })

  it('reconciles a durable active claim without Docker resources as cancelled and never reuses its build id', async () => {
    const fixture = await artifactFixture(); const journalRoot = join(fixture.root, 'journal'); const journal = new FileBuildIdGuard(journalRoot); const signal = new AbortController().signal
    await journal.claim('crashed-before-docker', ref)
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter: fakeAdapter(), buildClaims: new FileBuildIdGuard(journalRoot), createReference: () => ref })
    await service.initialize(signal)
    await expect(service.finish({ request_id: req('1'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'CANCELLED', cleaned: true })
    await expect(service.prepare({ request_id: req('2'), build_id: 'crashed-before-docker', upload_ref: uploadRef }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    await expect(new FileBuildIdGuard(journalRoot).list()).resolves.toEqual([expect.objectContaining({ build_id: 'crashed-before-docker', build_ref: ref, build_state: 'CANCELLED', finish_result: expect.objectContaining({ cleaned: true }) })])
  })

  it('recovers an exported terminal journal entry after crash and preserves its exact result', async () => {
    const fixture = await artifactFixture(); const journalRoot = join(fixture.root, 'terminal-journal'); const journal = new FileBuildIdGuard(journalRoot); const signal = new AbortController().signal; const exported = { relative_path: `exports/${ref}`, sha256: '9'.repeat(64), files: 2, bytes: 7 }
    await journal.claim('crashed-after-export', ref); await journal.update({ build_id: 'crashed-after-export', build_ref: ref, build_state: 'E2E_OK', exported, cleanup_pending: true, finish_result: null, finish_error: null })
    const adapter = fakeAdapter(); vi.mocked(adapter.exportArtifact).mockResolvedValueOnce(exported)
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: new FileBuildIdGuard(journalRoot) }); await service.initialize(signal)
    await expect(service.finish({ request_id: req('1'), build_ref: ref }, signal)).resolves.toEqual({ build_ref: ref, final_state: 'E2E_OK', exported, cleanup_pending: false, cleaned: true })
  })

  it('recovers publication committed immediately before the journal export update', async () => {
    const fixture = await artifactFixture(); const journalRoot = join(fixture.root, 'publication-gap-journal'); const journal = new FileBuildIdGuard(journalRoot); const signal = new AbortController().signal; const exported = { relative_path: `exports/${ref}`, sha256: '8'.repeat(64), files: 3, bytes: 11 }
    await journal.claim('crashed-in-publication-gap', ref); await journal.update({ build_id: 'crashed-in-publication-gap', build_ref: ref, build_state: 'E2E_OK', exported: null, cleanup_pending: false, finish_result: null, finish_error: null })
    const adapter = fakeAdapter(); vi.mocked(adapter.exportArtifact).mockResolvedValueOnce(exported)
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: new FileBuildIdGuard(journalRoot) }); await service.initialize(signal)
    await expect(service.finish({ request_id: req('1'), build_ref: ref }, signal)).resolves.toEqual({ build_ref: ref, final_state: 'E2E_OK', exported, cleanup_pending: false, cleaned: true })
  })

  it('exports a recovered E2E build before removing its Docker resources', async () => {
    const fixture = await artifactFixture(); const journal = memoryJournal(); const signal = new AbortController().signal
    await journal.claim('crashed-before-export', ref)
    await journal.update({ build_id: 'crashed-before-export', build_ref: ref, build_state: 'E2E_OK', exported: null, cleanup_pending: false, finish_result: null, finish_error: null })
    const calls: string[] = []; const adapter = fakeAdapter()
    vi.mocked(adapter.reconcile).mockResolvedValueOnce([{ build_ref: ref, build_id: 'crashed-before-export' }])
    vi.mocked(adapter.exportArtifact).mockImplementationOnce(async () => { calls.push('export'); return { relative_path: `exports/${ref}`, sha256: '8'.repeat(64), files: 3, bytes: 11 } })
    vi.mocked(adapter.cleanup).mockImplementationOnce(async () => { calls.push('cleanup') })
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: journal })
    await service.initialize(signal)
    expect(calls).toEqual(['export', 'cleanup'])
    await expect(service.finish({ request_id: req('1'), build_ref: ref }, signal)).resolves.toMatchObject({ final_state: 'E2E_OK', cleaned: true })
  })

  it('fails closed when recovered active resources cannot be cleaned', async () => {
    const fixture = await artifactFixture(); const journal = memoryJournal(); const signal = new AbortController().signal
    await journal.claim('active-cleanup-failure', ref)
    await journal.update({ build_id: 'active-cleanup-failure', build_ref: ref, build_state: 'CANCELLED', exported: null, cleanup_pending: false, finish_result: null, finish_error: null })
    const adapter = fakeAdapter(); vi.mocked(adapter.reconcile).mockResolvedValueOnce([{ build_ref: ref, build_id: 'active-cleanup-failure' }]); vi.mocked(adapter.cleanup).mockRejectedValueOnce(new Error('docker unavailable'))
    await expect(new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: journal }).initialize(signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    await expect(journal.list()).resolves.toEqual([expect.objectContaining({ build_id: 'active-cleanup-failure', cleanup_pending: true, finish_result: null })])
  })

  it('fails closed when residual resources of a completed build cannot be cleaned', async () => {
    const fixture = await artifactFixture(); const journal = memoryJournal(); const signal = new AbortController().signal
    const result = { build_ref: ref, final_state: 'CANCELLED' as const, exported: null, cleanup_pending: false, cleaned: true }
    await journal.claim('complete-cleanup-failure', ref)
    await journal.complete({ build_id: 'complete-cleanup-failure', build_ref: ref, build_state: 'CANCELLED', exported: null, cleanup_pending: false, finish_result: result, finish_error: null })
    const adapter = fakeAdapter(); vi.mocked(adapter.reconcile).mockResolvedValueOnce([{ build_ref: ref, build_id: 'complete-cleanup-failure' }]); vi.mocked(adapter.cleanup).mockRejectedValueOnce(new Error('docker unavailable'))
    await expect(new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: journal }).initialize(signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('pins every other active journal publication during crash recovery', async () => {
    const fixture = await artifactFixture(); const journal = memoryJournal(); const signal = new AbortController().signal; const refs = [`build_${'1'.repeat(32)}`, `build_${'2'.repeat(32)}`]
    for (const [index, buildRef] of refs.entries()) { const exported = { relative_path: `exports/${buildRef}`, sha256: `${index + 1}`.repeat(64), files: 1, bytes: 1 }; await journal.claim(`recover-pin-${index}`, buildRef); await journal.update({ build_id: `recover-pin-${index}`, build_ref: buildRef, build_state: 'E2E_OK', exported, cleanup_pending: false, finish_result: null, finish_error: null }) }
    const adapter = fakeAdapter(); vi.mocked(adapter.exportArtifact).mockImplementation(async buildRef => ({ relative_path: `exports/${buildRef}`, sha256: buildRef === refs[0] ? '1'.repeat(64) : '2'.repeat(64), files: 1, bytes: 1 }))
    await new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: journal }).initialize(signal)
    expect(vi.mocked(adapter.commitArtifact).mock.calls[0]![1].has(refs[1]!)).toBe(true)
  })

  it('persists EXPORT_INVALID when an E2E journal has neither Docker resources nor a publication', async () => {
    const fixture = await artifactFixture(); const journalRoot = join(fixture.root, 'missing-publication-journal'); const journal = new FileBuildIdGuard(journalRoot); const signal = new AbortController().signal
    await journal.claim('crashed-without-publication', ref); await journal.update({ build_id: 'crashed-without-publication', build_ref: ref, build_state: 'E2E_OK', exported: null, cleanup_pending: true, finish_result: null, finish_error: null })
    const adapter = fakeAdapter(); vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(new BuilderSupervisorError('BUILD_NOT_FOUND'))
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: new FileBuildIdGuard(journalRoot) }); await service.initialize(signal)
    await expect(service.finish({ request_id: req('1'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID')
    const restarted = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter: fakeAdapter(), buildClaims: new FileBuildIdGuard(journalRoot) }); await restarted.initialize(signal)
    await expect(restarted.finish({ request_id: req('2'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID')
  })

  it('fails closed without completing the journal when recovered publication evidence is transient or inconsistent', async () => {
    const fixture = await artifactFixture(); const signal = new AbortController().signal
    for (const [suffix, exported, failure] of [
      ['transport', null, new Error('read failed')],
      ['mismatch', { relative_path: `exports/${ref}`, sha256: '7'.repeat(64), files: 1, bytes: 1 }, { relative_path: `exports/${ref}`, sha256: '6'.repeat(64), files: 1, bytes: 1 }],
    ] as const) {
      const journalRoot = join(fixture.root, `bad-publication-${suffix}`); const journal = new FileBuildIdGuard(journalRoot)
      await journal.claim(`crashed-${suffix}`, ref); await journal.update({ build_id: `crashed-${suffix}`, build_ref: ref, build_state: 'E2E_OK', exported, cleanup_pending: true, finish_result: null, finish_error: null })
      const adapter = fakeAdapter(); if (failure instanceof Error) vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(failure); else vi.mocked(adapter.exportArtifact).mockResolvedValueOnce(failure)
      const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: new FileBuildIdGuard(journalRoot) })
      await expect(service.initialize(signal)).rejects.toThrow(suffix === 'transport' ? 'read failed' : 'RECOVERY_FAILED')
      await expect(new FileBuildIdGuard(journalRoot).list()).resolves.toEqual([expect.objectContaining({ finish_result: null, finish_error: null })])
    }
  })

  it('cleans resources after a transient export failure without poisoning an explicit retry', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'bad-export', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(new Error('engine failed'))
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).rejects.toThrow('engine failed')
    expect(adapter.cleanup).toHaveBeenCalledTimes(0)
    await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).resolves.toMatchObject({ cleaned: true, exported: { relative_path: `exports/${ref}` } })
    expect(adapter.exportArtifact).toHaveBeenCalledTimes(2); expect(adapter.cleanup).toHaveBeenCalledTimes(1)
  })

  it('recovers a published artifact after archive cleanup failed and reports no false cleaned result', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'archive-cleanup-retry', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(new BuilderSupervisorError('CLEANUP_INCOMPLETE'))
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).resolves.toMatchObject({ cleaned: true, exported: { relative_path: `exports/${ref}` } })
    expect(adapter.cleanup).toHaveBeenCalledTimes(1); expect(adapter.exportArtifact).toHaveBeenCalledTimes(2)
  })

  it('keeps a post-cleanup export recovery transport failure retryable', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'archive-transport-retry', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(new BuilderSupervisorError('CLEANUP_INCOMPLETE')).mockRejectedValueOnce(new Error('read failed'))
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).rejects.toThrow('read failed')
    await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).resolves.toMatchObject({ cleaned: true }); expect(adapter.exportArtifact).toHaveBeenCalledTimes(3)
  })

  it('records an invalid export when cleanup completed before any publication existed', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'archive-never-published', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(new BuilderSupervisorError('CLEANUP_INCOMPLETE')).mockRejectedValueOnce(new BuilderSupervisorError('BUILD_NOT_FOUND'))
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID'); await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID'); expect(adapter.exportArtifact).toHaveBeenCalledTimes(2)
  })

  it('persists a terminal export error only after cleanup and replays it without another export', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'invalid-export', upload_ref: uploadRef }, signal)
    for (const [index, step] of (['install', 'build', 'test', 'e2e'] as const).entries()) await service.execute({ request_id: req(String(index + 2)), build_ref: ref, step }, signal)
    vi.mocked(adapter.exportArtifact).mockRejectedValueOnce(new BuilderSupervisorError('EXPORT_INVALID'))
    await expect(service.finish({ request_id: req('6'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID')
    await expect(service.finish({ request_id: req('7'), build_ref: ref }, signal)).rejects.toThrow('EXPORT_INVALID')
    expect(adapter.exportArtifact).toHaveBeenCalledTimes(1); expect(adapter.cleanup).toHaveBeenCalledTimes(1)
  })

  it('fails closed at the configured global managed-build limit', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref, maxBuilds: 1 }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'first', upload_ref: uploadRef }, signal)
    await expect(service.prepare({ request_id: req('2'), build_id: 'second', upload_ref: uploadRef }, signal)).rejects.toThrow('CAPACITY_EXCEEDED')
  })

  it('evicts completed in-memory builds only after the durable journal retention expires', async () => {
    const fixture = await artifactFixture(); let now = 0; const journal = new FileBuildIdGuard(join(fixture.root, 'retained-journal'), 8, 10, () => now); const adapter = fakeAdapter(); vi.mocked(adapter.execute).mockResolvedValue({ ...ok, exit_code: 1 }); const signal = new AbortController().signal
    const service = new BuilderSupervisor({ artifactIngress: fixtureIngress(fixture.root), adapter, buildClaims: journal, createReference: () => ref })
    const request = { build_id: 'reusable-after-retention', upload_ref: uploadRef }
    await service.prepare({ ...request, request_id: req('1') }, signal); await service.execute({ request_id: req('2'), build_ref: ref, step: 'install' }, signal); await service.finish({ request_id: req('3'), build_ref: ref }, signal)
    await expect(service.prepare({ ...request, request_id: req('4') }, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    now = 10; await expect(service.prepare({ ...request, request_id: req('5') }, signal)).resolves.toEqual({ build_ref: ref, state: 'PREPARED' })
  })

  it('fails closed when the Engine inventory and in-memory ledger diverge', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    await service.prepare({ request_id: req('1'), build_id: 'ledger-run', upload_ref: uploadRef }, signal)
    vi.mocked(adapter.listManaged).mockResolvedValueOnce([])
    await expect(service.listManaged({ request_id: req('2') }, signal)).rejects.toThrow('RECOVERY_FAILED')
    vi.mocked(adapter.listManaged).mockResolvedValueOnce([ref, `build_${'e'.repeat(32)}`])
    await expect(service.listManaged({ request_id: req('3') }, signal)).rejects.toThrow('RECOVERY_FAILED')
  })

  it('serializes concurrent prepare calls so one build id cannot win twice', async () => {
    const fixture = await artifactFixture(); const adapter = fakeAdapter(); const service = testSupervisor({ artifactRoot: fixture.root, adapter, createReference: () => ref }); const signal = new AbortController().signal
    const body = { build_id: 'racing-id', upload_ref: uploadRef }
    const results = await Promise.allSettled([service.prepare({ ...body, request_id: req('1') }, signal), service.prepare({ ...body, request_id: req('2') }, signal)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1); expect(adapter.prepare).toHaveBeenCalledTimes(1)
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
  const managed = new Set<string>()
  return {
    preflight: vi.fn(async () => ({ state: 'OK' as const, protocol_version: 1 as const, scope_id: `s_${'c'.repeat(48)}` as const, image_id: `sha256:${'a'.repeat(64)}` as const, policy_sha256: 'b'.repeat(64) })),
    reconcile: vi.fn(async () => []),
    prepare: vi.fn(async buildRef => { managed.add(buildRef) }),
    execute: vi.fn(async (_buildRef: string, _step: BuildStep) => ok),
    cancel: vi.fn(async () => undefined),
    exportArtifact: vi.fn(async buildRef => ({ relative_path: `exports/${buildRef}`, sha256: 'e'.repeat(64), files: 1, bytes: 1 })),
    commitArtifact: vi.fn(async () => undefined),
    cleanup: vi.fn(async buildRef => { managed.delete(buildRef) }),
    listManaged: vi.fn(async () => [...managed]),
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
