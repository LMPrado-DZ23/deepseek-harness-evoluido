import { describe, expect, it } from 'vitest'
import { cn } from '@/src/lib/utils'

describe('template utilities', () => {
  it('resolves conflicting Tailwind classes deterministically', () => { expect(cn('px-2', 'px-4')).toBe('px-4') })
})
