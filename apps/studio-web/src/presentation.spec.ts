import { describe, expect, it } from 'vitest'
import t from './i18n/pt-BR.json'
import { currentStepIndex, permanentTruthKind, privacyNotice, type ProjectUiState } from './presentation'

describe('truthful presentation for nontechnical users', () => {
  it('maps the real machine states to the five visible stages', () => {
    const expected: Record<ProjectUiState, number> = {
      DRAFT: 1, SPEC_READY: 2, PLAN_PROPOSED: 2, PLAN_APPROVED: 3, GENERATING: 3,
      BUILD_OK: 3, BUILD_FAILED: 3, TESTS_OK: 4, TESTS_FAILED: 4, CANCELLED: 4, VERIFIED_PROTOTYPE: 4,
    }
    for (const [state, step] of Object.entries(expected)) expect(currentStepIndex(state as ProjectUiState)).toBe(step)
  })

  it('shows the permanent prototype notice only during creation and verification', () => {
    expect(permanentTruthKind(null)).toBeNull()
    expect(permanentTruthKind('DRAFT')).toBeNull()
    expect(permanentTruthKind('SPEC_READY')).toBeNull()
    expect(permanentTruthKind('PLAN_PROPOSED')).toBeNull()
    expect(permanentTruthKind('GENERATING')).toBe('creation')
    expect(permanentTruthKind('BUILD_FAILED')).toBe('creation')
    expect(permanentTruthKind('TESTS_OK')).toBe('verified')
    expect(permanentTruthKind('VERIFIED_PROTOTYPE')).toBe('verified')
  })

  it('changes the privacy explanation with the selected route mode', () => {
    expect(privacyNotice('local-only', 'openrouter', t.privacy)).toBe(t.privacy.localNotice)
    expect(privacyNotice('any', 'openrouter', t.privacy)).toContain('openrouter')
    expect(privacyNotice('any', null, t.privacy)).toBe(t.privacy.routeUnavailable)
    expect(privacyNotice('local-only', 'openrouter', t.privacy)).not.toContain('openrouter')
  })
})
