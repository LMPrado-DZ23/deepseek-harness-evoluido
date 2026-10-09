import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STUDIO_CATEGORIES } from './categories'

/*
  O CONTRATO entre a lista da interface e a do núcleo.

  Este teste dizia conferir "todas as categorias suportadas pelo núcleo" e
  nunca lia o núcleo: ele trazia a lista escrita à mão uma TERCEIRA vez, ao lado
  da interface e do `studioProjectCategorySchema`. Três cópias do mesmo fato, e
  a única que acusava divergência era a que alguém precisava lembrar de
  atualizar — ou seja, ela acusava o esquecimento de quem já tinha lembrado.

  Agora ele lê o enum do núcleo. Uma categoria nova em um dos dois lados falha
  aqui até existir nos dois, que é a coisa que este arquivo sempre prometeu.
*/

/** O enum do núcleo, lido da fonte. */
function categoriasDoNucleo(): readonly string[] {
  const fonte = readFileSync(
    fileURLToPath(new URL('../../../plugins/prompt-to-app/src/model.ts', import.meta.url)),
    'utf8',
  )
  const achado = /studioProjectCategorySchema = z\.enum\(\[([^\]]+)\]\)/u.exec(fonte)
  if (achado === null) throw new Error('o núcleo não declara `studioProjectCategorySchema`')
  return [...achado[1]!.matchAll(/'([^']+)'/gu)].map(item => item[1]!)
}

describe('category selector contract', () => {
  it('exposes every category supported by the Prompt-to-App core', () => {
    // Conjunto, e não lista: a ORDEM da interface é decisão de apresentação —
    // ela decide qual pílula aparece antes do "Mais" —, e não contrato.
    expect(new Set(STUDIO_CATEGORIES)).toEqual(new Set(categoriasDoNucleo()))
  })

  it('does not expose duplicate category identifiers', () => {
    expect(new Set(STUDIO_CATEGORIES).size).toBe(STUDIO_CATEGORIES.length)
  })

  it('o núcleo declara mais de uma categoria — a leitura funcionou', () => {
    // Sem isto, uma expressão regular que parasse de casar devolveria lista
    // vazia e o contrato acima passaria comparando nada com nada.
    expect(categoriasDoNucleo().length).toBeGreaterThan(1)
  })
})
