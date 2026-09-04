import { describe, expect, it } from 'vitest'
import { productionTemplateDirectory } from '../src/template-policy.js'

describe('production template policy', () => {
  it('selects the reviewed Next.js v1 template packaged with the plugin', () => {
    expect(productionTemplateDirectory().replaceAll('\\', '/')).toMatch(/\/plugins\/prompt-to-app\/template\/nextjs-app@1\/$/u)
  })
})
