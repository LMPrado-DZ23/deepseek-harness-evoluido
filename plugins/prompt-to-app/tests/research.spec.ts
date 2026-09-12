import { describe, expect, it } from 'vitest'
import { assembleContext } from '../src/context.ts'
import {
  RESEARCH_MAX_AGE_DAYS, contentDigest, normalizeForQuote, refusalFor, researchSections, screenNotes,
  type ResearchNote,
} from '../src/research.ts'

const CONTEUDO = 'A biblioteca abre de segunda a sexta, das 9h as 18h. Aos sabados, das 9h as 13h.'
const AGORA = new Date('2026-09-12T12:00:00.000Z')

function nota(over: Partial<ResearchNote> = {}): ResearchNote {
  return {
    note_id: 'n1', claim: 'A biblioteca abre aos sabados de manha.',
    excerpt: 'Aos sabados, das 9h as 13h.',
    source_url: 'https://exemplo.test/biblioteca',
    retrieved_at: '2026-09-10T12:00:00.000Z',
    content_sha256: contentDigest(CONTEUDO),
    ...over,
  }
}

const janela = { now: AGORA }

describe('uma nota so se sustenta com o trecho LITERAL da fonte', () => {
  it('nota inteira, com trecho que esta la, passa', () => {
    expect(refusalFor(nota(), CONTEUDO, janela)).toBeUndefined()
  })

  it('trecho que NAO esta no conteudo e recusado', () => {
    // O modo de falhar nao e o modelo mentir de proposito: e ele PARAFRASEAR
    // uma fonte real ate a frase deixar de estar la.
    expect(refusalFor(nota({ excerpt: 'Aos sabados, o dia inteiro.' }), CONTEUDO, janela)).toBe('EXCERPT_NOT_FOUND')
  })

  it('trecho PARECIDO nao basta: a conferencia e literal', () => {
    // Nao parecido, nao equivalente — aparecer. E a unica verificacao que uma
    // maquina consegue fazer sobre uma citacao.
    expect(refusalFor(nota({ excerpt: 'aos sábados das 9 as 13' }), CONTEUDO, janela)).toBe('EXCERPT_NOT_FOUND')
  })

  it('quebra de linha e indentacao NAO separam o trecho da fonte', () => {
    // Uma pagina reformatada nao muda uma palavra.
    const reformatado = 'A biblioteca abre de segunda a sexta, das 9h as 18h.\n   Aos sabados,\n   das 9h as 13h.'
    expect(refusalFor(
      nota({ excerpt: 'Aos sabados, das 9h as 13h.', content_sha256: contentDigest(reformatado) }),
      reformatado, janela,
    )).toBeUndefined()
  })

  it('acento e caixa CONTINUAM contando', () => {
    // "nao" e "não" sao palavras diferentes, e um trecho que so casa depois de
    // tirar o acento nao e o trecho que esta la.
    expect(normalizeForQuote('  a   b \n c ')).toBe('a b c')
    expect(normalizeForQuote('não')).toBe('não')
  })
})

describe('a nota precisa dos tres: afirmacao, trecho e fonte', () => {
  it('sem afirmacao, sem trecho ou sem fonte, e recusada — com motivos DIFERENTES', () => {
    expect(refusalFor(nota({ claim: '   ' }), CONTEUDO, janela)).toBe('NO_CLAIM')
    expect(refusalFor(nota({ excerpt: '' }), CONTEUDO, janela)).toBe('NO_EXCERPT')
    expect(refusalFor(nota({ source_url: '' }), CONTEUDO, janela)).toBe('NO_SOURCE')
  })

  it('a falta de campo vem ANTES da conferencia de conteudo', () => {
    // Dizer EXCERPT_NOT_FOUND para uma nota sem trecho culparia a fonte por um
    // defeito da nota.
    expect(refusalFor(nota({ excerpt: '' }), 'conteudo que nao casa com nada', janela)).toBe('NO_EXCERPT')
  })

  it('endereco que nao e http(s) nao e fonte', () => {
    // `file:` apontaria para o disco de quem hospeda, e um esquema inventado
    // nao e endereco que alguem consiga abrir para conferir.
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'exemplo.test', 'ftp://x/y']) {
      expect(refusalFor(nota({ source_url: url }), CONTEUDO, janela), url).toBe('NO_SOURCE')
    }
  })
})

describe('o conteudo relido tem de ser o MESMO', () => {
  it('conteudo que mudou desde a leitura e recusado', () => {
    expect(refusalFor(nota(), `${CONTEUDO} Fechado em feriados.`, janela)).toBe('CONTENT_CHANGED')
  })

  it('NAO conseguir reler a fonte NAO e a fonte confirmar', () => {
    // Tratar as duas igual e como uma citacao inventada atravessa.
    expect(refusalFor(nota(), undefined, janela)).toBe('CONTENT_CHANGED')
  })
})

describe('uma nota velha nao e afirmada como presente', () => {
  it('nota fora da validade e recusada', () => {
    // Preco, horario, endereco e disponibilidade mudam, e uma nota de meio ano
    // atras tem procedencia e por isso convence.
    expect(refusalFor(nota({ retrieved_at: '2026-01-01T12:00:00.000Z' }), CONTEUDO, janela)).toBe('EXPIRED')
  })

  it('a validade e de quem pergunta', () => {
    const velha = nota({ retrieved_at: '2026-08-01T12:00:00.000Z' })
    expect(refusalFor(velha, CONTEUDO, { now: AGORA, maxAgeDays: 90 })).toBeUndefined()
    expect(refusalFor(velha, CONTEUDO, { now: AGORA, maxAgeDays: 7 })).toBe('EXPIRED')
  })

  it('data ILEGIVEL conta como vencida, e nao como recente', () => {
    // Uma nota cuja data ninguem consegue ler nao pode ser afirmada como atual.
    expect(refusalFor(nota({ retrieved_at: 'ontem' }), CONTEUDO, janela)).toBe('EXPIRED')
  })

  it('a validade padrao e a declarada, e nao um numero solto', () => {
    const noLimite = new Date(AGORA.getTime() - (RESEARCH_MAX_AGE_DAYS - 1) * 24 * 60 * 60 * 1000)
    const passada = new Date(AGORA.getTime() - (RESEARCH_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000)
    expect(refusalFor(nota({ retrieved_at: noLimite.toISOString() }), CONTEUDO, janela)).toBeUndefined()
    expect(refusalFor(nota({ retrieved_at: passada.toISOString() }), CONTEUDO, janela)).toBe('EXPIRED')
  })
})

describe('a triagem e POR NOTA', () => {
  it('uma nota que nao se sustenta nao derruba as outras', () => {
    const saida = screenNotes([
      nota({ note_id: 'boa' }),
      nota({ note_id: 'inventada', excerpt: 'Aberta 24 horas.' }),
    ], () => CONTEUDO, janela)
    expect(saida.accepted.map(item => item.note_id)).toEqual(['boa'])
    expect(saida.refused).toEqual([{ note_id: 'inventada', reason: 'EXCERPT_NOT_FOUND' }])
  })

  it('cada nota e conferida contra a PROPRIA fonte', () => {
    // Conferir todas contra o mesmo conteudo faria a nota de uma fonte passar
    // por causa do texto de outra.
    const outro = 'Outra pagina inteiramente diferente.'
    const saida = screenNotes([
      nota({ note_id: 'a' }),
      nota({ note_id: 'b', source_url: 'https://exemplo.test/outra', content_sha256: contentDigest(outro) }),
    ], url => url.endsWith('/outra') ? outro : CONTEUDO, janela)
    expect(saida.accepted.map(item => item.note_id)).toEqual(['a'])
    expect(saida.refused).toEqual([{ note_id: 'b', reason: 'EXCERPT_NOT_FOUND' }])
  })
})

describe('a nota aceita chega ao contexto com procedencia', () => {
  it('entra como EVIDENCIA, e nao como instrucao', () => {
    // Uma nota e material sobre o qual o modelo raciocina: ela PODE ser
    // cortada pelo teto sem mudar nenhuma regra.
    expect(researchSections([nota()])[0]!.kind).toBe('evidence')
  })

  it('a procedencia leva o endereco E a data', () => {
    // Sem a data, quem for conferir depois nao sabe contra qual versao da
    // pagina a frase foi escrita.
    const secao = researchSections([nota()])[0]!
    expect(secao.source).toBe('https://exemplo.test/biblioteca (2026-09-10T12:00:00.000Z)')
  })

  it('o TRECHO literal vai junto da afirmacao', () => {
    const secao = researchSections([nota()])[0]!
    expect(secao.text).toContain('A biblioteca abre aos sabados de manha.')
    expect(secao.text).toContain('Aos sabados, das 9h as 13h.')
    expect(secao.text).toContain('https://exemplo.test/biblioteca')
  })

  it('a procedencia atravessa o motor de contexto', () => {
    const montado = assembleContext([
      { id: 'base', kind: 'instruction', priority: 0, text: 'instrucao', source: 'studio' },
      ...researchSections([nota()]),
    ], { budgetChars: 10_000 })
    const linha = montado.ledger.included.find(item => item.id === 'research:n1')
    expect(linha?.source).toContain('https://exemplo.test/biblioteca')
  })

  it('a nota perde para o pedido da pessoa quando o teto aperta', () => {
    // O que a pessoa pediu vem antes do que o Studio descobriu.
    const pedido = { id: 'pedido', kind: 'evidence' as const, priority: 100, text: 'x'.repeat(200), source: 'pessoa' }
    const montado = assembleContext([
      { id: 'base', kind: 'instruction' as const, priority: 0, text: 'i', source: 'studio' },
      pedido, ...researchSections([nota()]),
    ], { budgetChars: 240 })
    expect(montado.ledger.included.map(item => item.id)).toContain('pedido')
    expect(montado.ledger.dropped.map(item => item.id)).toContain('research:n1')
  })
})
