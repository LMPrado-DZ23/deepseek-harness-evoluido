import { describe, expect, it } from 'vitest'

import {
  type AttemptOutcome,
  convergenceOf,
  countFindings,
  outputDigest,
  repeatingReason,
  shouldStopEarly,
} from '../src/convergence.js'

function attempt(n: number, diagnostic: string, files: readonly { path: string; content: string }[] = []): AttemptOutcome {
  return { attempt: n, stage: 'verify', diagnostic, files }
}

describe('outputDigest', () => {
  it('a ordem em que os arquivos saem do gerador nao muda a impressao', () => {
    const a = outputDigest([{ path: 'b.ts', content: 'dois' }, { path: 'a.ts', content: 'um' }])
    const b = outputDigest([{ path: 'a.ts', content: 'um' }, { path: 'b.ts', content: 'dois' }])
    expect(a).toBe(b)
  })

  it('o mesmo conteudo em caminho diferente e outro programa', () => {
    const a = outputDigest([{ path: 'src/a.ts', content: 'igual' }])
    const b = outputDigest([{ path: 'src/b.ts', content: 'igual' }])
    expect(a).not.toBe(b)
  })

  it('o conteudo conta: mesmo caminho com texto diferente muda a impressao', () => {
    const a = outputDigest([{ path: 'a.ts', content: 'um' }])
    const b = outputDigest([{ path: 'a.ts', content: 'dois' }])
    expect(a).not.toBe(b)
  })

  it('a fronteira entre caminho e conteudo nao se confunde', () => {
    // Sem o tamanho de cada pedaco na impressao, 'ab'+'c' e 'a'+'bc' colidiriam.
    const a = outputDigest([{ path: 'ab', content: 'c' }])
    const b = outputDigest([{ path: 'a', content: 'bc' }])
    expect(a).not.toBe(b)
  })

  it('um arquivo a mais muda a impressao', () => {
    const a = outputDigest([{ path: 'a.ts', content: 'um' }])
    const b = outputDigest([{ path: 'a.ts', content: 'um' }, { path: 'b.ts', content: '' }])
    expect(a).not.toBe(b)
  })

  it('nenhum arquivo tem impressao propria e estavel', () => {
    expect(outputDigest([])).toBe(outputDigest([]))
    expect(outputDigest([])).not.toBe(outputDigest([{ path: 'a', content: '' }]))
  })

  it('a impressao nao vaza o conteudo', () => {
    const digest = outputDigest([{ path: 'segredo.ts', content: 'const chave = "abc123"' }])
    expect(digest).not.toContain('abc123')
    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
  })
})

describe('countFindings', () => {
  it('conta os achados unidos por ponto e virgula', () => {
    expect(countFindings('um; dois; tres')).toBe(3)
  })

  it('um diagnostico que nao e lista conta como UM', () => {
    // Contar zero faria qualquer falha parecer melhora em relacao a anterior.
    expect(countFindings('a compilacao falhou')).toBe(1)
  })

  it('separador sobrando nao inventa achado', () => {
    expect(countFindings('um;; dois;')).toBe(2)
  })

  it('diagnostico vazio conta zero', () => {
    expect(countFindings('')).toBe(0)
    expect(countFindings('   ')).toBe(0)
  })
})

describe('convergenceOf', () => {
  it('a primeira tentativa nao tem com que comparar', () => {
    expect(convergenceOf([attempt(1, 'falhou')])).toEqual({ state: 'FIRST' })
    expect(convergenceOf([])).toEqual({ state: 'FIRST' })
  })

  it('mesmo diagnostico E mesmo codigo e REPETICAO, e nomeia qual tentativa', () => {
    const files = [{ path: 'a.ts', content: 'igual' }]
    const verdict = convergenceOf([attempt(1, 'x', files), attempt(2, 'x', files)])
    expect(verdict).toEqual({ state: 'REPEATING', sameAs: 1 })
  })

  it('a repeticao e conferida contra QUALQUER tentativa anterior, nao so a vizinha', () => {
    // A -> B -> A e um ciclo. Olhar so para a vizinha o deixaria passar.
    const a = [{ path: 'a.ts', content: 'A' }]
    const b = [{ path: 'a.ts', content: 'B' }]
    const verdict = convergenceOf([attempt(1, 'x', a), attempt(2, 'y', b), attempt(3, 'x', a)])
    expect(verdict).toEqual({ state: 'REPEATING', sameAs: 1 })
  })

  it('mesmo codigo com diagnostico diferente NAO e repeticao', () => {
    // O mesmo codigo pode falhar de outro jeito: teste instavel, etapa
    // diferente. Chamar isso de repeticao pararia uma criacao que andou.
    const files = [{ path: 'a.ts', content: 'igual' }]
    const verdict = convergenceOf([attempt(1, 'um; dois', files), attempt(2, 'tres', files)])
    expect(verdict.state).not.toBe('REPEATING')
  })

  it('mesmo diagnostico com codigo diferente NAO e repeticao: e tentativa travada', () => {
    const verdict = convergenceOf([
      attempt(1, 'x', [{ path: 'a.ts', content: 'A' }]),
      attempt(2, 'x', [{ path: 'a.ts', content: 'B' }]),
    ])
    expect(verdict).toEqual({ state: 'STALLED', occasions: 2 })
  })

  it('o diagnostico e comparado LITERALMENTE: um numero de linha diferente e outra falha', () => {
    const files = [{ path: 'a.ts', content: 'igual' }]
    const verdict = convergenceOf([attempt(1, 'erro na linha 4', files), attempt(2, 'erro na linha 9', files)])
    expect(verdict.state).not.toBe('REPEATING')
  })

  it('achados que DIMINUEM sao convergencia, com os dois numeros ditos', () => {
    const verdict = convergenceOf([
      attempt(1, 'um; dois; tres', [{ path: 'a.ts', content: 'A' }]),
      attempt(2, 'um; dois', [{ path: 'a.ts', content: 'B' }]),
    ])
    expect(verdict).toEqual({ state: 'CONVERGING', previous: 3, current: 2 })
  })

  it('mesma QUANTIDADE de achados nao e convergencia', () => {
    // Trocar tres defeitos por outros tres nao e progresso.
    const verdict = convergenceOf([
      attempt(1, 'um; dois; tres', [{ path: 'a.ts', content: 'A' }]),
      attempt(2, 'quatro; cinco; seis', [{ path: 'a.ts', content: 'B' }]),
    ])
    expect(verdict).toEqual({ state: 'STALLED', occasions: 1 })
  })

  it('achados que AUMENTAM nao sao convergencia', () => {
    const verdict = convergenceOf([
      attempt(1, 'um', [{ path: 'a.ts', content: 'A' }]),
      attempt(2, 'um; dois', [{ path: 'a.ts', content: 'B' }]),
    ])
    expect(verdict.state).toBe('STALLED')
  })

  it('as ocasioes contam a sequencia inteira, e nao so as duas ultimas', () => {
    const verdict = convergenceOf([
      attempt(1, 'x', [{ path: 'a.ts', content: 'A' }]),
      attempt(2, 'x', [{ path: 'a.ts', content: 'B' }]),
      attempt(3, 'x', [{ path: 'a.ts', content: 'C' }]),
    ])
    expect(verdict).toEqual({ state: 'STALLED', occasions: 3 })
  })

  it('tentativa sem saida observada nao entra na comparacao — nem para bater, nem para explodir', () => {
    // A tentativa 1 lancou antes de escrever qualquer coisa. A 3 repete a 2.
    // Percorrer a 1 como se ela tivesse arquivos seria comparar com o nada.
    const verdict = convergenceOf([
      { attempt: 1, stage: 'generate', diagnostic: 'x' },
      attempt(2, 'y', [{ path: 'a.ts', content: 'A' }]),
      attempt(3, 'y', [{ path: 'a.ts', content: 'A' }]),
    ])
    expect(verdict).toEqual({ state: 'REPEATING', sameAs: 2 })
  })

  it('tentativa sem saida observada com o MESMO diagnostico nao vira repeticao', () => {
    // O caso que separa a guarda do curto-circuito do `&&`: aqui o diagnostico
    // BATE, entao so a guarda impede comparar a impressao de um nada.
    const verdict = convergenceOf([
      { attempt: 1, stage: 'generate', diagnostic: 'a mesma falha' },
      attempt(2, 'a mesma falha', [{ path: 'a.ts', content: 'A' }]),
    ])
    expect(verdict).toEqual({ state: 'STALLED', occasions: 2 })
  })

  it('duas tentativas sem saida observada NAO sao repeticao', () => {
    // Duas recusas do gerador nao dizem se ele tentou a mesma coisa ou outra.
    const verdict = convergenceOf([
      { attempt: 1, stage: 'generate', diagnostic: 'JSON invalido' },
      { attempt: 2, stage: 'generate', diagnostic: 'JSON invalido' },
    ])
    expect(verdict.state).not.toBe('REPEATING')
  })

  it('o veredito e sempre da tentativa MAIS RECENTE', () => {
    const verdict = convergenceOf([
      attempt(1, 'x', [{ path: 'a.ts', content: 'A' }]),
      attempt(2, 'x', [{ path: 'a.ts', content: 'A' }]),
      attempt(3, 'z', [{ path: 'a.ts', content: 'C' }]),
    ])
    // A repeticao esta no passado; a ultima tentativa e nova.
    expect(verdict.state).not.toBe('REPEATING')
  })
})

describe('shouldStopEarly', () => {
  it('so a repeticao para o laco', () => {
    expect(shouldStopEarly({ state: 'REPEATING', sameAs: 1 })).toBe(true)
  })

  it('tentativa travada NAO para o laco', () => {
    // Parar aqui transformaria dificuldade em impossibilidade — e a terceira
    // tentativa existe exatamente para a dificuldade.
    expect(shouldStopEarly({ state: 'STALLED', occasions: 2 })).toBe(false)
  })

  it('convergencia e primeira tentativa nao param o laco', () => {
    expect(shouldStopEarly({ state: 'CONVERGING', previous: 3, current: 1 })).toBe(false)
    expect(shouldStopEarly({ state: 'FIRST' })).toBe(false)
  })
})

describe('repeatingReason', () => {
  it('a repeticao explica a pessoa e nomeia a tentativa igual', () => {
    const reason = repeatingReason({ state: 'REPEATING', sameAs: 2 })
    expect(reason).toBeDefined()
    expect(reason).toContain('2')
  })

  it('a frase NAO afirma que a proxima tentativa falharia', () => {
    // O gerador nao e deterministico. A afirmacao honesta e sobre o passado e
    // sobre o orcamento, nunca sobre o futuro.
    const reason = repeatingReason({ state: 'REPEATING', sameAs: 1 }) ?? ''
    expect(reason).not.toMatch(/vai falhar|falhara|não funciona|nao funciona|impossível|impossivel/iu)
  })

  it('os outros vereditos nao tem frase de parada', () => {
    expect(repeatingReason({ state: 'STALLED', occasions: 3 })).toBeUndefined()
    expect(repeatingReason({ state: 'CONVERGING', previous: 2, current: 1 })).toBeUndefined()
    expect(repeatingReason({ state: 'FIRST' })).toBeUndefined()
  })
})
