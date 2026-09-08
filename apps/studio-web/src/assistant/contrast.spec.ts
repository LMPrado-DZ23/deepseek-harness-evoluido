import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Contraste de verdade, calculado, não procurado por string. O teste anterior de
 * acessibilidade só verificava se a folha continha `prefers-reduced-motion` — e
 * aprovava uma folha em que o modo escuro trocava o fundo e deixava a cor do
 * texto herdada do tema claro, com 1,05:1 onde o mínimo é 4,5:1.
 */
const AA_NORMAL = 4.5

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

/** Sem texto dentro: a barra indeterminada é só a animação. */
const DECORATIVE_SELECTORS = new Set(['.compaction-bar'])

/** Lê a cor declarada de uma regra, para o teste falhar quando a folha muda. */
function declaredValue(selector: string, property: 'color' | 'background'): string {
  const escaped = [...selector].map(character => /[a-zA-Z0-9\s,-]/u.test(character) ? character : `\\${character}`).join('')
  const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gu')
  let found: string | undefined
  for (const match of styles.matchAll(rule)) {
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(#[0-9a-fA-F]{6})`, 'u').exec(match[1] ?? '')
    if (declaration !== null) found = declaration[1]
  }
  if (found === undefined) throw new Error(`sem ${property} declarado para ${selector}`)
  return found
}

describe('contraste da conversa', () => {
  it('cada superfície escura declara a própria cor de texto e passa em WCAG AA', () => {
    const pairs: ReadonlyArray<readonly [string, string, string]> = [
      ['balão do assistente', '.conversation-item p,.conversation-item strong', '.conversation-item'],
      ['balão da pessoa', '.conversation-item p,.conversation-item strong', '.conversation-item.message-user'],
      ['faixa de compactação', '.compaction-band strong', '.compaction-band'],
      ['campo de texto', '.conversation-composer textarea', '.conversation-composer textarea'],
      ['pedido de confirmação', '.approval-item p,.approval-action', '.approval-item'],
    ]
    for (const [label, foregroundSelector, backgroundSelector] of pairs) {
      const foreground = declaredValue(foregroundSelector, 'color')
      const background = declaredValue(backgroundSelector, 'background')
      expect(contrastRatio(foreground, background), `${label} (${foreground} sobre ${background})`)
        .toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('o modo escuro nunca escurece um fundo da conversa sem redefinir o texto', () => {
    const darkBlocks = [...styles.matchAll(/@media \(prefers-color-scheme:dark\)\{([\s\S]*?)\n\}/gu)]
      .map(match => match[1] ?? '')
    expect(darkBlocks.length).toBeGreaterThan(0)
    for (const block of darkBlocks) {
      for (const rule of block.matchAll(/([^{}\n]+)\{([^}]*)\}/gu)) {
        const selector = (rule[1] ?? '').trim()
        const body = rule[2] ?? ''
        // As duas buscas são ancoradas no início da declaração: sem a âncora,
        // `border-color:#...` casava com `color:` e a regra passava sem nunca
        // ter declarado a cor do texto - um guarda que não podia falhar.
        if (!/(?:^|;)\s*background(?:-color)?\s*:\s*#/u.test(body)) continue
        if (!/^\.(conversation|compaction|approval)/u.test(selector)) continue
        // Elementos puramente decorativos não carregam texto. A lista é curta e
        // explícita de propósito: cada entrada aqui é uma promessa de que
        // ninguém vai ler nada em cima daquele fundo.
        if (DECORATIVE_SELECTORS.has(selector)) continue
        expect(body, `${selector} escurece o fundo sem declarar a cor do texto`).toMatch(/(?:^|;)\s*color\s*:\s*#/u)
      }
    }
  })

  it('respeita movimento reduzido sem depender de uma busca por string solta', () => {
    const reduced = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n?\}/u.exec(styles)
    expect(reduced).not.toBeNull()
    expect(reduced?.[1]).toContain('animation:none')
  })
})
