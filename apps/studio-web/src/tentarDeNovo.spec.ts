import { describe, expect, it } from 'vitest'
import { podeTentarDeNovo } from './tentarDeNovo'

describe('tentar de novo', () => {
  it.each(['INTERRUPTED', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED'])('aparece em %s', estado => { expect(podeTentarDeNovo(estado)).toBe(true) })
  it.each(['VERIFIED_PROTOTYPE', 'GENERATING', 'PLAN_APPROVED', 'DRAFT', undefined])('não aparece em %s', estado => { expect(podeTentarDeNovo(estado)).toBe(false) })
})
