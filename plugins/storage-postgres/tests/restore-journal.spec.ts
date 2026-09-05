import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceJournal, assertJournalIdentity, journalReached, loadRestoreJournal, reserveRestoreJournal, writeRestoreJournal, type RestoreJournal } from '../src/restore-journal.ts'

const scratch: string[] = []
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }) })

function journal(): RestoreJournal {
  return {
    v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint: 'f'.repeat(64), inputSha256: 'a'.repeat(64),
    safetyDestination: '/private/safety.dump',
    state: 'verified', stagingSchema: null, safety: null, result: null, updatedAt: '2026-09-04T00:00:00.000Z',
  }
}

describe('durable restore journal', () => {
  it('publishes atomically and reloads the exact identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    expect(await loadRestoreJournal(path)).toBeUndefined()
    await writeRestoreJournal(path, journal())
    const loaded = await loadRestoreJournal(path)
    expect(loaded).toEqual(journal())
    expect(() => assertJournalIdentity(loaded!, { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint: 'f'.repeat(64), inputSha256: 'a'.repeat(64), safetyDestination: '/private/safety.dump' })).not.toThrow()
  })

  it('reserves an attempt without replacing the winner of a concurrent claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-reserve-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    const [first, second] = await Promise.all([
      reserveRestoreJournal(path, journal()),
      reserveRestoreJournal(path, { ...journal(), targetFingerprint: 'e'.repeat(64) }),
    ])
    expect([first, second].sort()).toEqual([false, true])
    const loaded = await loadRestoreJournal(path)
    expect([journal().targetFingerprint, 'e'.repeat(64)]).toContain(loaded?.targetFingerprint)
  })

  it('recovers the exact link-to-final crash cut without accepting an unrelated hardlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-link-cut-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    const temporary = join(root, '.attempt.json.abcdef.reserve')
    await writeFile(temporary, `${JSON.stringify(journal())}\n`, { mode: 0o600 })
    await link(temporary, path)
    await expect(loadRestoreJournal(path)).resolves.toEqual(journal())
    await expect(import('node:fs/promises').then(({ lstat }) => lstat(temporary))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await import('node:fs/promises').then(({ lstat }) => lstat(path))).nlink).toBe(1)

    const foreign = join(root, 'foreign.json')
    await rm(path)
    await writeFile(foreign, `${JSON.stringify(journal())}\n`, { mode: 0o600 })
    await link(foreign, path)
    await expect(loadRestoreJournal(path)).rejects.toThrow('hardlink não autenticado')

    const secondForeignLink = join(root, 'foreign-second-link.json')
    await link(foreign, secondForeignLink)
    await expect(loadRestoreJournal(path)).rejects.toThrow('hardlink não autenticado')
  })

  it('refuses identity reuse, regression and malformed journal', async () => {
    expect(() => assertJournalIdentity(journal(), { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint: 'f'.repeat(64), inputSha256: 'b'.repeat(64), safetyDestination: '/private/safety.dump' })).toThrow('outra restauração')
    expect(() => assertJournalIdentity(journal(), { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint: 'e'.repeat(64), inputSha256: 'a'.repeat(64), safetyDestination: '/private/safety.dump' })).toThrow('outra restauração')
    expect(() => assertJournalIdentity(journal(), { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint: 'f'.repeat(64), inputSha256: 'a'.repeat(64), safetyDestination: '/other/safety.dump' })).toThrow('outra restauração')
    const committed = advanceJournal(journal(), 'committed', { result: { readyToStart: true } })
    expect(committed.state).toBe('committed')
    expect(journalReached(committed, 'swap_started')).toBe(true)
    expect(journalReached(journal(), 'committed')).toBe(false)
    expect(() => advanceJournal(committed, 'staging_created')).toThrow('retroceder')
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-invalid-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    await writeFile(path, '{}')
    await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
  })

  it('validates every persisted field and accepts complete safety/result metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-fields-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    const valid = {
      ...journal(), state: 'swap_started' as const, stagingSchema: 'dz23_storage_staging_abcd',
      safety: { path: '/private/safety.dump', sha256: 'b'.repeat(64), bytes: 42 },
      result: { mode: 'write', domains: 1, safetyBackup: '/private/safety.dump', safetyBackupStatus: 'created', safetyBackupSha256: 'b'.repeat(64), replacedDomains: [], droppedDomains: [], reapedStaging: [], readyToStart: true },
    }
    await writeRestoreJournal(path, valid)
    await expect(loadRestoreJournal(path)).resolves.toEqual(valid)

    const invalid: unknown[] = [
      null, [], { ...journal(), v: 2 }, { ...journal(), attemptId: 'bad' }, { ...journal(), targetSchema: 'Bad-Schema' }, { ...journal(), targetFingerprint: 'bad' },
      { ...journal(), inputSha256: 'x' }, { ...journal(), safetyDestination: '' }, { ...journal(), state: 'invented' }, { ...journal(), stagingSchema: '../escape' },
      { ...journal(), safety: undefined }, { ...journal(), safety: {} }, { ...journal(), safety: { path: '', sha256: 'b'.repeat(64), bytes: 1 } },
      { ...journal(), safety: { path: '/x', sha256: 'x', bytes: 1 } }, { ...journal(), safety: { path: '/x', sha256: 'b'.repeat(64), bytes: 0 } },
      { ...journal(), result: [] }, { ...journal(), state: 'swap_started', result: null },
      { ...journal(), result: { mode: 'write' } }, {
        ...journal(), state: 'swap_started', result: {
          mode: 'write', domains: 1, safetyBackup: null, safetyBackupStatus: 'not-needed-empty-target', safetyBackupSha256: null,
          replacedDomains: [1], droppedDomains: [], reapedStaging: [], readyToStart: true,
        },
      }, { ...journal(), updatedAt: 'not-a-date' },
    ]
    for (const value of invalid) {
      await writeFile(path, JSON.stringify(value))
      await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
    }
  })

  it('refuses linked, oversized and non-regular journals without blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-shape-'))
    scratch.push(root)
    const source = join(root, 'source.json')
    const path = join(root, 'attempt.json')
    await writeFile(source, JSON.stringify(journal()))
    await link(source, path)
    await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
    await rm(path)
    if (process.platform !== 'win32') {
      await symlink(source, path)
      await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
      await rm(path)
    }
    await writeFile(path, 'x'.repeat(65 * 1024))
    await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
    await rm(path)

    if (process.platform !== 'win32') {
      expect(spawnSync('mkfifo', [path]).status).toBe(0)
      await expect(Promise.race([
        loadRestoreJournal(path),
        new Promise((_, reject) => setTimeout(() => reject(new Error('journal FIFO blocked')), 500)),
      ])).rejects.toThrow('inválido')
    }
  })

  it('bounds interrupted-publication recovery and rejects a linked directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-bounded-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    await mkdir(path)
    await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
    await rm(path, { recursive: true })

    const temporary = join(root, '.attempt.json.abcdef.reserve')
    await writeFile(temporary, `${JSON.stringify(journal())}\n`, { mode: 0o600 })
    await link(temporary, path)
    for (let index = 0; index < 257; index += 1) await writeFile(join(root, `unrelated-${String(index).padStart(3, '0')}`), 'x')
    await expect(loadRestoreJournal(path)).rejects.toThrow('limite de recuperação segura')
  })

  it.skipIf(process.platform === 'win32')('propagates filesystem refusal for an unrepresentable journal name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-name-'))
    scratch.push(root)
    const path = join(root, 'x'.repeat(300))
    await expect(loadRestoreJournal(path)).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    await expect(writeRestoreJournal(path, journal())).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
  })

  it('removes its temporary file if atomic publication cannot replace the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-publish-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    await mkdir(path)
    await expect(writeRestoreJournal(path, journal())).rejects.toThrow()
  })

  it('refuses to replace a hard-linked ledger destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-hardlink-'))
    scratch.push(root)
    const source = join(root, 'source.json')
    const path = join(root, 'attempt.json')
    await writeFile(source, JSON.stringify(journal()), { mode: 0o600 })
    await link(source, path)
    await expect(writeRestoreJournal(path, journal())).rejects.toThrow('arquivo privado estável')
  })
})
