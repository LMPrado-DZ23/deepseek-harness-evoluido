import { describe, expect, it } from 'vitest'
import { t as hubText } from '../../integration-hub/src/i18n.ts'
import { t as previewText } from '../../preview/src/i18n.ts'
import { t as promptText } from '../src/i18n.ts'

describe('server i18n fail-closed contract', () => {
  it.each([
    ['prompt-to-app', promptText],
    ['preview', previewText],
    ['integration-hub', hubText],
  ] as const)('%s refuses missing or non-leaf keys', (_name, translate) => {
    expect(() => translate('missing.key')).toThrow('I18N_KEY_MISSING')
    expect(() => translate('errors')).toThrow('I18N_KEY_MISSING')
  })

  it.each([
    ['prompt-to-app', promptText, 'errors.generatedOutsidePlan'],
    ['preview', previewText, 'plugin.requiredSecretMissing'],
    ['integration-hub', hubText, 'errors.manifestInvalid'],
  ] as const)('%s preserves an unresolved parameter visibly', (_name, translate, key) => {
    const rendered = translate(key)
    expect(rendered).toMatch(/\{[a-zA-Z0-9_]+\}/u)
  })
})
