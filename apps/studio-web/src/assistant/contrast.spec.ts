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

/**
 * Sem texto dentro: a barra indeterminada é só a animação — e o `::after` que a
 * desenha é ainda menos que isso, um pedaço de cor que se move. A lista é curta
 * e explícita de propósito: cada entrada aqui é a promessa de que ninguém vai
 * ler nada em cima daquele fundo.
 */
const DECORATIVE_SELECTORS = new Set(['.compaction-bar', '.compaction-bar::after'])

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
      ['trabalho parado', '.stuck-run-item p,.stuck-run-id', '.stuck-run-item'],
    ]
    for (const [label, foregroundSelector, backgroundSelector] of pairs) {
      const foreground = declaredValue(foregroundSelector, 'color')
      const background = declaredValue(backgroundSelector, 'background')
      expect(contrastRatio(foreground, background), `${label} (${foreground} sobre ${background})`)
        .toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  /*
    OS DOIS TESTES QUE ESTAVAM AQUI VARRIAM `@media (prefers-color-scheme:dark)`.
    Esses blocos não existem mais: o tema grafite virou o padrão (ADR-050) e as
    regras escuras foram desembrulhadas, valendo sempre.

    A garantia não foi afrouxada; ela ficou mais direta. Antes o teste perguntava
    "quem escurece o fundo declara a cor do texto?" e, do outro lado, "quem
    clareia o texto tem alguma superfície escura?" — duas metades de uma mesma
    pergunta, separadas porque o CSS não diz quem é filho de quem. Agora a folha
    tem um só tema, então dá para perguntar a coisa inteira de uma vez: toda
    superfície ESCURA declara a cor do próprio texto, e o par passa em AA.
  */
  it('toda superfície escura da conversa declara a cor do texto, e o par passa em AA', () => {
    const familias = ['.conversation', '.compaction', '.approval', '.stuck']
    let conferidas = 0
    for (const regra of styles.matchAll(/([^{}\n]+)\{([^}]*)\}/gu)) {
      const seletor = (regra[1] ?? '').trim()
      const corpo = regra[2] ?? ''
      if (!familias.some(familia => seletor.startsWith(familia))) continue
      if (DECORATIVE_SELECTORS.has(seletor)) continue
      const fundo = /(?:^|;)\s*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{6})/u.exec(corpo)?.[1]
      if (fundo === undefined) continue
      // Escuro aqui é medido, não adivinhado pelo nome da cor.
      if (relativeLuminance(fundo) > 0.2) continue
      conferidas += 1
      const texto = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6})/u.exec(corpo)?.[1]
      expect(texto, `${seletor} escurece o fundo sem declarar a cor do texto`).toBeDefined()
      expect(contrastRatio(texto ?? '#000000', fundo), `${seletor} (${String(texto)} sobre ${fundo})`)
        .toBeGreaterThanOrEqual(AA_NORMAL)
    }
    // Se a varredura não encontrou nada, o guarda não pode falhar — e um guarda
    // que não pode falhar é o defeito que este arquivo inteiro existe para não
    // repetir.
    expect(conferidas, 'nenhuma superfície escura encontrada: a varredura parou de ver a folha').toBeGreaterThan(0)
  })

  it('respeita movimento reduzido sem depender de uma busca por string solta', () => {
    const reduced = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n?\}/u.exec(styles)
    expect(reduced).not.toBeNull()
    expect(reduced?.[1]).toContain('animation:none')
  })
})
