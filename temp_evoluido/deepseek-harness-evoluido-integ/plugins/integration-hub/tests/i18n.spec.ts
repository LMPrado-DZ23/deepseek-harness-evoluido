import { describe, expect, it } from 'vitest'
import { t } from '../src/i18n.ts'

/**
 * Every sentence this plugin ever shows a person comes through `t`. Its whole
 * failure path — a key that is not in the catalogue, a key that names a branch
 * instead of a sentence, a key that tries to walk through one — had never been
 * executed, and neither had the placeholder left without a value. A catalogue
 * lookup that fails quietly is how an interface ends up showing `undefined`,
 * `[object Object]` or an English key name to somebody in Portuguese.
 */
describe('catalogue lookup', () => {
  it('renders a sentence and substitutes every placeholder it was given a value for', () => {
    expect(t('errors.forbidden')).toBe('Seu papel não permite esta ação.')
    expect(t('errors.exportTooLarge', { limitMb: 200 })).toContain('200 MB')
  })

  it('fails loudly instead of showing a person a key, a branch or an undefined', () => {
    // Not in the catalogue at all.
    expect(() => t('errors.naoExiste')).toThrow('I18N_KEY_MISSING:errors.naoExiste')
    // A branch, not a sentence: returning it would print `[object Object]`.
    expect(() => t('errors')).toThrow('I18N_KEY_MISSING:errors')
    // Walking THROUGH a sentence: `errors.forbidden` is a string, so it has no `.extra`.
    expect(() => t('errors.forbidden.extra')).toThrow('I18N_KEY_MISSING:errors.forbidden.extra')
    // And nothing on `Object.prototype` is a translation, however it is spelled.
    for (const key of ['constructor', 'toString', '__proto__.forbidden', 'errors.constructor']) {
      expect(() => t(key), key).toThrow(`I18N_KEY_MISSING:${key}`)
    }
  })

  it('leaves a placeholder it was given no value for visible, instead of writing "undefined" into the sentence', () => {
    // The file name is what makes this refusal actionable; a caller that forgets it must produce a
    // sentence that is obviously incomplete, not one that quietly says a secret was found in
    // "undefined".
    const withoutFile = t('errors.exportSecretFound')
    expect(withoutFile).toContain('{file}')
    expect(withoutFile).not.toContain('undefined')
  })
})
