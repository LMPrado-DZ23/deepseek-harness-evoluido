import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceJournal, assertJournalIdentity, journalReached, loadRestoreJournal, writeRestoreJournal, type RestoreJournal } from '../src/restore-journal.ts'

const scratch: string[] = []
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }) })

function journal(): RestoreJournal {
  return {
    v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', inputSha256: 'a'.repeat(64),
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
    expect(() => assertJournalIdentity(loaded!, { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', inputSha256: 'a'.repeat(64), safetyDestination: '/private/safety.dump' })).not.toThrow()
  })

  it('refuses identity reuse, regression and malformed journal', async () => {
    expect(() => assertJournalIdentity(journal(), { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', inputSha256: 'b'.repeat(64), safetyDestination: '/private/safety.dump' })).toThrow('outra restauração')
    expect(() => assertJournalIdentity(journal(), { attemptId: 'attempt-0001', targetSchema: 'dz23_storage', inputSha256: 'a'.repeat(64), safetyDestination: '/other/safety.dump' })).toThrow('outra restauração')
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
      null, [], { ...journal(), v: 2 }, { ...journal(), attemptId: 'bad' }, { ...journal(), targetSchema: 'Bad-Schema' },
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
    await symlink(source, path)
    await expect(loadRestoreJournal(path)).rejects.toThrow('inválido')
    await rm(path)
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

  it('removes its temporary file if atomic publication cannot replace the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-journal-publish-'))
    scratch.push(root)
    const path = join(root, 'attempt.json')
    await mkdir(path)
    await expect(writeRestoreJournal(path, journal())).rejects.toThrow()
  })
})
