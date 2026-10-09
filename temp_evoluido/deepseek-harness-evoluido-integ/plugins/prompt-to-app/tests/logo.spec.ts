import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { SharpLogoProcessor } from '../src/logo.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('logo processing', () => {
  it('reprocesses PNG/JPEG as metadata-free PNG and extracts a color', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-logo-')); roots.push(root)
    const input = await sharp({ create: { width: 40, height: 30, channels: 4, background: '#075ee5' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const result = await new SharpLogoProcessor(root).process({ orgId: 'org-a', tenantId: 'tenant-a' }, input, 'image/jpeg')
    expect(result).toMatchObject({ mime: 'image/png', width: 30, height: 40 })
    expect((await sharp(await readFile(resolve(root, result.relative_path))).metadata()).format).toBe('png')
    expect(result.extracted_primary.s).toBeGreaterThan(50)
    await expect(new SharpLogoProcessor(root).process({ orgId: 'org-a', tenantId: 'tenant-a' }, input, 'image/jpeg')).resolves.toEqual(result)
  })

  it('rejects SVG, oversized content and a mismatched file signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-logo-')); roots.push(root)
    const processor = new SharpLogoProcessor(root)
    await expect(processor.process({ orgId: 'o', tenantId: 't' }, Buffer.alloc(0), 'image/png')).rejects.toThrow('PNG ou JPEG')
    await expect(processor.process({ orgId: 'o', tenantId: 't' }, Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toThrow('PNG ou JPEG')
    await expect(processor.process({ orgId: 'o', tenantId: 't' }, Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png')).rejects.toThrow('PNG ou JPEG')
    await expect(processor.process({ orgId: 'o', tenantId: 't' }, Buffer.from('not-a-png'), 'image/png')).rejects.toThrow('PNG ou JPEG')
    await expect(processor.process({ orgId: 'o', tenantId: 't' }, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png')).rejects.toThrow('PNG ou JPEG')
  })
})
