import { describe, expect, it } from 'vitest'
import { exportedDomain, sealBundle } from '../src/bundle.ts'
import {
  assertDomainLossAllowed,
  assertForeignInstallationAllowed,
  assertRecordLossAllowed,
  assertReplacementAllowed,
  assertRestorableBundle,
  assertRestoreIntent,
  assertUnknownObjectsAllowed,
  postgresDumpInvocation,
} from '../src/restore-policy.ts'

const domain = exportedDomain(
  { name: 'studio_test', version: 1, tables: ['records'], hasGlobal: false },
  { tables: { records: {} }, global: null },
)
const bundle = sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [domain], '2026-09-04T00:00:00.000Z')

describe('restore destructive boundary policy', () => {
  it('requires a safety destination only for writes', () => {
    expect(() => assertRestoreIntent(false, undefined)).not.toThrow()
    expect(() => assertRestoreIntent(true, 'safety.dump')).not.toThrow()
    expect(() => assertRestoreIntent(true, undefined)).toThrow('mandatory')
    expect(() => assertRestoreIntent(true, '')).toThrow('mandatory')
  })

  it('refuses an empty backup', () => {
    expect(() => assertRestorableBundle(bundle)).not.toThrow()
    expect(() => assertRestorableBundle({ ...bundle, domains: [] })).toThrow('nenhum domínio')
  })

  it('requires both force and the exact spoken confirmation for replacement', () => {
    expect(() => assertReplacementAllowed(false, false, undefined)).not.toThrow()
    expect(() => assertReplacementAllowed(true, true, 'REPLACE_DZ23_STORAGE')).not.toThrow()
    expect(() => assertReplacementAllowed(true, false, 'REPLACE_DZ23_STORAGE')).toThrow('confirmação')
    expect(() => assertReplacementAllowed(true, true, 'wrong')).toThrow('confirmação')
  })

  it('requires both permission and confirmation when domains would disappear', () => {
    expect(() => assertDomainLossAllowed([], false, undefined)).not.toThrow()
    expect(() => assertDomainLossAllowed(['old'], true, 'REPLACE_DZ23_STORAGE')).not.toThrow()
    expect(() => assertDomainLossAllowed(['old'], false, 'REPLACE_DZ23_STORAGE')).toThrow('apagaria')
    expect(() => assertDomainLossAllowed(['old'], true, 'wrong')).toThrow('apagaria')
  })

  it('requires record-loss permission and confirmation together for losses per domain or global value', () => {
    const recordLoss = [{ domain: 'studio_projects', recordsInBackup: 2, recordsInTarget: 5, globalWouldBeLost: false }]
    const globalLoss = [{ domain: 'studio_settings', recordsInBackup: 1, recordsInTarget: 1, globalWouldBeLost: true }]
    const noLoss = [{ domain: 'studio_projects', recordsInBackup: 5, recordsInTarget: 5, globalWouldBeLost: false }]

    expect(() => assertRecordLossAllowed(noLoss, false, undefined)).not.toThrow()
    expect(() => assertRecordLossAllowed(recordLoss, true, 'REPLACE_DZ23_STORAGE')).not.toThrow()
    expect(() => assertRecordLossAllowed(recordLoss, false, 'REPLACE_DZ23_STORAGE')).toThrow('--allow-record-loss')
    expect(() => assertRecordLossAllowed(recordLoss, true, 'wrong')).toThrow('--confirm REPLACE_DZ23_STORAGE')
    expect(() => assertRecordLossAllowed(globalLoss, false, undefined)).toThrow('valor global')
  })

  it('requires unknown-object permission and confirmation together', () => {
    const unknown = ['tabela "future_records"', 'coluna "units.future_value"']

    expect(() => assertUnknownObjectsAllowed([], false, undefined)).not.toThrow()
    expect(() => assertUnknownObjectsAllowed(unknown, true, 'REPLACE_DZ23_STORAGE')).not.toThrow()
    expect(() => assertUnknownObjectsAllowed(unknown, false, 'REPLACE_DZ23_STORAGE')).toThrow('--allow-unknown-objects')
    expect(() => assertUnknownObjectsAllowed(unknown, true, 'wrong')).toThrow('--confirm REPLACE_DZ23_STORAGE')
  })

  it('requires foreign-installation permission and confirmation together only for known different identities', () => {
    expect(() => assertForeignInstallationAllowed('installation-a', 'installation-a', false, undefined)).not.toThrow()
    expect(() => assertForeignInstallationAllowed(undefined, 'installation-a', false, undefined)).not.toThrow()
    expect(() => assertForeignInstallationAllowed('installation-a', null, false, undefined)).not.toThrow()
    expect(() => assertForeignInstallationAllowed('installation-a', 'installation-b', true, 'REPLACE_DZ23_STORAGE')).not.toThrow()
    expect(() => assertForeignInstallationAllowed('installation-a', 'installation-b', false, 'REPLACE_DZ23_STORAGE')).toThrow('--allow-foreign-installation')
    expect(() => assertForeignInstallationAllowed('installation-a', 'installation-b', true, 'wrong')).toThrow('--confirm REPLACE_DZ23_STORAGE')
  })

  it('puts connection material only in the child environment', () => {
    const dsn = 'postgres://operator:secret@database/studio?sslmode=disable'
    const explicit = postgresDumpInvocation(dsn, 'dz23_storage', 'require', {})
    const implicit = postgresDumpInvocation('postgres://database/studio', 'dz23_storage', 'off')
    expect(explicit.args).toEqual(['--schema=dz23_storage', '--format=custom'])
    expect(explicit.args.join(' ')).not.toContain('secret')
    expect(explicit.environment.PGPASSWORD).toBe('secret')
    expect(explicit.environment.PGDATABASE).not.toContain('secret')
    expect(implicit.environment.PGSSLMODE).toBe('disable')
  })
})
