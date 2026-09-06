import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_UPLOAD_MAX_FILE_BYTES,
  ARTIFACT_UPLOAD_MAX_WIRE_BYTES,
  ArtifactIngressError,
  ArtifactIngressStore,
  type ArtifactIngressStoreOptions,
} from '../src/artifact-ingress.js'

const roots: string[] = []
const scopeId = `s_${'a'.repeat(48)}`
const imageDigest = `sha256:${'b'.repeat(64)}`
const policySha256 = 'c'.repeat(64)
const uploadRef = `upload_${'d'.repeat(32)}`
const signal = new AbortController().signal

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('authenticated canonical artifact ingress core', () => {
  it('reserves, validates, replays and consumes one canonical USTAR artifact without exposing logical identity', async () => {
    const root = await temporary('happy')
    const tar = canonicalTar([{ name: 'app/', type: '5' }, { name: 'app/a.txt', type: '0', body: Buffer.from('alpha') }])
    const store = create(root)
    const begun = await store.begin(beginInput(tar))
    expect(begun).toEqual({ uploadRef, state: 'RECEIVING', idempotent: false })
    await expect(store.begin(beginInput(tar))).resolves.toEqual({ uploadRef, state: 'RECEIVING', idempotent: true })
    await expect(store.upload(uploadRef, chunks(tar, 7), tar.byteLength, signal)).resolves.toEqual({ uploadRef, state: 'READY', idempotent: false })
    await expect(store.upload(uploadRef, chunks(tar, 3), tar.byteLength, signal)).resolves.toEqual({ uploadRef, state: 'READY', idempotent: true })
    const claim = await store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })
    expect(claim.artifact).toMatchObject({ archivePath: expect.stringMatching(/upload_[a-f0-9]{32}\.tar$/u), archiveHandle: expect.anything(), archiveBytes: tar.byteLength, files: 2, bytes: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(await readFile(claim.artifact.archivePath)).toEqual(tar)
    await claim.complete()
    await claim.complete()
    await expect(store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })).rejects.toMatchObject({ code: 'ARTIFACT_NOT_READY' })
    const journalText = (await readFile(join(root, `${uploadRef}.json`), 'utf8'))
    expect(journalText).not.toContain('build-one')
    expect(journalText).not.toContain(scopeId)
    expect(JSON.parse(journalText)).toMatchObject({ state: 'CONSUMED', tar_sha256: sha(tar), entries: 2, logical_bytes: 5 })
    if (process.platform !== 'win32') {
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(root, `${uploadRef}.json`))).mode & 0o777).toBe(0o600)
    }
  })

  it('detects changed replay bytes and binding or attestation drift', async () => {
    const root = await temporary('drift')
    const first = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('one') }])
    const second = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('two') }])
    const store = create(root)
    await store.begin(beginInput(first)); await store.upload(uploadRef, chunks(first), first.byteLength, signal)
    await expect(store.upload(uploadRef, chunks(second), second.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    for (const binding of [
      { buildId: 'another', attestation: attestation() },
      { buildId: 'build-one', attestation: { ...attestation(), scope_id: `s_${'e'.repeat(48)}` as const } },
      { buildId: 'build-one', attestation: { ...attestation(), image_id: `sha256:${'e'.repeat(64)}` as const } },
      { buildId: 'build-one', attestation: { ...attestation(), policy_sha256: 'e'.repeat(64) } },
      { buildId: 'build-one', attestation: { ...attestation(), state: 'BLOCKED_EXTERNAL' as const } },
    ]) await expect(store.claim(uploadRef, binding)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    const claim = await store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })
    await claim.fail(); await claim.fail()
    expect(JSON.parse(await readFile(join(root, `${uploadRef}.json`), 'utf8'))).toMatchObject({ state: 'FAILED' })
  })

  it('makes begin idempotent only for identical metadata and reserves quota before receiving', async () => {
    const root = await temporary('quota')
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const refs = [uploadRef, `upload_${'e'.repeat(32)}`]; let refIndex = 0
    const store = create(root, { maxReservedBytes: tar.byteLength, createReference: () => refs[refIndex++]! })
    await store.begin(beginInput(tar))
    await expect(store.begin({ ...beginInput(tar), wireSha256: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(store.begin({ ...beginInput(tar), buildId: 'second' })).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA_EXCEEDED' })
    await store.abort(uploadRef)
    await store.abort(uploadRef)
    await expect(store.begin({ ...beginInput(tar), buildId: 'second' })).resolves.toMatchObject({ state: 'RECEIVING' })
    const concurrentRoot = await temporary('quota-race'); let index = 0
    const concurrent = create(concurrentRoot, { maxReservedBytes: tar.byteLength, createReference: () => [`upload_${'1'.repeat(32)}`, `upload_${'2'.repeat(32)}`][index++]! })
    const race = await Promise.allSettled([concurrent.begin({ ...beginInput(tar), buildId: 'one' }), concurrent.begin({ ...beginInput(tar), buildId: 'two' })])
    expect(race.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(race.filter(item => item.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'ARTIFACT_QUOTA_EXCEEDED' }) })])
  })

  it('rejects invalid configuration, begin metadata, opaque-reference collision and unknown uploads', async () => {
    expect(() => create('relative')).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    for (const options of [
      { scopeId: 'tenant-visible' }, { imageDigest: 'latest' }, { policySha256: 'A'.repeat(64) },
      { maxReservedBytes: 0 }, { receivingTtlMs: 0 }, { readyTtlMs: 8 * 24 * 60 * 60_000 },
    ]) expect(() => create(join(tmpdir(), 'unused'), options)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    const root = await temporary('invalid')
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const store = create(root)
    for (const input of [
      { ...beginInput(tar), buildId: '../bad' }, { ...beginInput(tar), contentLength: 0 },
      { ...beginInput(tar), contentLength: ARTIFACT_UPLOAD_MAX_WIRE_BYTES + 1 }, { ...beginInput(tar), wireSha256: 'bad' },
    ]) await expect(store.begin(input)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    await writeFile(join(root, `${uploadRef}.json`), '{}', { mode: 0o600 })
    await expect(create(root).begin(beginInput(tar))).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await rm(join(root, `${uploadRef}.json`))
    await expect(store.upload('bad', chunks(tar), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    await expect(store.abort(`upload_${'f'.repeat(32)}`)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
    const defaultRoot = await temporary('default-reference')
    await expect(new ArtifactIngressStore({ spoolRoot: defaultRoot, scopeId, imageDigest, policySha256 }).begin(beginInput(tar))).resolves.toMatchObject({ uploadRef: expect.stringMatching(/^upload_[a-f0-9]{32}$/u) })
  })

  it('rejects every non-canonical tar class before READY', async () => {
    const valid = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const fixtures: Array<[string, Buffer]> = [
      ['absolute', canonicalTar([{ name: '/a', type: '0', body: Buffer.from('x') }])],
      ['traversal', canonicalTar([{ name: '../a', type: '0', body: Buffer.from('x') }])],
      ['backslash', canonicalTar([{ name: 'a\\b', type: '0', body: Buffer.from('x') }])],
      ['symlink', canonicalTar([{ name: 'a', type: '2', body: Buffer.alloc(0) }])],
      ['hardlink', canonicalTar([{ name: 'a', type: '1', body: Buffer.alloc(0) }])],
      ['fifo', canonicalTar([{ name: 'a', type: '6', body: Buffer.alloc(0) }])],
      ['pax', canonicalTar([{ name: 'a', type: 'x', body: Buffer.alloc(0) }])],
      ['case collision', canonicalTar([{ name: 'A', type: '0', body: Buffer.alloc(0) }, { name: 'a', type: '0', body: Buffer.alloc(0) }])],
      ['duplicate', canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }, { name: 'a', type: '0', body: Buffer.alloc(0) }])],
      ['file order', canonicalTar([{ name: 'b', type: '0', body: Buffer.alloc(0) }, { name: 'a', type: '0', body: Buffer.alloc(0) }])],
      ['file ancestor', canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }, { name: 'a/b', type: '0', body: Buffer.alloc(0) }])],
      ['directory after file', canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }, { name: 'z/', type: '5' }])],
      ['oversized file', canonicalTar([{ name: 'a', type: '0', declaredSize: ARTIFACT_UPLOAD_MAX_FILE_BYTES + 1, body: Buffer.alloc(0) }], false)],
      ['oversized logical', canonicalTar([{ name: 'a', type: '0', declaredSize: 256 * 1024 * 1024 + 1, body: Buffer.alloc(0) }], false)],
      ['bad padding', mutate(valid, value => { value[513] = 1 })],
      ['bad checksum', mutate(valid, value => { value[0] = value[0]! ^ 1 })],
      ['bad mode', mutateHeader(valid, value => octal(value, 100, 8, 0o777))],
      ['bad uid', mutateHeader(valid, value => octal(value, 108, 8, 0))],
      ['bad magic', mutateHeader(valid, value => { value[257] = 0 })],
      ['bad reserved', mutateHeader(valid, value => { value[500] = 1 })],
      ['one final block', valid.subarray(0, valid.byteLength - 512)],
      ['trailing data', Buffer.concat([valid, Buffer.alloc(512)])],
      ['header after zero', Buffer.concat([valid.subarray(0, -512), valid.subarray(0, 512), Buffer.alloc(1024)])],
      ['empty', Buffer.alloc(1024)],
    ]
    for (const [name, tar] of fixtures) {
      const root = await temporary(`tar-${name.replaceAll(' ', '-')}`)
      const store = create(root)
      await store.begin(beginInput(tar))
      await expect(store.upload(uploadRef, chunks(tar, 113), tar.byteLength, signal), name).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
      expect(JSON.parse(await readFile(join(root, `${uploadRef}.json`), 'utf8'))).toMatchObject({ state: 'FAILED' })
    }
  })

  it('rejects invalid UTF-8, embedded NUL garbage, non-NFC paths and size/truncation mismatches', async () => {
    const base = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const invalidUtf8 = mutateHeader(base, header => { header[0] = 0xc3; header[1] = 0x28; header[2] = 0 })
    const nulGarbage = mutateHeader(base, header => { header[0] = 0x61; header[1] = 0; header[2] = 0x62 })
    const nonNfc = canonicalTar([{ name: 'e\u0301', type: '0', body: Buffer.from('x') }])
    for (const tar of [invalidUtf8, nulGarbage, nonNfc, base.subarray(0, -1)]) {
      const root = await temporary('encoding')
      const store = create(root); await store.begin(beginInput(tar))
      await expect(store.upload(uploadRef, chunks(tar), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    }
    const root = await temporary('length')
    const store = create(root); await store.begin(beginInput(base))
    await expect(store.upload(uploadRef, chunks(base.subarray(0, -1)), base.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    const overRoot = await temporary('length-over'); const over = create(overRoot); await over.begin(beginInput(base))
    await expect(over.upload(uploadRef, chunks(Buffer.concat([base, Buffer.from('x')])), base.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
  })

  it('aborts on a caller signal and sweeps receiving, ready and consuming TTL independently', async () => {
    let now = 0
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const firstRoot = await temporary('abort')
    const first = create(firstRoot)
    await first.begin(beginInput(tar))
    const controller = new AbortController(); controller.abort(new Error('private'))
    await expect(first.upload(uploadRef, chunks(tar), tar.byteLength, controller.signal)).rejects.toMatchObject({ code: 'ARTIFACT_TIMEOUT' })
    const pendingRoot = await temporary('abort-pending'); const pendingStore = create(pendingRoot); await pendingStore.begin(beginInput(tar)); const pendingController = new AbortController(); let entered = false; let returned = false
    const pending = pendingStore.upload(uploadRef, hangingSource(() => { entered = true }, () => { returned = true }), tar.byteLength, pendingController.signal); await vi.waitFor(() => expect(entered).toBe(true)); pendingController.abort(new Error('private'))
    await expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_TIMEOUT' }); expect(returned).toBe(true)
    const resolveRoot = await temporary('abort-late-resolve'); const resolveStore = create(resolveRoot); await resolveStore.begin(beginInput(tar)); const resolveController = new AbortController(); let resolveNext!: (value: IteratorResult<Uint8Array>) => void
    const lateResolve = resolveStore.upload(uploadRef, pendingSource(resolve => { resolveNext = resolve }), tar.byteLength, resolveController.signal); await vi.waitFor(() => expect(resolveNext).toBeTypeOf('function')); resolveController.abort(); await expect(lateResolve).rejects.toMatchObject({ code: 'ARTIFACT_TIMEOUT' }); resolveNext({ done: true, value: undefined }); await Promise.resolve()
    const rejectRoot = await temporary('abort-late-reject'); const rejectStore = create(rejectRoot); await rejectStore.begin(beginInput(tar)); const rejectController = new AbortController(); let rejectNext!: (reason: Error) => void
    const lateReject = rejectStore.upload(uploadRef, pendingSource((_resolve, reject) => { rejectNext = reject }), tar.byteLength, rejectController.signal); await vi.waitFor(() => expect(rejectNext).toBeTypeOf('function')); rejectController.abort(); await expect(lateReject).rejects.toMatchObject({ code: 'ARTIFACT_TIMEOUT' }); rejectNext(new Error('private late')); await Promise.resolve()
    const root = await temporary('sweep')
    const refs = ['1', '2', '3'].map(value => `upload_${value.repeat(32)}`)
    let index = 0
    const store = create(root, { now: () => now, receivingTtlMs: 10, readyTtlMs: 20, createReference: () => refs[index++]! })
    const a = await store.begin({ ...beginInput(tar), buildId: 'a' })
    const b = await store.begin({ ...beginInput(tar), buildId: 'b' }); await store.upload(b.uploadRef, chunks(tar), tar.byteLength, signal)
    const c = await store.begin({ ...beginInput(tar), buildId: 'c' }); await store.upload(c.uploadRef, chunks(tar), tar.byteLength, signal); await store.claim(c.uploadRef, { buildId: 'c', attestation: attestation() })
    now = 10; expect(await store.sweep()).toBe(1)
    now = 20; expect(await store.sweep()).toBe(2)
    expect(JSON.parse(await readFile(join(root, `${a.uploadRef}.json`), 'utf8'))).toMatchObject({ state: 'FAILED' })
  })

  it('contains absent, rejecting and throwing iterator cleanup during abort', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    for (const mode of ['missing', 'rejecting', 'throwing'] as const) {
      const root = await temporary(`abort-return-${mode}`); const store = create(root); await store.begin(beginInput(tar)); const controller = new AbortController(); let entered = false
      const pending = store.upload(uploadRef, abortReturnSource(mode, () => { entered = true }), tar.byteLength, controller.signal)
      await vi.waitFor(() => expect(entered).toBe(true)); controller.abort(new Error('private'))
      await expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_TIMEOUT' }); await Promise.resolve()
    }
  })

  it('fails closed on unsafe spool and archive filesystem objects', async () => {
    const root = await temporary('unsafe-root')
    await writeFile(join(root, 'alien'), 'x')
    await expect(create(root).begin(beginInput(Buffer.alloc(1024)))).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await rm(join(root, 'alien'))
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const store = create(root); await store.begin(beginInput(tar)); await store.upload(uploadRef, chunks(tar), tar.byteLength, signal)
    const archive = join(root, `${uploadRef}.tar`)
    if (process.platform !== 'win32') {
      await chmod(archive, 0o666)
      await expect(store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
      await chmod(archive, 0o600)
    }
    const alias = join(root, 'alias'); await link(archive, alias)
    await expect(store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    await rm(alias)
    if (process.platform !== 'win32') {
      const outside = join(root, 'outside'); await writeFile(outside, tar); await rm(archive); await symlink(outside, archive)
      await expect(store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    }
  })

  it('fails closed on collisions, invalid generated references, wrong wire claims and upload state misuse', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const badRefRoot = await temporary('bad-ref')
    await expect(create(badRefRoot, { createReference: () => '../bad' }).begin(beginInput(tar))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    const collisionRoot = await temporary('collision')
    const collision = create(collisionRoot); await collision.begin(beginInput(tar)); await collision.abort(uploadRef)
    await expect(collision.begin({ ...beginInput(tar), buildId: 'another' })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    const archiveCollisionRoot = await temporary('archive-collision'); const archiveCollision = create(archiveCollisionRoot); await archiveCollision.sweep(); await writeFile(join(archiveCollisionRoot, `${uploadRef}.tar`), tar)
    await expect(archiveCollision.begin(beginInput(tar))).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    const wrongRoot = await temporary('wrong-hash')
    const wrong = create(wrongRoot); await wrong.begin({ ...beginInput(tar), wireSha256: 'f'.repeat(64) })
    await expect(wrong.upload(uploadRef, chunks(tar), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    await expect(wrong.upload(uploadRef, chunks(tar), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_READY' })
    const lengthRoot = await temporary('length-conflict')
    const length = create(lengthRoot); await length.begin(beginInput(tar))
    await expect(length.upload(uploadRef, chunks(tar), tar.byteLength + 1, signal)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(length.claim(uploadRef, { buildId: '../bad', attestation: attestation() })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
  })

  it('sanitizes unexpected stream and spool open failures and serializes concurrent begin', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const root = await temporary('stream-failure'); const store = create(root); await store.begin(beginInput(tar))
    async function* failing(): AsyncGenerator<Uint8Array> { yield tar.subarray(0, 512); throw new Error('private stream') }
    await expect(store.upload(uploadRef, failing(), tar.byteLength, signal)).rejects.toEqual(expect.objectContaining({ code: 'ARTIFACT_INVALID', message: 'ARTIFACT_INVALID' }))
    const openRoot = await temporary('open-failure'); const blocked = create(openRoot); await blocked.begin(beginInput(tar)); await mkdir(join(openRoot, `.${uploadRef}.part`))
    await expect(blocked.upload(uploadRef, chunks(tar), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    const concurrentRoot = await temporary('concurrent'); const concurrent = create(concurrentRoot)
    const results = await Promise.all([concurrent.begin(beginInput(tar)), concurrent.begin(beginInput(tar))])
    expect(results.map(item => item.idempotent).sort()).toEqual([false, true])
  })

  it('validates long USTAR prefix names, directory order and metadata variants', async () => {
    const long = `${'a'.repeat(90)}/${'b'.repeat(40)}`
    const valid = canonicalTarWithPrefix(long, Buffer.from('ok'))
    const root = await temporary('prefix'); const store = create(root); await store.begin(beginInput(valid))
    await expect(store.upload(uploadRef, uintChunks(valid), valid.byteLength, signal)).resolves.toMatchObject({ state: 'READY' })
    const exactName = canonicalTar([{ name: 'a'.repeat(100), type: '0', body: Buffer.alloc(0) }]); const exactRoot = await temporary('exact-name'); const exact = create(exactRoot); await exact.begin(beginInput(exactName))
    await expect(exact.upload(uploadRef, chunks(exactName), exactName.byteLength, signal)).resolves.toMatchObject({ state: 'READY' })
    for (const tar of [
      canonicalTar([{ name: 'b/', type: '5' }, { name: 'a/', type: '5' }]),
      canonicalTar([{ name: 'a/', type: '5', declaredSize: 1 }], false),
      mutateHeader(canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }]), value => octal(value, 116, 8, 0)),
      mutateHeader(canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }]), value => octal(value, 136, 12, 1)),
      mutateHeader(canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }]), value => { value[263] = 0 }),
      mutateHeader(canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }]), value => { value[107] = 0x20 }),
      mutateHeader(canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }]), value => { value[100] = 0x38 }),
      mutateHeader(canonicalTar([{ name: 'a', type: '0', body: Buffer.alloc(0) }]), value => { value.fill(0x37, 124, 135); value[135] = 0 }),
    ]) {
      const nextRoot = await temporary('metadata'); const next = create(nextRoot); await next.begin(beginInput(tar))
      await expect(next.upload(uploadRef, chunks(tar), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    }
  })

  it('enforces the 20,000-entry ceiling incrementally', async () => {
    const entries = Array.from({ length: 20_001 }, (_, index) => ({ name: `f${String(index).padStart(5, '0')}`, type: '0', body: Buffer.alloc(0) }))
    const tar = canonicalTar(entries)
    const root = await temporary('entry-limit'); const store = create(root); await store.begin(beginInput(tar))
    await expect(store.upload(uploadRef, chunks(tar, 64 * 1024), tar.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
  })

  it('recovers crash leftovers by quarantine and rejects journal/archive divergence', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const root = await temporary('recovery')
    const first = create(root); await first.begin(beginInput(tar)); await writeFile(join(root, `.${uploadRef}.part`), 'partial', { mode: 0o600 })
    const secondRef = `upload_${'e'.repeat(32)}`
    const restarted = create(root, { createReference: () => secondRef })
    await expect(restarted.begin({ ...beginInput(tar), buildId: 'second' })).resolves.toMatchObject({ uploadRef: secondRef })
    expect(JSON.parse(await readFile(join(root, `${uploadRef}.json`), 'utf8'))).toMatchObject({ state: 'FAILED' })
    expect((await readdir(root)).some(name => name.startsWith(`.quarantine-${uploadRef}`))).toBe(true)
    const orphanRoot = await temporary('orphan'); await writeFile(join(orphanRoot, `${uploadRef}.tar`), tar, { mode: 0o600 })
    await create(orphanRoot, { createReference: () => secondRef }).begin({ ...beginInput(tar), buildId: 'second' })
    expect((await readdir(orphanRoot)).some(name => name.startsWith(`.quarantine-${uploadRef}`))).toBe(true)
    const divergenceRoot = await temporary('divergence'); const divergence = create(divergenceRoot); await divergence.begin(beginInput(tar)); await divergence.upload(uploadRef, chunks(tar), tar.byteLength, signal); await rm(join(divergenceRoot, `${uploadRef}.tar`))
    await expect(create(divergenceRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    const volatileRoot = await temporary('volatile-orphan'); await writeFile(join(volatileRoot, `.upload_${'f'.repeat(32)}.replay-${'1'.repeat(16)}`), 'x', { mode: 0o600 })
    await expect(create(volatileRoot).sweep()).resolves.toBe(0)
  })

  it('recovers every durable publication and settlement crash boundary', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const publishRoot = await temporary('recover-publish')
    const publishing = create(publishRoot)
    await publishing.begin(beginInput(tar))
    await writeFile(join(publishRoot, `.${uploadRef}.part`), tar, { mode: 0o600 })
    await link(join(publishRoot, `.${uploadRef}.part`), join(publishRoot, `${uploadRef}.tar`))
    const recovered = create(publishRoot)
    await expect(recovered.begin(beginInput(tar))).resolves.toMatchObject({ state: 'READY', idempotent: true })
    expect(JSON.parse(await readFile(join(publishRoot, `${uploadRef}.json`), 'utf8'))).toMatchObject({ state: 'READY', tar_sha256: sha(tar) })

    const unlinkedRoot = await temporary('recover-publish-after-unlink')
    const unlinked = create(unlinkedRoot); await unlinked.begin(beginInput(tar)); await writeFile(join(unlinkedRoot, `${uploadRef}.tar`), tar, { mode: 0o600 })
    await expect(create(unlinkedRoot).begin(beginInput(tar))).resolves.toMatchObject({ state: 'READY', idempotent: true })

    const splitRoot = await temporary('recover-publish-split-inodes')
    const split = create(splitRoot); await split.begin(beginInput(tar)); await writeFile(join(splitRoot, `.${uploadRef}.part`), tar, { mode: 0o600 }); await writeFile(join(splitRoot, `${uploadRef}.tar`), tar, { mode: 0o600 })
    await expect(create(splitRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    const linkedOutsideRoot = await temporary('recover-publish-external-link')
    const linkedOutside = create(linkedOutsideRoot); await linkedOutside.begin(beginInput(tar)); await writeFile(join(linkedOutsideRoot, `${uploadRef}.tar`), tar, { mode: 0o600 })
    const outsideLink = join(tmpdir(), `dz23-ingress-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await link(join(linkedOutsideRoot, `${uploadRef}.tar`), outsideLink)
    try { await expect(create(linkedOutsideRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' }) }
    finally { await rm(outsideLink, { force: true }) }

    const mismatchRoot = await temporary('recover-publish-mismatch')
    const mismatch = create(mismatchRoot); await mismatch.begin(beginInput(tar))
    const other = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('y') }])
    await writeFile(join(mismatchRoot, `.${uploadRef}.part`), other, { mode: 0o600 })
    await link(join(mismatchRoot, `.${uploadRef}.part`), join(mismatchRoot, `${uploadRef}.tar`))
    await expect(create(mismatchRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    const unsafeArchiveRoot = await temporary('recover-publish-unsafe-archive')
    const unsafeArchive = create(unsafeArchiveRoot); await unsafeArchive.begin(beginInput(tar)); await mkdir(join(unsafeArchiveRoot, `${uploadRef}.tar`))
    await expect(create(unsafeArchiveRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    const rollbackRoot = await temporary('recover-consuming-ready')
    const rollback = create(rollbackRoot); await rollback.begin(beginInput(tar)); await rollback.upload(uploadRef, chunks(tar), tar.byteLength, signal)
    const rollbackClaim = await rollback.claim(uploadRef, { buildId: 'build-one', attestation: attestation() }); await rollbackClaim.artifact.archiveHandle!.close()
    await expect(create(rollbackRoot).begin(beginInput(tar))).resolves.toMatchObject({ state: 'READY', idempotent: true })

    for (const archivePresent of [true, false]) {
      const root = await temporary(`recover-settle-${archivePresent}`)
      const store = create(root)
      await store.begin(beginInput(tar)); await store.upload(uploadRef, chunks(tar), tar.byteLength, signal)
      const claim = await store.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })
      await claim.artifact.archiveHandle!.close()
      const journalPath = join(root, `${uploadRef}.json`)
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
      await writeFile(journalPath, `${JSON.stringify({ ...journal, settle_state: 'CONSUMED' })}\n`, { mode: 0o600 })
      if (!archivePresent) await rm(join(root, `${uploadRef}.tar`))
      await expect(create(root).sweep()).resolves.toBe(0)
      expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ state: 'CONSUMED', settle_state: null })
    }

    for (const readyState of [false, true]) {
      const root = await temporary(`recover-abort-${readyState}`); const store = create(root); await store.begin(beginInput(tar))
      if (readyState) await store.upload(uploadRef, chunks(tar), tar.byteLength, signal)
      const journalPath = join(root, `${uploadRef}.json`); const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
      await writeFile(journalPath, `${JSON.stringify({ ...journal, settle_state: 'FAILED' })}\n`, { mode: 0o600 })
      await expect(create(root).sweep()).resolves.toBe(0)
      expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ state: 'FAILED', settle_state: null })
      await expect(readFile(join(root, `${uploadRef}.tar`))).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const ambiguousRoot = await temporary('recover-ambiguous-consume')
    const ambiguous = create(ambiguousRoot)
    await ambiguous.begin(beginInput(tar)); await ambiguous.upload(uploadRef, chunks(tar), tar.byteLength, signal)
    const ambiguousClaim = await ambiguous.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })
    await ambiguousClaim.artifact.archiveHandle!.close()
    await rm(join(ambiguousRoot, `${uploadRef}.tar`))
    await expect(create(ambiguousRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    const conflictingRoot = await temporary('recover-conflicting-settlement')
    const conflicting = create(conflictingRoot); await conflicting.begin(beginInput(tar)); await conflicting.upload(uploadRef, chunks(tar), tar.byteLength, signal)
    const conflictingClaim = await conflicting.claim(uploadRef, { buildId: 'build-one', attestation: attestation() })
    const conflictingJournalPath = join(conflictingRoot, `${uploadRef}.json`)
    const conflictingJournal = JSON.parse(await readFile(conflictingJournalPath, 'utf8')) as Record<string, unknown>
    await writeFile(conflictingJournalPath, `${JSON.stringify({ ...conflictingJournal, settle_state: 'FAILED' })}\n`, { mode: 0o600 })
    await expect(conflictingClaim.complete()).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
  })

  it('counts quarantined bytes against quota and collects them after the bounded TTL', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const root = await temporary('quarantine-quota')
    let clock = Date.now()
    const store = create(root, { maxReservedBytes: tar.byteLength, readyTtlMs: 1, now: () => clock })
    await store.begin(beginInput(tar))
    const invalid = Buffer.from(tar); invalid[invalid.byteLength - 1] = 1
    await expect(store.upload(uploadRef, chunks(invalid), invalid.byteLength, signal)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' })
    await expect(store.begin({ buildId: 'second', contentLength: 1024, wireSha256: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA_EXCEEDED' })
    clock += 10_000
    await expect(store.sweep()).resolves.toBeGreaterThan(0)
    const secondRef = `upload_${'e'.repeat(32)}`
    await expect(create(root, { maxReservedBytes: tar.byteLength, createReference: () => secondRef }).begin({ buildId: 'second', contentLength: 1024, wireSha256: 'e'.repeat(64) })).resolves.toMatchObject({ uploadRef: secondRef })
  })

  it('rejects every corrupt durable journal field and filesystem representation', async () => {
    const tar = canonicalTar([{ name: 'a', type: '0', body: Buffer.from('x') }])
    const seedRoot = await temporary('journal-seed'); const seed = create(seedRoot); await seed.begin(beginInput(tar))
    const journal = JSON.parse(await readFile(join(seedRoot, `${uploadRef}.json`), 'utf8')) as Record<string, unknown>
    const corruptions: unknown[] = [
      null, [], 'scalar',
      { ...journal, version: 1 }, { ...journal, settle_state: 'UNKNOWN' }, { ...journal, settle_state: 'CONSUMED' }, { ...journal, tar_sha256: 'a'.repeat(64) }, { ...journal, upload_ref: 'bad' }, { ...journal, identity_sha256: 'bad' }, { ...journal, binding_sha256: 'bad' },
      { ...journal, claimed_wire_sha256: 'bad' }, { ...journal, wire_bytes: 0 }, { ...journal, wire_bytes: ARTIFACT_UPLOAD_MAX_WIRE_BYTES + 1 },
      { ...journal, created_at: 1.5 }, { ...journal, updated_at: 'now' }, { ...journal, state: 'UNKNOWN' },
      { ...journal, tar_sha256: 'bad' }, { ...journal, manifest_sha256: 1 }, { ...journal, entries: -1 }, { ...journal, logical_bytes: 1.5 },
      { ...journal, extra: true }, { ...journal, upload_ref: `upload_${'e'.repeat(32)}` },
    ]
    for (const [index, value] of corruptions.entries()) {
      const root = await temporary(`journal-${index}`)
      await writeFile(join(root, `${uploadRef}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 })
      await expect(create(root).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    }
    const hugeRoot = await temporary('journal-huge'); await writeFile(join(hugeRoot, `${uploadRef}.json`), 'x'.repeat(4_097), { mode: 0o600 })
    await expect(create(hugeRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    const linkRoot = await temporary('journal-link'); await writeFile(join(linkRoot, `${uploadRef}.json`), `${JSON.stringify(journal)}\n`, { mode: 0o600 }); await link(join(linkRoot, `${uploadRef}.json`), join(linkRoot, `upload_${'e'.repeat(32)}.json`))
    await expect(create(linkRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    const malformedRoot = await temporary('journal-malformed'); await writeFile(join(malformedRoot, `${uploadRef}.json`), '{', { mode: 0o600 })
    await expect(create(malformedRoot).sweep()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    const directoryRoot = await temporary('journal-directory'); const initialized = create(directoryRoot); await initialized.begin(beginInput(tar)); await rm(join(directoryRoot, `${uploadRef}.json`)); await mkdir(join(directoryRoot, `${uploadRef}.json`))
    await expect(initialized.abort(uploadRef)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })
})

function create(root: string, overrides: Partial<ArtifactIngressStoreOptions> = {}): ArtifactIngressStore {
  return new ArtifactIngressStore({ spoolRoot: root, scopeId, imageDigest, policySha256, createReference: () => uploadRef, ...overrides })
}
function beginInput(tar: Uint8Array) { return { buildId: 'build-one', contentLength: tar.byteLength, wireSha256: sha(tar) } }
function attestation() { return { state: 'OK' as const, protocol_version: 1 as const, scope_id: scopeId as `s_${string}`, image_id: imageDigest as `sha256:${string}`, policy_sha256: policySha256 } }
async function temporary(name: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), `dz23-ingress-${name}-`)); roots.push(root); return root }
async function* chunks(value: Uint8Array, size = 512): AsyncGenerator<Uint8Array> { for (let offset = 0; offset < value.byteLength; offset += size) yield value.subarray(offset, offset + size) }
async function* uintChunks(value: Uint8Array): AsyncGenerator<Uint8Array> { for (let offset = 0; offset < value.byteLength; offset += 17) { const source = new Uint8Array(value.subarray(offset, offset + 17)); yield source } }
function hangingSource(onNext: () => void, onReturn: () => void): AsyncIterable<Uint8Array> { return { [Symbol.asyncIterator]: () => ({ next: async () => { onNext(); return new Promise<IteratorResult<Uint8Array>>(() => undefined) }, return: async () => { onReturn(); return { done: true, value: undefined } } }) } }
function pendingSource(register: (resolve: (value: IteratorResult<Uint8Array>) => void, reject: (reason: Error) => void) => void): AsyncIterable<Uint8Array> { return { [Symbol.asyncIterator]: () => ({ next: async () => new Promise<IteratorResult<Uint8Array>>(register), return: async () => ({ done: true, value: undefined }) }) } }
function abortReturnSource(mode: 'missing' | 'rejecting' | 'throwing', entered: () => void): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => {
    const iterator: AsyncIterator<Uint8Array> = { next: async () => { entered(); return new Promise<IteratorResult<Uint8Array>>(() => undefined) } }
    if (mode === 'rejecting') iterator.return = async () => { throw new Error('private return rejection') }
    if (mode === 'throwing') Object.defineProperty(iterator, 'return', { get: () => { throw new Error('private return getter') } })
    return iterator
  } }
}
function sha(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

interface TarEntry { readonly name: string; readonly type: string; readonly body?: Buffer; readonly declaredSize?: number }
function canonicalTar(entries: readonly TarEntry[], final = true): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0); const size = entry.declaredSize ?? body.byteLength
    const header = Buffer.alloc(512); text(header, 0, 100, entry.name); octal(header, 100, 8, entry.type === '5' ? 0o755 : 0o644); octal(header, 108, 8, 10_001); octal(header, 116, 8, 10_001); octal(header, 124, 12, size); octal(header, 136, 12, 0); header.fill(0x20, 148, 156); header[156] = entry.type.charCodeAt(0); text(header, 257, 6, 'ustar'); text(header, 263, 2, '00'); checksum(header)
    parts.push(header, body)
    const padding = (512 - body.byteLength % 512) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  if (final) parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
function canonicalTarWithPrefix(path: string, body: Buffer): Buffer {
  const at = path.lastIndexOf('/'); const prefix = path.slice(0, at); const name = path.slice(at + 1)
  const header = Buffer.alloc(512); text(header, 0, 100, name); text(header, 345, 155, prefix); octal(header, 100, 8, 0o644); octal(header, 108, 8, 10_001); octal(header, 116, 8, 10_001); octal(header, 124, 12, body.byteLength); octal(header, 136, 12, 0); header.fill(0x20, 148, 156); header[156] = 0x30; text(header, 257, 6, 'ustar'); text(header, 263, 2, '00'); checksum(header)
  return Buffer.concat([header, body, Buffer.alloc((512 - body.byteLength % 512) % 512), Buffer.alloc(1024)])
}
function mutate(value: Buffer, action: (copy: Buffer) => void): Buffer { const copy = Buffer.from(value); action(copy); return copy }
function mutateHeader(value: Buffer, action: (header: Buffer) => void): Buffer { return mutate(value, copy => { action(copy.subarray(0, 512)); checksum(copy.subarray(0, 512)) }) }
function checksum(header: Buffer): void { header.fill(0x20, 148, 156); octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0)) }
function text(target: Buffer, offset: number, length: number, value: string): void { Buffer.from(value, 'utf8').copy(target, offset, 0, length) }
function octal(target: Buffer, offset: number, length: number, value: number): void { text(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`) }
