import { describe, expect, it } from 'vitest'
import type { ContextLedger } from '../src/context.ts'
import { consultedView, labelFor, skillRefusalLabel } from '../src/plan-consulted.ts'
import type { PlannerSkillReport } from '../src/planner.ts'

function ledger(over: Partial<ContextLedger> = {}): ContextLedger {
  return {
    included: [
      { id: 'plan.only', kind: 'instruction', source: 'studio', chars: 10 },
      { id: 'plan.spec', kind: 'evidence', source: 'app-spec', chars: 100 },
      { id: 'plan.schema', kind: 'schema', source: 'planOutputSchema', chars: 500 },
    ],
    dropped: [], chars: 610, budget: 24_000, ...over,
  }
}

describe('o que a pessoa LE sobre o que o Studio consultou', () => {
  it('o identificador interno NUNCA aparece', () => {
    // Ele e nome de variavel, e mostra-lo troca uma explicacao por um enigma.
    const view = consultedView(ledger(), undefined, false)
    const texto = JSON.stringify(view.used.map(item => item.label))
    for (const id of ['plan.spec', 'plan.only', 'skill:', 'research:']) {
      expect(texto, id).not.toContain(id)
    }
  })

  it('o formato da resposta NAO entra na lista', () => {
    // O esquema e mecanica interna: mostra-lo encheria a lista com linhas que
    // nao dizem nada a quem le.
    const view = consultedView(ledger(), undefined, false)
    expect(view.used).toHaveLength(2)
  })

  it('cada tipo de parte tem frase PROPRIA', () => {
    // Uma frase so para tudo faria "o que voce descreveu" e "uma instrucao de
    // terceiro" parecerem a mesma coisa.
    const frases = ['plan.spec', 'plan.code', 'plan.change', 'skill:x', 'research:y']
      .map(id => labelFor(id, 'origem'))
    expect(new Set(frases).size).toBe(5)
  })

  it('o que NAO COUBE aparece, com a mesma linguagem', () => {
    // Um plano montado sobre contexto truncado e um plano montado sobre menos
    // do que a pessoa disse — e sem esta lista ele se parece com um plano
    // montado sobre tudo.
    const view = consultedView(ledger({
      dropped: [{ id: 'plan.spec', source: 'app-spec', chars: 100, reason: 'BUDGET' }],
    }), undefined, false)
    expect(view.dropped).toHaveLength(1)
    expect(view.dropped[0]!.label).toBe(labelFor('plan.spec', 'app-spec'))
  })

  it('coube tudo devolve lista de descartados VAZIA', () => {
    expect(consultedView(ledger(), undefined, false).dropped).toEqual([])
  })
})

describe('as habilidades recusadas, e as que simplesmente nao tinham a ver', () => {
  function relatorio(over: Partial<PlannerSkillReport> = {}): PlannerSkillReport {
    return {
      selection: { chosen: [], skipped: [], declared_chars: 0 },
      refused: [], loaded: [], ...over,
    }
  }

  it('habilidade que NAO TEM A VER com o pedido nao vira problema', () => {
    // Lista-la faria toda tela ter uma lista de "problemas" que nao sao
    // problema nenhum.
    const view = consultedView(ledger(), relatorio({
      selection: { chosen: [], skipped: [{ skill_id: 'x', reason: 'NO_MATCH' }, { skill_id: 'y', reason: 'DUPLICATE' }], declared_chars: 0 },
    }), false)
    expect(view.refusedSkills).toEqual([])
  })

  it('desligada, grande demais e sem espaco sao TRES frases diferentes', () => {
    // As tres mandam a pessoa fazer coisas diferentes: uma pede ligar, outra
    // pede uma habilidade menor, a terceira pede um pedido menor.
    const frases = ['DISABLED', 'OVERSIZED', 'BUDGET'].map(reason => skillRefusalLabel(reason, 'formularios'))
    expect(new Set(frases).size).toBe(3)
    // E as tres dizem QUAL habilidade: sem o nome, tres recusas viram tres
    // linhas identicas e a pessoa nao tem como saber qual ligar.
    for (const frase of frases) expect(frase).toContain('formularios')
  })

  it('texto que nao bate com o declarado tem frase propria, e ela e sobre a HABILIDADE', () => {
    const frase = skillRefusalLabel('SIZE_MISMATCH', 'formularios')
    // A frase antiga soava como incompatibilidade de versao. `SIZE_MISMATCH` e
    // o registro ter descrito uma coisa e entregue outra — a forma de um pacote
    // passar instrucao que ninguem aprovou.
    expect(frase).toContain('pode ter sido alterada depois de instalada')
  })

  it('recusa de ESCOLHA e recusa de CARGA aparecem juntas', () => {
    const view = consultedView(ledger(), relatorio({
      selection: { chosen: [], skipped: [{ skill_id: 'desligada', reason: 'DISABLED' }], declared_chars: 0 },
      refused: [{ skill_id: 'mentiu', reason: 'SIZE_MISMATCH', declared: 10, actual: 20 }],
    }), false)
    expect(view.refusedSkills.map(item => item.source)).toEqual(['desligada', 'mentiu'])
  })

  it('sem habilidades, nao ha recusa nenhuma', () => {
    expect(consultedView(ledger(), undefined, false).refusedSkills).toEqual([])
  })
})

describe('o inventario incompleto e DITO', () => {
  it('a incompletude chega como FATO, e nao como palavra dentro de um texto', () => {
    // A primeira versao procurava a substring `INCOMPLETA` no resumo — e esse
    // texto vem do CATALOGO DE TRADUCAO. Traduzir o produto apagaria o aviso em
    // silencio, e a pessoa aprovaria um plano montado sobre codigo que ninguem
    // leu inteiro. Falha do lado errado, achada pela revisao adversarial.
    expect(consultedView(ledger(), undefined, true).incompleteCode).toBe(true)
    expect(consultedView(ledger(), undefined, false).incompleteCode).toBe(false)
  })
})

describe('sem registro de contexto, nao ha o que contar', () => {
  it('devolve tudo vazio, e nao inventa uma lista', () => {
    expect(consultedView(undefined, undefined, false))
      .toEqual({ used: [], dropped: [], refusedSkills: [], incompleteCode: false })
  })
})
