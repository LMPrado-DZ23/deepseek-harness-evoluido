import { describe, expect, it } from 'vitest'
import {
  GeneratedAppI18nError,
  loadGeneratedAppCatalog,
  parseGeneratedAppCatalog,
  tGeneratedApp,
  translateGeneratedApp,
  validateGeneratedAppCatalog,
} from '../src/generated-i18n.js'

function errorCode(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    return error instanceof GeneratedAppI18nError ? error.code : undefined
  }
  return undefined
}

describe('generated application i18n', () => {
  it('loads the complete pt-BR catalog and resolves typed keys', () => {
    const catalog = loadGeneratedAppCatalog()
    expect(catalog.common.save).toBe('Salvar')
    expect(tGeneratedApp('dashboard.emptyState')).toContain('dados')
    expect(translateGeneratedApp(catalog, 'scheduling.statusConfirmed')).toBe('Confirmado')
  })

  it('escapes interpolated values without evaluating markup', () => {
    const catalog = loadGeneratedAppCatalog()
    expect(translateGeneratedApp(catalog, 'smtp.deliveryDescription', {
      email: '<img src=x onerror="alert(1)">&\'owner',
    })).toBe('Enviaremos um código de acesso para &lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;owner.')
  })

  it('fails closed when interpolation is missing or not declared', () => {
    const catalog = loadGeneratedAppCatalog()
    expect(errorCode(() => translateGeneratedApp(catalog, 'reference.label'))).toBe('INTERPOLATION_MISSING')
    expect(errorCode(() => translateGeneratedApp(catalog, 'common.save', { unused: 'value' }))).toBe('INTERPOLATION_UNKNOWN')
  })

  it('rejects invalid JSON and an unreadable source', () => {
    expect(errorCode(() => parseGeneratedAppCatalog('{'))).toBe('CATALOG_INVALID_JSON')
    expect(errorCode(() => loadGeneratedAppCatalog(new URL('file:///definitely-missing-dz23-catalog.json')))).toBe('CATALOG_READ_FAILED')
  })

  it('rejects missing, empty, unknown and malformed catalog entries', () => {
    const valid = JSON.parse(JSON.stringify(loadGeneratedAppCatalog())) as Record<string, Record<string, unknown>>

    const missing = structuredClone(valid)
    delete missing.auth?.title
    expect(errorCode(() => validateGeneratedAppCatalog(missing))).toBe('CATALOG_MISSING_KEY')

    const empty = structuredClone(valid)
    if (empty.common) empty.common.save = '   '
    expect(errorCode(() => validateGeneratedAppCatalog(empty))).toBe('CATALOG_EMPTY_VALUE')

    const unknown = structuredClone(valid)
    if (unknown.dashboard) unknown.dashboard.secretHtml = '<script />'
    expect(errorCode(() => validateGeneratedAppCatalog(unknown))).toBe('CATALOG_UNKNOWN_KEY')

    const malformed = structuredClone(valid)
    if (malformed.smtp) malformed.smtp.deliveryDescription = 'Enviar para {email'
    expect(errorCode(() => validateGeneratedAppCatalog(malformed))).toBe('CATALOG_INVALID_PLACEHOLDER')
  })

  it('rejects non-object roots, missing namespaces and non-string values', () => {
    expect(errorCode(() => validateGeneratedAppCatalog([]))).toBe('CATALOG_INVALID_SHAPE')

    const missingNamespace = JSON.parse(JSON.stringify(loadGeneratedAppCatalog())) as Record<string, unknown>
    delete missingNamespace.smtp
    expect(errorCode(() => validateGeneratedAppCatalog(missingNamespace))).toBe('CATALOG_MISSING_KEY')

    const nonString = JSON.parse(JSON.stringify(loadGeneratedAppCatalog())) as Record<string, Record<string, unknown>>
    if (nonString.common) nonString.common.save = 42
    expect(errorCode(() => validateGeneratedAppCatalog(nonString))).toBe('CATALOG_MISSING_KEY')
  })

  it('covers null-prototype catalogs, unknown namespaces and a missing runtime key', () => {
    const valid = JSON.parse(JSON.stringify(loadGeneratedAppCatalog())) as Record<string, Record<string, unknown>>
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, valid)
    expect(validateGeneratedAppCatalog(nullPrototype).common.save).toBe('Salvar')

    const unknownNamespace = structuredClone(valid) as Record<string, unknown>
    unknownNamespace.internal = {}
    expect(errorCode(() => validateGeneratedAppCatalog(unknownNamespace))).toBe('CATALOG_UNKNOWN_KEY')

    const missingRuntime = structuredClone(valid)
    delete missingRuntime.common?.save
    expect(errorCode(() => translateGeneratedApp(missingRuntime as never, 'common.save'))).toBe('TRANSLATION_MISSING')
  })
})
