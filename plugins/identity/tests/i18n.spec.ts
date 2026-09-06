import { describe, expect, it } from 'vitest'
import { t } from '../src/i18n.ts'

describe('identity language catalog', () => {
  it('returns translated assistant ownership messages and rejects missing keys', () => {
    expect(t('assistant.bindingConflict')).toBe('Esta conversa já pertence a outra sessão.')
    expect(t('assistant.bindingConflictAudit')).toBe('Sessão do agente já vinculada a outra sessão de identidade.')
    expect(() => t('assistant.missing')).toThrow('I18N_KEY_MISSING:assistant.missing')
  })
})
