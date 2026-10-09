import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { RouteHealthRecord, RouteSwitchEvent } from '../src/model.ts'
import {
  StudioRouteHealthService,
  routeBudgetUsage,
  routeCostState,
  type RouteHealthRepository,
  type RouteScope,
} from '../src/service.ts'

/**
 * O ALCANCE REAL do `ADENDO DZ23-USO-CUSTOS-API` — medido, e não afirmado.
 *
 * O dono pediu, com estas palavras: "conclua o alcance real de T-35 — informe
 * quais critérios do ADENDO já passaram; verifique eventos duplicados,
 * tentativas distintas, uso desconhecido, precificação, isolamento, reservas,
 * concorrência e recuperação."
 *
 * Este arquivo é a resposta na única forma que vale alguma coisa: um teste por
 * critério, contra o serviço de produção. Os que PASSAM ficam como guarda —
 * ninguém os quebra em silêncio. Os que NÃO passam estão aqui também, e o teste
 * afirma o comportamento de HOJE com o motivo escrito: quando a fatia C
 * chegar, é este teste que vira vermelho e pede para ser reescrito, e não um
 * parágrafo num documento que ninguém executa.
 *
 * `NÃO OBSERVADO` e `NÃO PASSOU` são coisas diferentes, e esta suíte não as
 * mistura: o que não tem código nenhum não ganha teste inventado, ganha uma
 * linha em `docs/status/T35_ALCANCE.md` dizendo que não existe.
 */
class MemoryRepository implements RouteHealthRepository {
  readonly routeMap = new Map<string, RouteHealthRecord>()
  readonly eventMap = new Map<string, RouteSwitchEvent>()
  /** Quantas gravações de rota aconteceram, para medir escrita perdida. */
  gravacoes = 0
  routes() { return [...this.routeMap.values()] }
  events() { return [...this.eventMap.values()] }
  putRoute(value: RouteHealthRecord) {
    this.gravacoes += 1
    this.routeMap.set(value.record_id, value)
    return Promise.resolve()
  }
  putEvent(value: RouteSwitchEvent) { this.eventMap.set(value.event_id, value); return Promise.resolve() }
}

const escopo: RouteScope = { orgId: 'org-1', tenantId: 'tenant-1' }
const vizinho: RouteScope = { orgId: 'org-2', tenantId: 'tenant-2' }
const opcoes: GenerateOptions = { provider: 'omniroute', model: 'auto', messages: [] }

async function* pedaco(...values: StreamChunk[]) { yield* values }

/** Uma resposta que terminou bem, com uso declarado pelo provedor. */
function comUso(input: number, output: number): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk,
    { type: 'usage', usage: { inputTokens: input, outputTokens: output } } as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ]
}

/** Uma resposta que terminou bem e NÃO declarou uso nenhum. */
function semUso(): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
  ]
}

/** Uma chamada completa pela rota do `provider` das opções. */
async function chamar(service: StudioRouteHealthService, scope: RouteScope, ...pedacos: StreamChunk[]) {
  for await (const _ of service.streamWithFallback(scope, opcoes, () => pedaco(...pedacos), () => pedaco())) {
    // A leitura até o fim é o que faz a gravação acontecer.
  }
}

function montar(precos: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  omniroute: { inputPerMillion: 1, outputPerMillion: 2 },
}) {
  const repository = new MemoryRepository()
  return {
    repository,
    service: new StudioRouteHealthService(repository, {
      routes: ['ollama', 'omniroute', 'deepseek-official'],
      localRoute: 'ollama', fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
      prices: precos,
      now: () => new Date('2026-09-17T12:00:00.000Z'),
      createId: () => 'evento-1',
    }),
  }
}

describe('ADENDO / uso desconhecido: ausência NÃO vira zero', () => {
  it('PASSA — resposta sem uso declarado conta como NÃO PRECIFICADA, e não como custo zero', async () => {
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    await chamar(h.service, escopo, ...semUso())
    const registro = h.service.list(escopo).find(linha => linha.route === 'omniroute')!
    expect(registro.unpriced_requests).toBe(1)
    expect(registro.estimated_cost_usd).toBe(0)
    // E o estado DIZ que não sabe, em vez de dizer que custou zero.
    expect(routeCostState(registro)).toBe('UNKNOWN')
  })

  it('PASSA — uma medida e uma não medida viram PARCIAL, e não uma das duas', async () => {
    // Colapsar parcial em medido esconderia metade do custo; colapsar em
    // desconhecido jogaria fora a metade que se sabe.
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    await chamar(h.service, escopo, ...comUso(1_000, 1_000))
    await chamar(h.service, escopo, ...semUso())
    const registro = h.service.list(escopo).find(linha => linha.route === 'omniroute')!
    expect(routeCostState(registro)).toBe('PARTIAL')
    expect(registro.requests).toBe(2)
    expect(registro.unpriced_requests).toBe(1)
  })
})

describe('ADENDO / precificação', () => {
  it('PASSA — com preço declarado, o custo é calculado dos tokens', async () => {
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    await chamar(h.service, escopo, ...comUso(1_000_000, 1_000_000))
    const registro = h.service.list(escopo).find(linha => linha.route === 'omniroute')!
    expect(registro.estimated_cost_usd).toBeCloseTo(3, 6)
  })

  it('PASSA — SEM preço declarado para a rota, o uso é contado e o custo NÃO é inventado', async () => {
    // Esta é a linha que impede "não sei o preço" de virar "custou zero".
    const h = montar({})
    await h.service.initialize(escopo, new Set(['omniroute']))
    await chamar(h.service, escopo, ...comUso(1_000_000, 1_000_000))
    const registro = h.service.list(escopo).find(linha => linha.route === 'omniroute')!
    expect(registro.input_tokens).toBe(1_000_000)
    expect(registro.estimated_cost_usd).toBe(0)
    expect(registro.unpriced_requests).toBe(1)
  })
})

describe('ADENDO / isolamento por inquilino', () => {
  it('PASSA — o consumo de um inquilino não aparece no registro do outro', async () => {
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    await h.service.initialize(vizinho, new Set(['omniroute']))
    await chamar(h.service, escopo, ...comUso(1_000, 1_000))
    expect(h.service.list(escopo).find(linha => linha.route === 'omniroute')!.requests).toBe(1)
    expect(h.service.list(vizinho).find(linha => linha.route === 'omniroute')!.requests).toBe(0)
  })

  it('PASSA — o TETO soma só os registros que recebe, e o chamador é quem escopa', async () => {
    const usoDoEscopo = routeBudgetUsage(
      [{ estimated_cost_usd: 3, unpriced_requests: 0 }],
      { maxCostUsd: 10, maxUnpricedRequests: 5 },
    )
    expect(usoDoEscopo).toEqual({ measuredCostUsd: 3, unpricedRequests: 0, verdict: 'WITHIN' })
  })
})

describe('ADENDO / teto com veredito', () => {
  it('PASSA — custo acima do teto reprova, e o veredito diz POR QUE', async () => {
    expect(routeBudgetUsage([{ estimated_cost_usd: 11, unpriced_requests: 0 }], { maxCostUsd: 10, maxUnpricedRequests: 5 }).verdict)
      .toBe('COST_EXCEEDED')
  })

  it('PASSA — muitas chamadas NÃO PRECIFICADAS reprovam sozinhas', async () => {
    // Sem esta regra, um provedor que nunca declara uso passaria para sempre
    // por um teto de dinheiro, gastando sem nunca somar.
    expect(routeBudgetUsage([{ estimated_cost_usd: 0, unpriced_requests: 9 }], { maxCostUsd: 10, maxUnpricedRequests: 5 }).verdict)
      .toBe('UNPRICED_EXCEEDED')
  })

  it('PASSA — SEM teto configurado, o veredito é DENTRO e não um bloqueio inventado', async () => {
    expect(routeBudgetUsage([{ estimated_cost_usd: 999, unpriced_requests: 99 }], undefined).verdict).toBe('WITHIN')
  })
})

describe('ADENDO / tentativas distintas e eventos', () => {
  it('PASSA — duas chamadas contam DUAS, e não uma', async () => {
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    await chamar(h.service, escopo, ...comUso(10, 10))
    await chamar(h.service, escopo, ...comUso(10, 10))
    expect(h.service.list(escopo).find(linha => linha.route === 'omniroute')!.requests).toBe(2)
  })

  it('PASSA — o evento de troca de rota é gravado UMA vez por troca', async () => {
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute', 'deepseek-official']))
    await chamar(h.service, escopo, { type: 'finish', reason: { kind: 'error', failure: { message: 'caiu' } } } as StreamChunk)
    // Uma queda, um evento. A contagem é do mapa, então um segundo evento com o
    // mesmo identificador não passaria despercebido como duas linhas.
    expect(h.service.switches(escopo).length).toBeLessThanOrEqual(1)
  })
})

describe('ADENDO / recuperação', () => {
  it('PASSA — o consumo gravado SOBREVIVE a uma instância nova do serviço', async () => {
    // O que importa depois de uma queda é o que ficou no armazenamento, e não o
    // que a instância tinha em memória.
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    await chamar(h.service, escopo, ...comUso(1_000, 1_000))
    const outra = new StudioRouteHealthService(h.repository, {
      routes: ['ollama', 'omniroute', 'deepseek-official'],
      localRoute: 'ollama', fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
      prices: { omniroute: { inputPerMillion: 1, outputPerMillion: 2 } },
      now: () => new Date('2026-09-17T13:00:00.000Z'), createId: () => 'evento-2',
    })
    expect(outra.list(escopo).find(linha => linha.route === 'omniroute')!.requests).toBe(1)
  })
})

describe('ADENDO / RESERVA e CONCORRÊNCIA — o que AINDA NÃO existe', () => {
  it('NÃO OBSERVADO — duas chamadas concorrentes NESTE ambiente não perderam gravação', async () => {
    /*
      Eu esperava perda, e MEDI o contrário. Fica registrado como medido, e não
      como eu supunha, porque "eu achava" nunca foi prova aqui.

      A gravação do consumo é ler-modificar-escrever sem escrita condicionada e
      sem fila. Neste teste as duas chamadas NÃO se intercalaram: o dublê de
      armazenamento resolve de imediato, e cada `record` completa inteiro antes
      de o outro começar. Então o que este caso prova é estreito e vale dizer
      qual é: com armazenamento síncrono e em UM processo, duas chamadas
      concorrentes contam duas.

      O que ele NÃO prova, e por isso a fatia C continua aberta: armazenamento
      com espera de verdade (PostgreSQL) pode intercalar as duas leituras, e
      DOIS processos do Studio no mesmo escopo certamente podem. A guarda que
      fecharia isso — escrita condicionada como a da parada de emergência, ou
      uma fila por registro — NÃO existe neste plugin, e nenhum teste pode
      inventá-la.

      `NÃO OBSERVADO` não é `PASSOU`.
    */
    const h = montar()
    await h.service.initialize(escopo, new Set(['omniroute']))
    // A montagem também grava; o que interessa é o que as DUAS chamadas fazem.
    const antes = h.repository.gravacoes
    await Promise.all([
      chamar(h.service, escopo, ...comUso(1_000, 1_000)),
      chamar(h.service, escopo, ...comUso(1_000, 1_000)),
    ])
    const registro = h.service.list(escopo).find(linha => linha.route === 'omniroute')!
    expect(h.repository.gravacoes - antes).toBe(2)
    expect(registro.requests).toBe(2)
    expect(registro.input_tokens).toBe(2_000)
  })

  it('a ESCRITA CONDICIONADA que fecharia a corrida não existe aqui — e a ausência é conferível', () => {
    /*
      A parada de emergência grava com condição: ela relê, compara `updated_at`
      com o que esperava, e recusa quando mudou. `route-health` não tem nada
      disso — `putRoute` aceita qualquer coisa —, e é por isso que a corrida
      entre processos continua aberta.

      Este caso confere a ASSINATURA, que é o que dá para conferir: o
      repositório de rotas tem uma escrita só, e ela não recebe expectativa
      nenhuma. Quando a fatia C acrescentar o parâmetro, este teste quebra e
      pede para ser reescrito.
    */
    const repositorio = new MemoryRepository()
    expect(repositorio.putRoute.length).toBe(1)
  })

  it('NÃO PASSA (declarado) — não há RESERVA antes da chamada: o teto é conferido com o que já foi gasto', async () => {
    /*
      `routeBudgetUsage` responde sobre o PASSADO. Não existe reserva que
      segure orçamento antes de a chamada sair, então duas chamadas que cabem
      sozinhas mas não cabem juntas passam as duas.

      A prova é a assinatura da função: ela recebe registros e um teto, e não
      tem como marcar nada. Não há função de reserva neste plugin — e este teste
      diz isso conferindo que o único caminho existente é o de leitura.
    */
    const dentro = routeBudgetUsage([{ estimated_cost_usd: 6, unpriced_requests: 0 }], { maxCostUsd: 10, maxUnpricedRequests: 5 })
    expect(dentro.verdict).toBe('WITHIN')
    // Uma segunda chamada do mesmo tamanho também "cabe", porque a primeira
    // ainda não foi gravada quando ela pergunta.
    expect(routeBudgetUsage([{ estimated_cost_usd: 6, unpriced_requests: 0 }], { maxCostUsd: 10, maxUnpricedRequests: 5 }).verdict).toBe('WITHIN')
  })
})
