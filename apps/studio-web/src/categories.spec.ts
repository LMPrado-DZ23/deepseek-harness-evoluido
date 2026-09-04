import { describe, expect, it } from 'vitest'
import { STUDIO_CATEGORIES } from './categories'

describe('category selector contract', () => {
  it('exposes every category supported by the Prompt-to-App core', () => {
    expect(STUDIO_CATEGORIES).toEqual([
      'landing-page',
      'catalog',
      'form-database',
      'crud-panel',
      'scheduling',
      'dashboard',
      'saas-authenticated',
    ])
  })

  it('does not expose duplicate category identifiers', () => {
    expect(new Set(STUDIO_CATEGORIES).size).toBe(STUDIO_CATEGORIES.length)
  })
})
