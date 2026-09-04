import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localPreviewFrameSource } from '../src/index.ts'

describe('preview runtime browser boundary', () => {
  it('binds the CSP source to localhost and the configured public port', () => {
    expect(localPreviewFrameSource(80)).toBe('http://*.dz23.localhost')
    expect(localPreviewFrameSource(4179)).toBe('http://*.dz23.localhost:4179')
    expect(() => localPreviewFrameSource(0)).toThrow('porta TCP válida')
    expect(() => localPreviewFrameSource(65_536)).toThrow('porta TCP válida')
  })

  it('declares the distributed capacity lifecycle dependency in the edge overlay', () => {
    const edgePatch = readFileSync(resolve(process.cwd(), 'deploy/harness/edge.patch.yml'), 'utf8')
    expect(edgePatch).toMatch(/- id: dz23-studio-preview\s+inject:\s+- studioCapacity\s+config:\s+capacityMode: edge/u)
  })
})
