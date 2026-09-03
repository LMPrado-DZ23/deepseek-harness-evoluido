import { describe, expect, it } from 'vitest'
import content from '../content/app.json'
describe('conteúdo', () => { it('tem título e descrição', () => { expect(content.title.length).toBeGreaterThan(0); expect(content.description.length).toBeGreaterThan(0) }) })
