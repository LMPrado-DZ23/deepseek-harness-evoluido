import { describe, expect, it } from 'vitest'
import {
  callsForSession, indexBySession, teamTrace,
  type PolicyAuditShape, type TraceRunShape, type TraceTaskShape,
} from '../src/tool-trace.ts'

const ESCOPO = { orgId: 'org-a', tenantId: 'ws-a' }

function entry(over: Partial<Record<keyof PolicyAuditShape, unknown>> = {}): PolicyAuditShape {
  return {
    audit_id: 'a1', session_id: 'sessao-filha', org_id: 'org-a', tenant_id: 'ws-a',
    created_at: '2026-09-12T00:00:00.000Z', tool_name: 'shell', call_id: 'c1',
    effective_tier: 'T2', decision: 'allow', reason: 'catalogo', rule_source: 'catalog',
    seq: 1, entry_sha256: 'f'.repeat(64),
    ...over,
  } as PolicyAuditShape
}

function run(over: Partial<TraceRunShape> = {}): TraceRunShape {
  return { run_id: 'r1', org_id: 'org-a', tenant_id: 'ws-a', child_session_id: 'sessao-filha', ...over }
}

function task(over: Partial<TraceTaskShape> = {}): TraceTaskShape {
  return { task_id: 't1', title: 'Escrever o formulario', role: 'frontend', status: 'DONE', run_id: 'r1', ...over }
}

describe('a cadeia equipe -> etapa -> execucao -> ferramenta', () => {
  it('liga a etapa as chamadas dela pela sessao filha da execucao', () => {
    const chain = teamTrace('eq-1', [task()], [run()], [entry()], ESCOPO)
    expect(chain.tasks[0]!.trace.link).toBe('LINKED')
    expect(chain.tasks[0]!.trace.calls.map(call => call.tool_name)).toEqual(['shell'])
    expect(chain.unlinked_count).toBe(0)
  })

  it('etapa que NAO rodou e diferente de etapa sem elo', () => {
    // Colapsar os dois num "sem chamadas" descreveria como limpo o caso em que
    // a vigilancia falhou.
    const chain = teamTrace('eq-1', [
      task({ task_id: 'parada', run_id: null }),
      task({ task_id: 'sem-elo', run_id: 'r9' }),
    ], [run({ run_id: 'r9', child_session_id: null })], [entry()], ESCOPO)
    expect(chain.tasks.map(row => row.trace.link)).toEqual(['NOT_EXECUTED', 'UNLINKED'])
    expect(chain.unlinked_count).toBe(1)
  })

  it('sessao filha VAZIA conta como sem elo, e nao como elo para sessao vazia', () => {
    // String vazia passa por `?? undefined` e viraria uma busca por sessao ''
    // — que casa com nada e desenharia "nenhuma ferramenta usada".
    const chain = teamTrace('eq-1', [task()], [run({ child_session_id: '' })], [entry()], ESCOPO)
    expect(chain.tasks[0]!.trace.link).toBe('UNLINKED')
    expect(chain.unlinked_count).toBe(1)
  })

  it('execucao DESCONHECIDA tambem e sem elo, e nao some da lista', () => {
    const chain = teamTrace('eq-1', [task({ run_id: 'r-que-sumiu' })], [], [entry()], ESCOPO)
    expect(chain.tasks).toHaveLength(1)
    expect(chain.tasks[0]!.trace.link).toBe('UNLINKED')
  })

  it('elo existente com ZERO chamadas continua sendo elo, e a lista vazia significa mesmo vazia', () => {
    const chain = teamTrace('eq-1', [task()], [run()], [], ESCOPO)
    expect(chain.tasks[0]!.trace.link).toBe('LINKED')
    expect(chain.tasks[0]!.trace.calls).toEqual([])
    expect(chain.unlinked_count).toBe(0)
  })

  it('a contagem de sem-elo sai POR FORA, e nao so dentro de cada etapa', () => {
    // Quem percorre dez etapas nao soma isso de cabeca.
    const chain = teamTrace('eq-1', [
      task({ task_id: 'a', run_id: 'ra' }), task({ task_id: 'b', run_id: 'rb' }), task({ task_id: 'c', run_id: 'rc' }),
    ], [run({ run_id: 'ra' }), run({ run_id: 'rb', child_session_id: null })], [entry()], ESCOPO)
    expect(chain.unlinked_count).toBe(2)
  })
})

describe('o escopo atravessa a cadeia inteira', () => {
  it('a trilha de OUTRO inquilino nao aparece, mesmo com a mesma sessao', () => {
    const chain = teamTrace('eq-1', [task()], [run()], [
      entry({ audit_id: 'meu', tool_name: 'shell' }),
      entry({ audit_id: 'alheio', org_id: 'org-b', tenant_id: 'ws-b', tool_name: 'SEGREDO' }),
    ], ESCOPO)
    expect(chain.tasks[0]!.trace.calls.map(call => call.tool_name)).toEqual(['shell'])
  })

  it('a EXECUCAO de outro escopo nao empresta a sessao dela', () => {
    // Sem isto, o identificador da execucao seria suficiente para alcancar a
    // sessao de outro inquilino, e a trilha dele apareceria nesta tela.
    const chain = teamTrace('eq-1', [task()], [
      run({ org_id: 'org-b', tenant_id: 'ws-b', child_session_id: 'sessao-alheia' }),
    ], [entry({ session_id: 'sessao-alheia', org_id: 'org-b', tenant_id: 'ws-b' })], ESCOPO)
    expect(chain.tasks[0]!.trace.link).toBe('UNLINKED')
  })
})

describe('a ordem conta a historia na ordem em que aconteceu', () => {
  it('ordena pela posicao da corrente, e nao pela ordem de leitura', () => {
    // Uma recusa antes do pedido que a provocou e uma historia ao contrario.
    const calls = callsForSession([
      entry({ audit_id: 'c', call_id: 'terceira', seq: 30 }),
      entry({ audit_id: 'a', call_id: 'primeira', seq: 10 }),
      entry({ audit_id: 'b', call_id: 'segunda', seq: 20 }),
    ], ESCOPO, 'sessao-filha')
    expect(calls.map(call => call.call_id)).toEqual(['primeira', 'segunda', 'terceira'])
  })

  it('sem posicao, cai para a data — e o empate de data tem desempate ESTAVEL', () => {
    // Duas entradas com o mesmo carimbo trocariam de lugar entre leituras, e a
    // tela piscaria sem nada ter mudado.
    const mesmos = [
      entry({ audit_id: 'zz', call_id: 'z', seq: undefined }),
      entry({ audit_id: 'aa', call_id: 'a', seq: undefined }),
    ]
    const primeira = callsForSession(mesmos, ESCOPO, 'sessao-filha').map(call => call.call_id)
    const segunda = callsForSession([...mesmos].reverse(), ESCOPO, 'sessao-filha').map(call => call.call_id)
    expect(primeira).toEqual(['a', 'z'])
    expect(primeira).toEqual(segunda)
  })

  it('posicao 0 e uma posicao de verdade, e nao ausencia', () => {
    const calls = callsForSession([
      entry({ audit_id: 'b', call_id: 'depois', seq: 1 }),
      entry({ audit_id: 'a', call_id: 'primeira', seq: 0 }),
    ], ESCOPO, 'sessao-filha')
    expect(calls.map(call => call.call_id)).toEqual(['primeira', 'depois'])
  })
})

describe('uma entrada sem selo e reportada como nao selada', () => {
  it('o selo presente e ausente viram `sealed` verdadeiro e falso', () => {
    // Omitir a distincao faria uma linha inauditavel parecer auditada.
    const calls = callsForSession([
      entry({ audit_id: 'velha', call_id: 'antiga', seq: 0, entry_sha256: undefined }),
      entry({ audit_id: 'nova', call_id: 'recente', seq: 1 }),
    ], ESCOPO, 'sessao-filha')
    expect(calls.map(call => [call.call_id, call.sealed])).toEqual([['antiga', false], ['recente', true]])
  })
})

describe('a decisao da politica chega inteira', () => {
  it('recusa, pergunta e permissao sao TRES coisas, e o motivo vem junto', () => {
    // Colapsar `ask` em `deny` faria a tela dizer que algo foi recusado quando
    // na verdade estava esperando alguem responder.
    const calls = callsForSession([
      entry({ audit_id: 'a', call_id: 'x', seq: 0, decision: 'allow', reason: 'catalogo T1' }),
      entry({ audit_id: 'b', call_id: 'y', seq: 1, decision: 'ask', reason: 'exige confirmacao' }),
      entry({ audit_id: 'c', call_id: 'z', seq: 2, decision: 'deny', reason: 'fora do catalogo' }),
    ], ESCOPO, 'sessao-filha')
    expect(calls.map(call => call.decision)).toEqual(['allow', 'ask', 'deny'])
    expect(calls.map(call => call.reason)).toEqual(['catalogo T1', 'exige confirmacao', 'fora do catalogo'])
  })
})

describe('a trilha e varrida UMA vez por leitura, e nao uma por etapa', () => {
  it('dez etapas nao viram dez varreduras', () => {
    // Com dez etapas e uma trilha de cem mil entradas, uma varredura por etapa
    // e um milhao de comparacoes para desenhar uma tela — e a trilha e
    // justamente a coisa que cresce com o uso.
    let lidas = 0
    // O contador pega QUALQUER travessia, e nao so `for...of`: `filter`,
    // `map`, `slice` e `some` tambem percorrem, e um contador que so visse o
    // laco deixaria passar exatamente a volta ao filtro por etapa.
    const TRAVESSIAS = new Set<string | symbol>([
      Symbol.iterator, 'filter', 'map', 'slice', 'forEach', 'some', 'every', 'reduce', 'find',
    ])
    const trilha = new Proxy([entry()] as PolicyAuditShape[], {
      get(alvo, chave, receptor) {
        if (TRAVESSIAS.has(chave)) lidas += 1
        return Reflect.get(alvo, chave, receptor) as unknown
      },
    })
    const etapas = Array.from({ length: 10 }, (_, index) => task({ task_id: `t${String(index)}`, run_id: `r${String(index)}` }))
    const execucoes = etapas.map((_, index) => run({ run_id: `r${String(index)}`, child_session_id: 'sessao-filha' }))
    const chain = teamTrace('eq-1', etapas, execucoes, trilha, ESCOPO)
    expect(chain.tasks.every(row => row.trace.calls.length === 1)).toBe(true)
    expect(lidas, 'a trilha foi percorrida mais de uma vez').toBe(1)
  })

  it('o indice ja sai no escopo e ja sai em ordem', () => {
    const indice = indexBySession([
      entry({ audit_id: 'b', call_id: 'segunda', seq: 20 }),
      entry({ audit_id: 'a', call_id: 'primeira', seq: 10 }),
      entry({ audit_id: 'x', session_id: 'outra-sessao', call_id: 'de-outra', seq: 5 }),
      entry({ audit_id: 'z', org_id: 'org-b', tenant_id: 'ws-b', call_id: 'alheia', seq: 1 }),
    ], ESCOPO)
    expect(indice.get('sessao-filha')?.map(call => call.call_id)).toEqual(['primeira', 'segunda'])
    expect(indice.get('outra-sessao')?.map(call => call.call_id)).toEqual(['de-outra'])
    // A entrada do outro inquilino nao chega a existir num balde.
    expect([...indice.values()].flat().map(call => call.call_id)).not.toContain('alheia')
  })

  it('sessao sem nenhuma entrada nao aparece no indice, e a etapa recebe lista vazia', () => {
    const indice = indexBySession([entry()], ESCOPO)
    expect(indice.has('sessao-que-nunca-chamou-nada')).toBe(false)
    const chain = teamTrace('eq-1', [task()], [run({ child_session_id: 'sessao-que-nunca-chamou-nada' })], [entry()], ESCOPO)
    expect(chain.tasks[0]!.trace.link).toBe('LINKED')
    expect(chain.tasks[0]!.trace.calls).toEqual([])
  })
})
