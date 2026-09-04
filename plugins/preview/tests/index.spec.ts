import { describe, expect, it } from 'vitest'
import { localPreviewFrameSource } from '../src/index.ts'

describe('preview runtime browser boundary', () => {
  it('binds the CSP source to localhost and the configured public port', () => {
    expect(localPreviewFrameSource(80)).toBe('http://*.dz23.localhost')
    expect(localPreviewFrameSource(4179)).toBe('http://*.dz23.localhost:4179')
    expect(() => localPreviewFrameSource(0)).toThrow('porta TCP válida')
    expect(() => localPreviewFrameSource(65_536)).toThrow('porta TCP válida')
  })
})
