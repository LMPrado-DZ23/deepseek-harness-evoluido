import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPostgresSafetyBackup } from '../src/restore.ts'

const scratch: string[] = []
const ownership = { attemptId: 'attempt-safety-01', targetSchema: 'dz23_storage', inputSha256: 'a'.repeat(64) }

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

describe.skipIf(process.platform === 'win32')('physical safety backup publisher', () => {
  it('requires valid ownership and enforces non-empty and bounded dumps', async () => {
    const { bin, output, environment } = await fixture()
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nexit 0\n')
    await executable(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment)).rejects.toThrow('identidade')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, ownership)).rejects.toThrow('não vazio')
    await executable(join(bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-too-large"\n')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, 4, ownership)).rejects.toThrow('excede o limite')
    await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', output, 'off', environment, undefined, false, undefined, {
      ...ownership, inputSha256: 'invalid',
    })).rejects.toThrow('Identidade')
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

  it('revalidates pathname identity on the non-/proc fallback and detects mutation by pg_restore', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    try {
      const first = await fixture()
      await executable(join(first.bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-fallback"\n')
      await executable(join(first.bin, 'pg_restore'), '#!/bin/sh\nexit 0\n')
      await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', first.output, 'off', first.environment, undefined, false, undefined, {
        ...ownership, attemptId: 'attempt-fallback-01',
      })).resolves.toMatchObject({ file: first.output })

      const second = await fixture()
      await executable(join(second.bin, 'pg_dump'), '#!/bin/sh\nprintf "PGDMP-mutated"\n')
      await executable(join(second.bin, 'pg_restore'), '#!/bin/sh\nprintf "x" >> "$2"\nexit 0\n')
      await expect(createPostgresSafetyBackup('postgres://database/studio', 'dz23_storage', second.output, 'off', second.environment, undefined, false, undefined, {
        ...ownership, attemptId: 'attempt-fallback-02',
      })).rejects.toThrow('mudou durante a verificação')
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
