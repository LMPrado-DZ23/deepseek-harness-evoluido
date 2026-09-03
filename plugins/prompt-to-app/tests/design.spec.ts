import { describe, expect, it } from 'vitest'
import { contrastRatio, createDesignSpec, designSpecV1Schema, renderDesignTokens, rgbToHsl } from '../src/design.js'

describe('DesignSpec v1', () => {
  it('rejects an unknown preset and a palette below contrast AA', () => {
    expect(() => createDesignSpec({ preset: 'luxury' as never })).toThrow()
    const valid = createDesignSpec({ preset: 'modern' })
    expect(designSpecV1Schema.safeParse({
      ...valid,
      palette: { ...valid.palette, primary: { value: { h: 0, s: 0, l: 50 }, foreground: { h: 0, s: 0, l: 55 } } },
    }).success).toBe(false)
  })

  it('emits deterministic protected tokens with AA foreground', () => {
    const spec = createDesignSpec({ preset: 'brand', primary: { h: 31, s: 92, l: 44 }, font: 'source-serif', radius: 'rounded', density: 'compact', tone: 'formal' })
    for (const color of Object.values(spec.palette)) expect(contrastRatio(color.value, color.foreground)).toBeGreaterThanOrEqual(4.5)
    expect(renderDesignTokens(spec)).toBe(renderDesignTokens(spec))
    expect(renderDesignTokens(spec)).toContain('arquivo protegido')
    expect(renderDesignTokens(spec)).toContain('--radius: 1.125rem')
    expect(renderDesignTokens(spec)).toContain('--font-body: var(--font-dz23-serif)')
  })

  it('builds all neutral presets and normalizes RGB colors deterministically', () => {
    expect(createDesignSpec({ preset: 'professional' }).palette.neutral.value.h).toBe(222)
    expect(createDesignSpec({ preset: 'colorful' }).palette.secondary.value.h).toBe(186)
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 })
    expect(rgbToHsl(0, 255, 0)).toEqual({ h: 120, s: 100, l: 50 })
    expect(rgbToHsl(0, 0, 255)).toEqual({ h: 240, s: 100, l: 50 })
    expect(rgbToHsl(-20, 300, 0)).toEqual({ h: 120, s: 100, l: 50 })
    expect(rgbToHsl(127.5, 127.5, 127.5)).toEqual({ h: 0, s: 0, l: 50 })
    const valid = createDesignSpec({ preset: 'modern' })
    expect(designSpecV1Schema.safeParse({ ...valid, typography: { ...valid.typography, weights: [400, 400] } }).success).toBe(false)
  })
})
