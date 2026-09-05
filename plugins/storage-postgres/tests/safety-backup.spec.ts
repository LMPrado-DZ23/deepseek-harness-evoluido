import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPostgresSafetyBackup } from '../src/restore.ts'
import { canonicalJson, sha256 } from '../src/bundle.ts'

const scratch: string[] = []
const ownership = { attemptId: 'attempt-safety-01', targetSchema: 'dz23_storage', targetFingerprint: 'f'.repeat(64), inputSha256: 'a'.repeat(64) }

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; bin: string; output: string; environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-safety-backup-'))
  scratch.push(root)
  await chmod(root, 0o700)
  const bin = join(root, 'bin')
  const output = join(root, 'before-restore.dump')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(bin, { mode: 0o700 }))
  const environment = { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, LANG: 'C', LC_ALL: 'C' }
  return { root, bin, output, environment }
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { encoding: 'utf8', mode: 0o700 })
  await chmod(path, 0o700)
}

describe.skipIf(process.platform !== 'linux')('physical safety backup publisher', () => {
  it('requires valid ownership and enforces non-empty and bounded dumps', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nexit 0\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment)).rejects.toThrow('identidade')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)).rejects.toThrow('não vazio')
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-too-large"\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, 4, ownership)).rejects.toThrow('excede o limite')
    expect((await readdir(root)).filter(name => name.includes('.partial-'))).toEqual([])
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, {
      ...ownership, inputSha256: 'invalid',
    })).rejects.toThrow('Identidade')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, {
      ...ownership, targetFingerprint: 'invalid',
    })).rejects.toThrow('destino')
  })

  it('reaps only the deterministic partial authenticated by the exact owner marker', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-recovered"\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    const key = sha256(canonicalJson(ownership)).slice(0, 24)
    const partial = join(root, `.before-restore.dump.partial-${key}`)
    await writeFile(partial, 'crash-remnant', { mode: 0o600 })
    const report = await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, true, undefined, ownership)
    expect(report.bytes).toBeGreaterThan(0)
    await expect(readFile(partial, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes owner, data and sidecar link-to-final crash cuts only for the exact attempt', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nexit 9\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    const ownerText = `${JSON.stringify({ v: 1, ...ownership })}\n`
    const ownerPartial = join(root, `.before-restore.dump.owner.json.partial-${sha256(ownerText).slice(0, 24)}`)
    await writeFile(ownerPartial, ownerText, { mode: 0o600 })
    await link(ownerPartial, `${output}.owner.json`)

    const key = sha256(canonicalJson(ownership)).slice(0, 24)
    const dataPartial = join(root, `.before-restore.dump.partial-${key}`)
    const data = 'PGDMP-link-cut'
    await writeFile(dataPartial, data, { mode: 0o600 })
    await link(dataPartial, output)
    const sidecarPartial = `${dataPartial}.sha256`
    await writeFile(sidecarPartial, `${sha256(data)}  before-restore.dump\n`, { mode: 0o600 })
    await link(sidecarPartial, `${output}.sha256`)

    const recovered = await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, true, undefined, ownership)
    expect(recovered.sha256).toBe(sha256(data))
    for (const path of [ownerPartial, dataPartial, sidecarPartial]) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of [`${output}.owner.json`, output, `${output}.sha256`]) expect((await lstat(path)).nlink).toBe(1)
  })

  it('publishes data then its digest marker, verifies pg_restore, and safely replays', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-safe-content"\n')
    await executable(join(bin, 'pg_restore'), `#!/bin/sh
printf '%s' "$*" > '${join(root, 'restore-argv.txt')}'
case "$1" in --list) exit 0;; *) exit 9;; esac
`)

    const first = await createPostgresSafetyBackup('postgres://operator:secret@database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)
    expect(first.file).toBe(output)
    expect(first.bytes).toBeGreaterThan(0)
    expect(await readFile(`${output}.sha256`, 'utf8')).toContain(first.sha256)
    expect(await readFile(join(root, 'restore-argv.txt'), 'utf8')).toContain('/proc/self/fd/3')
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(`${output}.owner.json`, 'utf8'))).toEqual({ v: 1, ...ownership })
    expect((await readdir(root)).filter(name => name.includes('.partial-'))).toEqual([])

    const replay = await createPostgresSafetyBackup('postgres://operator:secret@database/studio', 'dz23_storage', output, 'off', environment, undefined, true, undefined, ownership)
    expect(replay).toEqual(first)
    await expect(createPostgresSafetyBackup('postgres://operator:secret@database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)).rejects.toThrow('Já existe')

    await writeFile(`${output}.sha256`, `${'0'.repeat(64)}  before-restore.dump\n`, { mode: 0o600 })
    await expect(createPostgresSafetyBackup('postgres://operator:secret@database/studio', 'dz23_storage', output, 'off', environment, undefined, true, undefined, ownership)).rejects.toThrow('sidecar inválido')
  })

  it('never publishes a partial dump or an uninspectable dump, and retry remains possible', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "partial"\nexit 7\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)).rejects.toThrow('pg_dump failed')
    expect(await readdir(root)).not.toContain('before-restore.dump')

    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-complete"\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 8\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)).rejects.toThrow('pg_restore failed')
    expect((await readdir(root)).filter(name => name === 'before-restore.dump' || name === 'before-restore.dump.sha256' || name.includes('.partial-'))).toEqual([])

    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)).resolves.toMatchObject({ file: output })
  })

  it('rejects a dump changed through its pathname while pg_restore inspects the pinned descriptor', async () => {
    const { bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-before-race"\n')
    await executable(join(bin, 'pg_restore'), `#!/bin/sh
printf "tampered" >> "$2"
exit 0
`)
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, {
      ...ownership, attemptId: 'attempt-safety-path-race',
    })).rejects.toThrow('mudou durante a verificação')
    expect((await readdir(join(output, '..'))).filter(name => name === 'before-restore.dump' || name === 'before-restore.dump.sha256' || name.includes('.partial-'))).toEqual([])
  })

  it('honours cancellation without deleting an already published valid backup', async () => {
    const { bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-complete"\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    const published = await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)
    const controller = new AbortController()
    controller.abort(new Error('cancelled-by-test'))
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, controller.signal, true, undefined, ownership)).rejects.toThrow('cancelled-by-test')
    expect(await readFile(output, 'utf8')).toContain('PGDMP-complete')
    expect(await readFile(`${output}.sha256`, 'utf8')).toContain(published.sha256)
  })

  it('never adopts another attempt ownership or overwrites a destination created during pg_dump', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-first"\n')
    await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, true, undefined, {
      ...ownership, attemptId: 'attempt-safety-02',
    })).rejects.toThrow('outra tentativa')

    const second = join(root, 'race.dump')
    await executable(join(bin, 'pg_dump'), `#!/bin/sh
printf "foreign-content" > '${second}'
printf "PGDMP-owned"
`)
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second, 'off', environment, undefined, false, undefined, {
      ...ownership, attemptId: 'attempt-safety-03',
    })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(second, 'utf8')).toBe('foreign-content')

    const third = await fixture()
    await executable(join(third.bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-never-runs"\n')
    await executable(join(third.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await writeFile(`${third.output}.owner.json`, '', { mode: 0o600 })
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', third.output, 'off', third.environment, undefined, true, undefined, {
      ...ownership, attemptId: 'attempt-safety-06',
    })).rejects.toThrow('outra tentativa')
    expect(await readdir(third.root)).not.toContain('before-restore.dump')

    const fourth = await fixture()
    await import('node:fs/promises').then(({ mkdir }) => mkdir(`${fourth.output}.owner.json`))
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', fourth.output, 'off', fourth.environment, undefined, true, undefined, {
      ...ownership, attemptId: 'attempt-safety-07',
    })).rejects.toThrow('outra tentativa')
  })

  it('reports a missing pg_dump without publishing or leaking a partial', async () => {
    const { root, output } = await fixture()
    const emptyBin = join(root, 'empty-bin')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(emptyBin))
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', { PATH: emptyBin, LANG: 'C', LC_ALL: 'C' }, undefined, false, undefined, {
      ...ownership, attemptId: 'attempt-safety-08',
    })).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter(name => name === 'before-restore.dump' || name === 'before-restore.dump.sha256' || name.includes('.partial-'))).toEqual([])
  })

  it('recovers only its reserved data-before-sidecar cut and replaces an uncommitted sidecar-only cut', async () => {
    const first = await fixture()
    await executable(join(first.bin, 'pg_dump'), '#!/bin/sh\nexit 7\n')
    await executable(join(first.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, false, undefined, ownership)).rejects.toThrow('pg_dump failed')
    await writeFile(first.output, 'PGDMP-data-published-before-crash', { mode: 0o600 })
    const recovered = await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, true, undefined, ownership)
    expect(await readFile(`${first.output}.sha256`, 'utf8')).toContain(recovered.sha256)

    const second = await fixture()
    const secondOwner = { ...ownership, attemptId: 'attempt-safety-04' }
    await executable(join(second.bin, 'pg_dump'), '#!/bin/sh\nexit 7\n')
    await executable(join(second.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second.output, 'off', second.environment, undefined, false, undefined, secondOwner)).rejects.toThrow('pg_dump failed')
    await writeFile(`${second.output}.sha256`, `${'f'.repeat(64)}  before-restore.dump\n`, { mode: 0o600 })
    await executable(join(second.bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-retry"\n')
    const rebuilt = await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second.output, 'off', second.environment, undefined, true, undefined, secondOwner)
    expect(await readFile(second.output, 'utf8')).toBe('PGDMP-retry')
    expect(await readFile(`${second.output}.sha256`, 'utf8')).toContain(rebuilt.sha256)
  })

  it('refuses a multiply linked safety artifact even when the attempt owns the destination', async () => {
    const { root, bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nexit 7\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    const linkedOwner = { ...ownership, attemptId: 'attempt-safety-many-links' }
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, linkedOwner)).rejects.toThrow('pg_dump failed')

    const source = join(root, 'foreign-data')
    const extra = join(root, 'foreign-data-extra-link')
    await writeFile(source, 'PGDMP-foreign', { mode: 0o600 })
    await link(source, output)
    await link(source, extra)
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, true, undefined, linkedOwner)).rejects.toThrow('hardlink não autenticado')
    expect((await lstat(output)).nlink).toBe(3)
  })

  it('rejects an unauthenticated two-link crash cut and an oversized owner marker', async () => {
    const first = await fixture()
    await executable(join(first.bin, 'pg_dump'), '#!/bin/sh\nexit 7\n')
    await executable(join(first.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    const firstOwner = { ...ownership, attemptId: 'attempt-safety-two-links' }
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, false, undefined, firstOwner)).rejects.toThrow('pg_dump failed')
    const foreign = join(first.root, 'foreign-data')
    await writeFile(foreign, 'PGDMP-foreign', { mode: 0o600 })
    await link(foreign, first.output)
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, true, undefined, firstOwner)).rejects.toThrow('hardlink não autenticado')

    const second = await fixture()
    await executable(join(second.bin, 'pg_dump'), '#!/bin/sh\nexit 7\n')
    await executable(join(second.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await writeFile(`${second.output}.owner.json`, 'x'.repeat(1025), { mode: 0o600 })
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second.output, 'off', second.environment, undefined, true, undefined, {
      ...ownership, attemptId: 'attempt-safety-large-owner',
    })).rejects.toThrow('outra tentativa')
  })

  it('refuses FIFO data and sidecar paths without blocking', async () => {
    const first = await fixture()
    await executable(join(first.bin, 'pg_dump'), '#!/bin/sh\nexit 7\n')
    await executable(join(first.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, false, undefined, ownership)).rejects.toThrow('pg_dump failed')
    expect(spawnSync('mkfifo', [first.output]).status).toBe(0)
    await expect(Promise.race([
      createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, true, undefined, ownership),
      new Promise((_, reject) => setTimeout(() => reject(new Error('FIFO data blocked')), 500)),
    ])).rejects.toThrow('inválido')

    const second = await fixture()
    const secondOwner = { ...ownership, attemptId: 'attempt-safety-05' }
    await executable(join(second.bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-good"\n')
    await executable(join(second.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second.output, 'off', second.environment, undefined, false, undefined, secondOwner)
    await rm(`${second.output}.sha256`)
    expect(spawnSync('mkfifo', [`${second.output}.sha256`]).status).toBe(0)
    await expect(Promise.race([
      createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second.output, 'off', second.environment, undefined, true, undefined, secondOwner),
      new Promise((_, reject) => setTimeout(() => reject(new Error('FIFO sidecar blocked')), 500)),
    ])).rejects.toThrow('inválido')
  })

  it('blocks safety backup outside Linux instead of using a pathname fallback', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    try {
      const first = await fixture()
      await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, false, undefined, {
        ...ownership, attemptId: 'attempt-fallback-01',
      })).rejects.toThrow('exige Linux')
      await expect(readFile(`${first.output}.owner.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
