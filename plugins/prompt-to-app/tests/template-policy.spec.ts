import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { productionTemplateDirectory } from '../src/template-policy.js'

describe('production template policy', () => {
  it('selects only the reviewed Next.js v1 template', () => {
    const root = resolve('/opt/dz23-studio')
    expect(productionTemplateDirectory(root)).toBe(resolve(root, 'templates', 'nextjs-app@1'))
  })
})
