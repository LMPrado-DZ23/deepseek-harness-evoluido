import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { RouteHealthRecord, RouteSwitchEvent } from '../src/model.ts'
import {
  ROUTE_FAILURE_MESSAGE,
  StudioRouteHealthService,
  routeBudgetUsage,
  routeCircuitState,
  routeCostState,
  type RouteHealthConfig,
  type RouteHealthRepository,
  type RouteScope,
} from '../src/service.ts'

class MemoryRepository implements RouteHealthRepository {
  readonly routeMap = new Map<string, RouteHealthRecord>()
  readonly eventMap = new Map<string, RouteSwitchEvent>()
  routes() { return [...this.routeMap.values()] }
  events() { return [...this.eventMap.values()] }
  putRoute(value: RouteHealthRecord) { this.routeMap.set(value.record_id, value); return Promise.resolve() }
  putEvent(value: RouteSwitchEvent) { this.eventMap.set(value.event_id, value); return Promise.resolve() }
}

const scope: RouteScope = { orgId: 'org-1', tenantId: 'tenant-1' }
const options: GenerateOptions = { provider: 'omniroute', model: 'auto', messages: [] }

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function* chunks(...values: StreamChunk[]) {
  yield* values
}

function error(message = 'gateway down'): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message } } } as StreamChunk
}

function service(repository = new MemoryRepository()) {
  return {
    repository,
    service: new StudioRouteHealthService(repository, {
      routes: ['ollama', 'omniroute', 'deepseek-official'],
      localRoute: 'ollama', fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
      prices: { omniroute: { inputPerMillion: 1, outputPerMillion: 2 } },
      now: () => new Date('2026-09-03T00:00:00.000Z'), createId: () => 'event-1',
    }),
  }
}

describe('StudioRouteHealthService', () => {
  it('initializes truthful states and selects explicit, local, healthy or direct routes', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'deepseek-official']))
    expect(h.service.list(scope).map(record => [record.route, record.state])).toEqual([
      ['ollama', 'OK'], ['omniroute', 'NOT_CONFIGURED'], ['deepseek-official', 'OK'],
    ])
    await expect(h.service.chooseRoute(scope, 'T0', { privacy: 'local-only' })).resolves.toEqual({
      route: 'ollama', explicit: false, reason: 'Perfil privado restrito à IA local.',
    })
    await expect(h.service.chooseRoute(scope, 'T0', {
      privacy: 'local-only', explicitRoute: 'ollama',
    })).resolves.toMatchObject({ route: 'ollama', explicit: true })
    await expect(h.service.chooseRoute(scope, 'T0')).resolves.toMatchObject({ route: 'ollama', explicit: false })
    await expect(h.service.chooseRoute({ orgId: 'org-2', tenantId: 'tenant-2' }, 'T0')).resolves.toMatchObject({ route: 'ollama' })
    expect(h.service.list({ orgId: 'org-2', tenantId: 'tenant-2' })).toHaveLength(3)
    await expect(h.service.chooseRoute(scope, 'T2', { privacy: 'any', explicitRoute: 'omniroute' })).resolves.toEqual({
      route: 'omniroute', explicit: true, reason: 'Rota escolhida pela pessoa.',
    })
    await expect(h.service.chooseRoute(scope, 'T2')).resolves.toMatchObject({ route: 'ollama' })

    await h.service.initialize(scope, new Set())
    await expect(h.service.chooseRoute(scope, 'T2')).resolves.toMatchObject({ route: 'deepseek-official' })
    expect(h.service.list({ orgId: 'other', tenantId: 'other' }).every(record => record.state === 'NOT_CONFIGURED')).toBe(true)
    expect(h.service.switches(scope)).toEqual([])
  })

  it('never sends a local-only request to an external route and audits the refusal', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await expect(h.service.chooseRoute(scope, 'T0', { privacy: 'local-only' })).resolves.toEqual({
      route: undefined,
      explicit: false,
      reason: 'IA local indisponível; nenhuma informação foi enviada para uma rota externa.',
    })
    expect(h.service.switches(scope)[0]).toMatchObject({
      from_route: 'ollama', to_route: 'blocked', explicit_route: false,
    })
    await expect(h.service.chooseRoute(scope, 'T0', { privacy: 'any' })).resolves.toMatchObject({ route: 'omniroute' })
    await expect(h.service.chooseRoute(scope, 'T0', {
      privacy: 'local-only', explicitRoute: 'deepseek-official',
    })).resolves.toMatchObject({ route: undefined, explicit: true })
  })

  it('records latency, usage and configured cost on success', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute']))
    const output = await collect(h.service.streamWithFallback(scope, options, () => chunks(
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ), () => chunks()))
    expect(output.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'usage', 'finish'])
    expect(h.service.list(scope).find(record => record.route === 'omniroute')).toMatchObject({
      state: 'OK', requests: 1, errors: 0, input_tokens: 10, output_tokens: 5,
      estimated_cost_usd: 0.00002,
    })
  })

  it('falls back only when OmniRoute fails before visible content and audits the switch', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    const fallbackCalls: GenerateOptions[] = []
    const output = await collect(h.service.streamWithFallback(scope, options,
      () => chunks({ type: 'block-start', index: 0, blockType: 'text' }, error()),
      fallbackOptions => {
        fallbackCalls.push(fallbackOptions)
        return chunks({ type: 'text-delta', index: 0, text: 'resposta direta' }, { type: 'finish', reason: { kind: 'stop' } })
      }))
    expect(output).toEqual([
      { type: 'text-delta', index: 0, text: 'resposta direta' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(fallbackCalls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(h.service.switches(scope)[0]).toMatchObject({
      from_route: 'omniroute', to_route: 'deepseek-official', explicit_route: false,
    })
    expect(h.service.list(scope).find(record => record.route === 'omniroute')?.state).toBe('DOWN')
  })

  it('never falls back after text, tool output, an explicit route, or a different provider', async () => {
    for (const candidate of [
      { source: chunks({ type: 'text-delta', index: 0, text: 'parcial' }, error()), explicit: false, provider: 'omniroute' },
      { source: chunks({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'id' as never, name: 'write', arguments: '{}' } }, error()), explicit: false, provider: 'omniroute' },
      { source: chunks(error()), explicit: true, provider: 'omniroute' },
      { source: chunks(error()), explicit: false, provider: 'ollama' },
    ]) {
      const h = service()
      let fallback = 0
      const output = await collect(h.service.streamWithFallback(scope, { ...options, provider: candidate.provider },
        () => candidate.source, () => { fallback += 1; return chunks() }, candidate.explicit))
      expect(output.at(-1)?.type).toBe('finish')
      const finish = output.at(-1)
      if (finish?.type === 'finish' && (finish.reason.kind === 'error' || finish.reason.kind === 'aborted')) {
        expect(finish.reason.failure.message).toBe(ROUTE_FAILURE_MESSAGE)
      }
      expect(fallback).toBe(0)
      expect(h.service.switches(scope)).toEqual([])
    }
  })

  it('classifies repeated mixed outcomes as degraded and handles aborted failures', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama']))
    await collect(h.service.streamWithFallback(scope, { ...options, provider: 'ollama' },
      () => chunks({ type: 'finish', reason: { kind: 'stop' } }), () => chunks()))
    await collect(h.service.streamWithFallback(scope, { ...options, provider: 'ollama' },
      () => chunks({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelado' } } } as StreamChunk), () => chunks()))
    expect(h.service.list(scope).find(record => record.route === 'ollama')).toMatchObject({
      requests: 2, errors: 1, state: 'DOWN', last_failure: 'cancelado',
    })
  })

  it('covers degraded recovery, a low error rate, fallback usage and default audit metadata', async () => {
    const repository = new MemoryRepository()
    const subject = new StudioRouteHealthService(repository, {
      routes: ['omniroute', 'deepseek-official'],
      localRoute: 'ollama', fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
    })
    await subject.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await collect(subject.streamWithFallback(scope, options, () => chunks(error()), () => chunks(
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }, error('direct failed'),
    )))
    expect(subject.switches(scope)[0]?.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(subject.list(scope).find(record => record.route === 'deepseek-official')).toMatchObject({
      input_tokens: 2, output_tokens: 3, state: 'DOWN', last_failure: 'direct failed',
    })

    await collect(subject.streamWithFallback(scope, options,
      () => chunks({ type: 'finish', reason: { kind: 'stop' } }), () => chunks()))
    expect(subject.list(scope).find(record => record.route === 'omniroute')?.state).toBe('DEGRADED')

    const direct = { ...options, provider: 'new-direct-route' }
    await collect(subject.streamWithFallback(scope, direct,
      () => chunks({ type: 'finish', reason: { kind: 'stop' } }), () => chunks()))
    await collect(subject.streamWithFallback(scope, direct,
      () => chunks({ type: 'finish', reason: { kind: 'stop' } }), () => chunks()))
    await collect(subject.streamWithFallback(scope, direct, () => chunks(error('one of three')), () => chunks()))
    expect(subject.list(scope).find(record => record.route === 'new-direct-route')?.state).toBe('DEGRADED')
  })
})

describe('custo que ninguém mediu', () => {
  it('não apresenta "não sei o preço" como custo zero', async () => {
    // A soma tratava preço ausente como 0 e gravava um número que parece
    // medido. Zero gasto e zero conhecimento são coisas diferentes, e só uma
    // delas pode virar cifra na tela. `ollama` não tem preço configurado.
    const h = service()
    await h.service.initialize(scope, new Set(['ollama']))
    await collect(h.service.streamWithFallback(scope, { ...options, provider: 'ollama' }, () => chunks(
      { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 500 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ), () => chunks()))
    const record = h.service.list(scope).find(row => row.route === 'ollama')!
    expect(record.requests).toBe(1)
    expect(record.estimated_cost_usd).toBe(0)
    expect(record.unpriced_requests).toBe(1)
    expect(routeCostState(record)).toBe('UNKNOWN')
  })

  it('a rota com preço continua medida', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute']))
    await collect(h.service.streamWithFallback(scope, options, () => chunks(
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ), () => chunks()))
    const record = h.service.list(scope).find(row => row.route === 'omniroute')!
    expect(record.unpriced_requests).toBe(0)
    expect(routeCostState(record)).toBe('MEASURED')
  })

  it('distingue o piso do total quando só parte tem preço', () => {
    expect(routeCostState({ requests: 0, unpriced_requests: 0 })).toBe('MEASURED')
    expect(routeCostState({ requests: 4, unpriced_requests: 0 })).toBe('MEASURED')
    expect(routeCostState({ requests: 4, unpriced_requests: 1 })).toBe('PARTIAL')
    expect(routeCostState({ requests: 4, unpriced_requests: 4 })).toBe('UNKNOWN')
    // Registro gravado antes de o campo existir: nenhuma não precificada.
    expect(routeCostState({ requests: 4 })).toBe('MEASURED')
  })
})

/**
 * Fábrica com relógio que anda: o circuito só existe no tempo, e um relógio
 * congelado prova apenas metade dele - abrir sem nunca deixar reabrir.
 */
function circuitService(overrides: Partial<RouteHealthConfig> = {}) {
  let clock = new Date('2026-09-03T00:00:00.000Z')
  let sequence = 0
  const repository = new MemoryRepository()
  const subject = new StudioRouteHealthService(repository, {
    routes: ['omniroute'],
    localRoute: 'ollama', fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
    circuit: { failureThreshold: 3, cooldownMs: 30_000 },
    now: () => clock,
    createId: () => { sequence += 1; return `event-${String(sequence)}` },
    ...overrides,
  })
  return {
    repository, subject,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms) },
    async fail(provider: string, times = 1) {
      for (let attempt = 0; attempt < times; attempt += 1) {
        await collect(subject.streamWithFallback(scope, { ...options, provider },
          () => chunks(error()), () => chunks(), true))
      }
    },
    async succeed(provider: string) {
      await collect(subject.streamWithFallback(scope, { ...options, provider },
        () => chunks({ type: 'finish', reason: { kind: 'stop' } }), () => chunks(), true))
    },
  }
}

describe('circuito por rota e por escopo', () => {
  it('abre depois de tres falhas seguidas e para de oferecer a rota enquanto durar a espera', async () => {
    const h = circuitService()
    await h.subject.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await h.fail('omniroute', 2)
    expect(h.subject.circuit(scope, 'omniroute')).toBe('CLOSED')
    await h.fail('omniroute')
    expect(h.subject.circuit(scope, 'omniroute')).toBe('OPEN')
    // Com o circuito aberto a rota caída não volta a ser tentada; quem responde
    // é a rota direta, e não a mesma espera perdida de novo.
    await expect(h.subject.chooseRoute(scope, 'T2')).resolves.toMatchObject({ route: 'deepseek-official' })
  })

  it('nao fecha o circuito de um locatario por causa da falha de outro', async () => {
    const h = circuitService()
    await h.subject.initialize(scope, new Set(['omniroute']))
    await h.fail('omniroute', 3)
    const neighbour = { orgId: 'org-2', tenantId: 'tenant-1' }
    expect(h.subject.circuit(scope, 'omniroute')).toBe('OPEN')
    expect(h.subject.circuit(neighbour, 'omniroute')).toBe('CLOSED')
  })

  it('depois da espera concede UMA chamada, e a segunda ja encontra o circuito fechado de novo', async () => {
    const h = circuitService()
    await h.subject.initialize(scope, new Set(['omniroute']))
    await h.fail('omniroute', 3)
    h.advance(30_000)
    expect(h.subject.circuit(scope, 'omniroute')).toBe('HALF_OPEN')
    await expect(h.subject.chooseRoute(scope, 'T2')).resolves.toEqual({
      route: 'omniroute', explicit: false,
      reason: 'Meia-abertura: uma chamada decide se o circuito fecha ou reabre.',
    })
    // A chamada de prova reinicia a espera: a requisição seguinte não pode
    // descer junto na mesma rota quebrada.
    expect(h.subject.circuit(scope, 'omniroute')).toBe('OPEN')
    await expect(h.subject.chooseRoute(scope, 'T2')).resolves.toMatchObject({ route: 'deepseek-official' })
  })

  it('o sucesso fecha o circuito e a falha na meia-abertura reabre a espera inteira', async () => {
    const h = circuitService()
    await h.subject.initialize(scope, new Set(['omniroute']))
    await h.fail('omniroute', 3)
    h.advance(30_000)
    await h.fail('omniroute')
    expect(h.subject.circuit(scope, 'omniroute')).toBe('OPEN')
    h.advance(29_999)
    expect(h.subject.circuit(scope, 'omniroute')).toBe('OPEN')
    await h.succeed('omniroute')
    expect(h.subject.circuit(scope, 'omniroute')).toBe('CLOSED')
    expect(h.subject.list(scope).find(record => record.route === 'omniroute')).toMatchObject({
      consecutive_failures: 0, circuit_opened_at: null,
    })
  })

  it('recusa a escolha quando ate a rota direta esta em espera, em vez de prometer o que vai falhar', async () => {
    const h = circuitService()
    await h.subject.initialize(scope, new Set(['omniroute']))
    await h.fail('deepseek-official', 3)
    await h.fail('omniroute', 3)
    await expect(h.subject.chooseRoute(scope, 'T2')).resolves.toEqual({
      route: undefined, explicit: false,
      reason: 'Circuito aberto em todas as rotas; nenhuma chamada nova enquanto durar a espera.',
    })
    expect(h.subject.switches(scope).at(-1)).toMatchObject({ to_route: 'blocked' })
  })

  it('registro gravado antes dos campos existirem vale como circuito fechado', () => {
    expect(routeCircuitState({}, new Date('2026-09-03T00:00:00.000Z'))).toBe('CLOSED')
    expect(routeCircuitState({ circuit_opened_at: null }, new Date('2026-09-03T00:00:00.000Z'))).toBe('CLOSED')
    // Sem configuração explícita vale o padrão da casa: trinta segundos.
    expect(routeCircuitState(
      { circuit_opened_at: '2026-09-03T00:00:00.000Z' }, new Date('2026-09-03T00:00:29.999Z'),
    )).toBe('OPEN')
    expect(routeCircuitState(
      { circuit_opened_at: '2026-09-03T00:00:00.000Z' }, new Date('2026-09-03T00:00:30.000Z'),
    )).toBe('HALF_OPEN')
  })
})

describe('teto de gasto por escopo', () => {
  it('barra a rota paga pelo custo MEDIDO e mantem a IA local, que nao cobra', async () => {
    const h = circuitService({
      routes: ['ollama', 'omniroute', 'deepseek-official'],
      prices: { omniroute: { inputPerMillion: 1, outputPerMillion: 1 } },
      budget: { maxCostUsd: 0.01, maxUnpricedRequests: 1_000 },
    })
    await h.subject.initialize(scope, new Set(['ollama', 'omniroute', 'deepseek-official']))
    await collect(h.subject.streamWithFallback(scope, options, () => chunks(
      { type: 'usage', usage: { inputTokens: 10_000, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ), () => chunks(), true))
    expect(h.subject.budget(scope)).toMatchObject({ measuredCostUsd: 0.01, verdict: 'COST_EXCEEDED' })
    await expect(h.subject.chooseRoute(scope, 'T2')).resolves.toEqual({
      route: 'ollama', explicit: false,
      reason: 'Teto de gasto do escopo estourado; seguindo apenas com a IA local.',
    })
    expect(h.subject.switches(scope).at(-1)).toMatchObject({ to_route: 'ollama', explicit_route: false })
  })

  it('a escolha explicita da pessoa nao atravessa o teto', async () => {
    const h = circuitService({
      routes: ['omniroute'],
      budget: { maxCostUsd: 1, maxUnpricedRequests: 2 },
      localRoute: 'ollama',
    })
    await h.subject.initialize(scope, new Set(['omniroute']))
    await h.succeed('omniroute')
    await h.succeed('omniroute')
    expect(h.subject.budget(scope)).toMatchObject({ unpricedRequests: 2, verdict: 'UNPRICED_EXCEEDED' })
    // Sem IA local saudável não há para onde descer: barrar é a resposta
    // honesta, e ela fica auditada com a rota que a pessoa tinha pedido.
    await expect(h.subject.chooseRoute(scope, 'T2', { privacy: 'any', explicitRoute: 'omniroute' })).resolves.toEqual({
      route: undefined, explicit: true,
      reason: 'Teto de gasto do escopo estourado; nenhuma rota paga foi acionada.',
    })
    expect(h.subject.switches(scope).at(-1)).toMatchObject({
      from_route: 'omniroute', to_route: 'blocked', explicit_route: true,
    })
    // A rota local pedida a dedo continua passando com o MESMO teto estourado:
    // ela não gasta dinheiro, e barrá-la seria barrar trabalho de graça.
    expect(h.subject.budget(scope).verdict).toBe('UNPRICED_EXCEEDED')
    await expect(h.subject.chooseRoute(scope, 'T2', { privacy: 'any', explicitRoute: 'ollama' })).resolves.toMatchObject({
      route: 'ollama', explicit: true,
    })
  })

  it('nao trata "nao sei o preco" como "gastou zero": conta a requisicao sem preco', () => {
    const priced = { estimated_cost_usd: 0.5, unpriced_requests: 0 }
    const unpriced = { estimated_cost_usd: 0, unpriced_requests: 40 }
    // Sem teto configurado o guarda não inventa autoridade nenhuma.
    expect(routeBudgetUsage([priced, unpriced], undefined)).toEqual({
      measuredCostUsd: 0.5, unpricedRequests: 40, verdict: 'WITHIN',
    })
    // Quarenta requisições de custo desconhecido somariam ZERO num teto que só
    // olha dinheiro; é por isso que existe o segundo teto.
    expect(routeBudgetUsage([unpriced], { maxCostUsd: 100, maxUnpricedRequests: 40 }).verdict).toBe('UNPRICED_EXCEEDED')
    expect(routeBudgetUsage([unpriced], { maxCostUsd: 100, maxUnpricedRequests: 41 }).verdict).toBe('WITHIN')
    expect(routeBudgetUsage([priced], { maxCostUsd: 0.5, maxUnpricedRequests: 1 }).verdict).toBe('COST_EXCEEDED')
    // Registro antigo, sem o campo: nenhuma requisição sem preço.
    expect(routeBudgetUsage([{ estimated_cost_usd: 0 }], { maxCostUsd: 1, maxUnpricedRequests: 1 }).verdict).toBe('WITHIN')
  })
})

describe('sem cascatas duplicadas', () => {
  it('nao desce a cascata duas vezes para a mesma requisicao', async () => {
    const h = circuitService({ routes: ['omniroute', 'deepseek-official'] })
    await h.subject.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    let cascades = 0
    const request: GenerateOptions = { ...options }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await collect(h.subject.streamWithFallback(scope, request, () => chunks(error()), () => {
        cascades += 1
        return chunks({ type: 'finish', reason: { kind: 'stop' } })
      }))
    }
    expect(cascades).toBe(1)
    expect(h.subject.switches(scope)).toHaveLength(1)
  })

  it('nao tenta na cascata a rota que ja falhou nesta requisicao', async () => {
    const h = circuitService({ routes: ['omniroute'], fallbackRoute: 'omniroute' })
    await h.subject.initialize(scope, new Set(['omniroute']))
    let cascades = 0
    await collect(h.subject.streamWithFallback(scope, options, () => chunks(error()), () => {
      cascades += 1
      return chunks()
    }))
    expect(cascades).toBe(0)
    expect(h.subject.switches(scope)).toEqual([])
  })

  it('nao desce para uma rota direta com o circuito aberto', async () => {
    const h = circuitService({ routes: ['omniroute', 'deepseek-official'] })
    await h.subject.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await h.fail('deepseek-official', 3)
    let cascades = 0
    const output = await collect(h.subject.streamWithFallback(scope, options, () => chunks(error()), () => {
      cascades += 1
      return chunks()
    }))
    expect(cascades).toBe(0)
    expect(output.at(-1)?.type).toBe('finish')
    expect(h.subject.switches(scope)).toEqual([])
  })
})
