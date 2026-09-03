import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contrastRatio, createDesignSpec, designSpecV1Schema, renderDesignTokens, rgbToHsl } from '../src/design.js'
import { writeDesignAssets } from '../src/pipeline.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

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

  it('copies a verified brand logo into the protected generated app path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-design-assets-')); roots.push(root)
    const store = resolve(root, 'store'); const run = resolve(root, 'run'); const bytes = Buffer.from('verified-png-fixture')
    const sha256 = createHash('sha256').update(bytes).digest('hex'); const relativePath = `logos/${'a'.repeat(64)}/${sha256}.png`
    await mkdir(resolve(store, relativePath, '..'), { recursive: true }); await mkdir(run)
    await writeFile(resolve(store, relativePath), bytes)
    const spec = createDesignSpec({ preset: 'brand', primary: { h: 217, s: 91, l: 50 } }, { sha256, relative_path: relativePath, mime: 'image/png', size_bytes: bytes.length, width: 10, height: 10, extracted_primary: { h: 217, s: 91, l: 50 } })
    await writeDesignAssets(run, spec, store)
    await expect(readFile(resolve(run, 'public/brand/logo.png'))).resolves.toEqual(bytes)
    await expect(writeDesignAssets(run, spec, store)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(writeDesignAssets(resolve(root, 'missing-store-run'), spec, resolve(root, 'missing'))).rejects.toThrow()
  })
})
