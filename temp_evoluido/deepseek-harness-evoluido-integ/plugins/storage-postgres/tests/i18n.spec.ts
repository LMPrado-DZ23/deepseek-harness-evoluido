import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  STORAGE_POSTGRES_I18N_KEYS,
  t,
  type StoragePostgresI18nKey,
} from '../src/i18n.ts'

function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`))
}

describe('storage-postgres pt-BR catalogue', () => {
  it('keeps the runtime catalogue and the typed key contract identical', () => {
    const catalog: unknown = JSON.parse(
      readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
    )
    expect(flatten(catalog).sort()).toEqual([...STORAGE_POSTGRES_I18N_KEYS].sort())
    for (const key of STORAGE_POSTGRES_I18N_KEYS) expect(t(key).trim(), key).not.toBe('')
  })

  it('preserves dynamic values and leaves omitted placeholders visible', () => {
    expect(t('policy.domainLoss', { count: 2, domains: 'a, b' })).toContain('2 conjunto(s)')
    expect(t('policy.domainLoss', { count: 2, domains: 'a, b' })).toContain('(a, b)')
    expect(t('restore.unexpectedCatalogName')).toContain('{name}')
    expect(t('restore.unexpectedCatalogName')).not.toContain('undefined')
  })

  it('rejects missing, branch and prototype keys instead of rendering them', () => {
    for (const key of ['missing', 'restore', 'constructor', '__proto__.missing']) {
      expect(() => t(key as StoragePostgresI18nKey), key).toThrow(`I18N_KEY_MISSING:${key}`)
    }
  })
})
