import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { RouteHealthRecord, RouteSwitchEvent } from '../src/model.ts'
import {
  ROUTE_FAILURE_MESSAGE,
  ROUTE_PRIVACY_PROFILES,
  StudioRouteHealthService,
  enforceRoutePrivacy,
  routeBudgetUsage,
  routeCircuitState,
  routeCostState,
  routePrivacyProfile,
  type RouteHealthConfig,
  type RouteHealthRepository,
  type RoutePrivacy,
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
      route: 'ollama', explicit: false, reason: 'Perfil privado restrito à IA local.', reasonCode: 'PRIVATE_LOCAL',
    })
    await expect(h.service.chooseRoute(scope, 'T0', {
      privacy: 'local-only', explicitRoute: 'ollama',
    })).resolves.toMatchObject({ route: 'ollama', explicit: true })
    await expect(h.service.chooseRoute(scope, 'T0')).resolves.toMatchObject({ route: 'ollama', explicit: false })
    await expect(h.service.chooseRoute({ orgId: 'org-2', tenantId: 'tenant-2' }, 'T0')).resolves.toMatchObject({ route: 'ollama' })
    expect(h.service.list({ orgId: 'org-2', tenantId: 'tenant-2' })).toHaveLength(3)
    await expect(h.service.chooseRoute(scope, 'T2', { privacy: 'any', explicitRoute: 'omniroute' })).resolves.toEqual({
      route: 'omniroute', explicit: true, reason: 'Rota escolhida pela pessoa.', reasonCode: 'EXPLICIT',
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
      reason: 'IA local indisponível; nenhuma informação foi enviada para uma rota externa.', reasonCode: 'LOCAL_BLOCKED',
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
      reason: 'Meia-abertura: uma chamada decide se o circuito fecha ou reabre.', reasonCode: 'HALF_OPEN',
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
      reason: 'Circuito aberto em todas as rotas; nenhuma chamada nova enquanto durar a espera.', reasonCode: 'ALL_OPEN',
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
      reason: 'Teto de gasto do escopo estourado; seguindo apenas com a IA local.', reasonCode: 'BUDGET_LOCAL',
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
      reason: 'Teto de gasto do escopo estourado; nenhuma rota paga foi acionada.', reasonCode: 'BUDGET_BLOCKED',
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

describe('M-05: os tres perfis nomeados', () => {
  it('le o valor antigo gravado em disco como o perfil novo', () => {
    // A versao do dominio nao pode subir - `open()` falha com
    // `version-mismatch` em instalacao que ja rodou e nao ha migracao. Entao o
    // registro gravado com o binario antigo tem de continuar significando a
    // mesma coisa, e nao virar "perfil desconhecido".
    expect(routePrivacyProfile('local-only')).toBe('privado-local')
    expect(routePrivacyProfile('any')).toBe('melhor-qualidade')
    expect(routePrivacyProfile('privado-local')).toBe('privado-local')
    expect(routePrivacyProfile('equilibrado')).toBe('equilibrado')
    expect(routePrivacyProfile('melhor-qualidade')).toBe('melhor-qualidade')
    expect(ROUTE_PRIVACY_PROFILES).toEqual(['privado-local', 'equilibrado', 'melhor-qualidade'])
  })

  it('o registro antigo escolhe a MESMA rota que o perfil novo escolheria', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'omniroute', 'deepseek-official']))
    const legacyLocal = await h.service.chooseRoute(scope, 'T2', { privacy: 'local-only' })
    const namedLocal = await h.service.chooseRoute(scope, 'T2', { privacy: 'privado-local' })
    expect(legacyLocal).toEqual(namedLocal)
    const legacyBest = await h.service.chooseRoute(scope, 'T2', { privacy: 'any' })
    const namedBest = await h.service.chooseRoute(scope, 'T2', { privacy: 'melhor-qualidade' })
    expect(legacyBest).toEqual(namedBest)
  })

  it('equilibrado prefere a local em todo proposito, nao so na leitura segura', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'omniroute', 'deepseek-official']))
    // `melhor-qualidade` ja preferia a local em T0; o que separa os dois perfis
    // e o que acontece FORA de T0, e ai o equilibrado continua na local.
    await expect(h.service.chooseRoute(scope, 'T2', { privacy: 'equilibrado' })).resolves.toEqual({
      route: 'ollama', explicit: false,
      reason: 'Perfil equilibrado: a IA local está em uso e nada sai deste computador.', reasonCode: 'BALANCED_LOCAL',
    })
  })

  it('equilibrado vai para fora quando a local nao serve, e AVISA que foi', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    const chosen = await h.service.chooseRoute(scope, 'T2', { privacy: 'equilibrado' })
    expect(chosen).toEqual({
      route: 'omniroute', explicit: false,
      reason: 'Perfil equilibrado: a IA local não está disponível; usando a rota externa configurada.', reasonCode: 'BALANCED_EXTERNAL',
    })
    // O aviso nao vive so na frase: a troca fica auditada como qualquer outra.
    expect(h.service.switches(scope).at(-1)).toMatchObject({ from_route: 'ollama', to_route: 'omniroute' })
  })

  it('equilibrado tambem avisa quando so sobra a rota direta', async () => {
    const h = service()
    await h.service.initialize(scope, new Set())
    const chosen = await h.service.chooseRoute(scope, 'T2', { privacy: 'equilibrado' })
    expect(chosen).toMatchObject({
      route: 'deepseek-official',
      reason: 'Perfil equilibrado: a IA local não está disponível; usando a rota externa configurada.', reasonCode: 'BALANCED_EXTERNAL',
    })
    expect(h.service.switches(scope).at(-1)).toMatchObject({ to_route: 'deepseek-official' })
  })

  it('melhor-qualidade continua usando a melhor rota disponivel', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await expect(h.service.chooseRoute(scope, 'T2', { privacy: 'melhor-qualidade' })).resolves.toEqual({
      route: 'omniroute', explicit: false, reason: 'Primeira rota saudável do perfil.', reasonCode: 'FIRST_HEALTHY',
    })
  })
})

describe('M-05: liga e desliga por rota', () => {
  it('registro gravado antes do campo existir vale como LIGADA', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'omniroute']))
    // Ler ausencia como "desligada" apagaria toda rota de toda instalacao que
    // ja rodava antes do liga/desliga existir.
    expect(h.repository.routeMap.get('org-1:tenant-1:ollama')?.enabled).toBeUndefined()
    expect(h.service.enabled(scope, 'ollama')).toBe(true)
    expect(h.service.enabled(scope, 'rota-que-nao-existe')).toBe(true)
  })

  it('rota desligada nao e escolhida, e o motivo aparece na frase', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'omniroute', 'deepseek-official']))
    await h.service.setRouteEnabled(scope, 'ollama', false)
    expect(h.service.enabled(scope, 'ollama')).toBe(false)
    // A local desligada nao e mais "preferida para leitura segura".
    await expect(h.service.chooseRoute(scope, 'T0')).resolves.toMatchObject({ route: 'omniroute' })
    await h.service.setRouteEnabled(scope, 'omniroute', false)
    await expect(h.service.chooseRoute(scope, 'T2')).resolves.toMatchObject({ route: 'deepseek-official' })
    // Pedida pelo nome, uma rota desligada continua desligada: um guarda que a
    // escolha explicita atravessa nao e guarda.
    await expect(h.service.chooseRoute(scope, 'T2', { privacy: 'melhor-qualidade', explicitRoute: 'omniroute' })).resolves.toEqual({
      route: undefined, explicit: true,
      reason: 'Rota desligada neste espaço de trabalho; ela não é escolhida enquanto continuar assim.', reasonCode: 'DISABLED',
    })
    expect(h.service.switches(scope).at(-1)).toMatchObject({ from_route: 'omniroute', to_route: 'blocked', explicit_route: true })
    // Desligada a ultima rota, a resposta honesta e recusar - nao prometer uma
    // rota que alguem mandou parar de usar.
    await h.service.setRouteEnabled(scope, 'deepseek-official', false)
    await expect(h.service.chooseRoute(scope, 'T2')).resolves.toMatchObject({
      route: undefined,
      reason: 'Rota desligada neste espaço de trabalho; ela não é escolhida enquanto continuar assim.', reasonCode: 'DISABLED',
    })
  })

  it('desliga uma rota que ainda nao tinha registro, sem inventar saude para ela', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'rota-extra']))
    // Rota conhecida pelo runtime mas fora da lista monitorada: ela nasce OK.
    await h.service.setRouteEnabled(scope, 'rota-extra', false)
    expect(h.repository.routeMap.get('org-1:tenant-1:rota-extra')).toMatchObject({ state: 'OK', enabled: false })
    // Rota que ninguem configurou nasce NOT_CONFIGURED: desligar nao pode
    // promove-la a saudavel de brinde.
    await h.service.setRouteEnabled(scope, 'rota-desconhecida', false)
    expect(h.repository.routeMap.get('org-1:tenant-1:rota-desconhecida')).toMatchObject({
      state: 'NOT_CONFIGURED', enabled: false, requests: 0,
    })
    expect(h.service.enabled(scope, 'rota-desconhecida')).toBe(false)
  })

  it('o desligamento e por escopo: o vizinho continua com a rota ligada', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['ollama', 'omniroute', 'deepseek-official']))
    await h.service.setRouteEnabled(scope, 'omniroute', false)
    const neighbour = { orgId: 'org-2', tenantId: 'tenant-1' }
    expect(h.service.enabled(neighbour, 'omniroute')).toBe(true)
    await expect(h.service.chooseRoute(neighbour, 'T2', { privacy: 'melhor-qualidade', explicitRoute: 'omniroute' })).resolves.toMatchObject({
      route: 'omniroute',
    })
    // E religar devolve a rota sem nenhum outro efeito colateral.
    await h.service.setRouteEnabled(scope, 'omniroute', true)
    expect(h.service.enabled(scope, 'omniroute')).toBe(true)
  })

  it('a cascata nao desce para uma rota direta desligada', async () => {
    const h = service()
    await h.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await h.service.setRouteEnabled(scope, 'deepseek-official', false)
    let cascades = 0
    await collect(h.service.streamWithFallback(scope, options, () => chunks(error()), () => {
      cascades += 1
      return chunks()
    }))
    expect(cascades).toBe(0)
    expect(h.service.switches(scope)).toEqual([])
  })

  it('meia-abertura nao ressuscita uma rota desligada', async () => {
    const h = circuitService({ routes: ['omniroute', 'deepseek-official'] })
    await h.subject.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    await h.fail('omniroute', 3)
    await h.fail('deepseek-official', 3)
    h.advance(30_000)
    await h.subject.setRouteEnabled(scope, 'omniroute', false)
    // Com `omniroute` ligada seria ela a chamada de prova; desligada, a espera
    // continua valendo e quem responde e a rota direta em meia-abertura.
    await expect(h.subject.chooseRoute(scope, 'T2')).resolves.toMatchObject({ route: 'deepseek-official' })
  })
})

/**
 * A varredura do C-22.
 *
 * A promessa do perfil `privado-local` e uma so: nada sai deste computador.
 * Um teste que so olhasse os caminhos que existem HOJE nao protegeria nada -
 * quem abrir um caminho novo amanha nao vai lembrar de escrever o teste dele.
 * Por isso esta suite varre TODAS as combinacoes relevantes (perfil x estado
 * das rotas x liga/desliga x rota explicita x circuito x teto x proposito) e
 * afirma a invariante UMA vez: sob `privado-local`, ou a rota e a local, ou nao
 * ha rota nenhuma.
 */
const INVARIANT_NOW = new Date('2026-09-05T00:00:00.000Z')
const LOCAL_ROUTE = 'ollama'
const ALL_ROUTES = ['ollama', 'omniroute', 'deepseek-official'] as const
const PRIVACY_VALUES: readonly RoutePrivacy[] = ['privado-local', 'local-only', 'equilibrado', 'melhor-qualidade', 'any']
const STATE_VALUES = ['OK', 'DEGRADED', 'DOWN', 'NOT_CONFIGURED'] as const
const CIRCUIT_VALUES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const
const EXPLICIT_VALUES: readonly (string | undefined)[] = [undefined, 'ollama', 'omniroute', 'deepseek-official']

function seededRecord(
  route: string,
  state: (typeof STATE_VALUES)[number],
  enabled: boolean,
  circuit: (typeof CIRCUIT_VALUES)[number],
): RouteHealthRecord {
  const openedAt = circuit === 'CLOSED'
    ? null
    : circuit === 'OPEN' ? INVARIANT_NOW.toISOString() : new Date(INVARIANT_NOW.getTime() - 60_000).toISOString()
  return {
    record_id: `${scope.orgId}:${scope.tenantId}:${route}`, org_id: scope.orgId, tenant_id: scope.tenantId,
    route, state, requests: 4, errors: 2, average_latency_ms: 12,
    input_tokens: 1_000, output_tokens: 1_000, estimated_cost_usd: 1, unpriced_requests: 4,
    consecutive_failures: 2, circuit_opened_at: openedAt, enabled,
    last_failure: null, updated_at: INVARIANT_NOW.toISOString(),
  }
}

describe('C-22: privado-local nunca cai para rota externa', () => {
  it('varre perfil x estado x liga/desliga x rota explicita x circuito x teto e mantem a invariante', async () => {
    let privateCases = 0
    let externalCases = 0
    for (const privacy of PRIVACY_VALUES) {
      for (const localState of STATE_VALUES) {
        for (const otherState of STATE_VALUES) {
          for (const localEnabled of [true, false]) {
            for (const otherEnabled of [true, false]) {
              for (const circuit of CIRCUIT_VALUES) {
                for (const explicitRoute of EXPLICIT_VALUES) {
                  for (const purpose of ['T0', 'T2']) {
                    for (const budget of [undefined, { maxCostUsd: 0.5, maxUnpricedRequests: 1 }]) {
                      const repository = new MemoryRepository()
                      for (const route of ALL_ROUTES) {
                        const isLocal = route === LOCAL_ROUTE
                        await repository.putRoute(seededRecord(
                          route, isLocal ? localState : otherState, isLocal ? localEnabled : otherEnabled, circuit,
                        ))
                      }
                      const subject = new StudioRouteHealthService(repository, {
                        routes: [...ALL_ROUTES], localRoute: LOCAL_ROUTE,
                        fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
                        prices: { omniroute: { inputPerMillion: 1, outputPerMillion: 1 } },
                        now: () => INVARIANT_NOW, createId: () => 'event-sweep',
                        ...(budget === undefined ? {} : { budget }),
                      })
                      const selected = await subject.chooseRoute(scope, purpose, {
                        privacy, ...(explicitRoute === undefined ? {} : { explicitRoute }),
                      })
                      const label = JSON.stringify({
                        privacy, localState, otherState, localEnabled, otherEnabled, circuit, explicitRoute, purpose,
                        budget: budget !== undefined,
                      })
                      if (routePrivacyProfile(privacy) === 'privado-local') {
                        privateCases += 1
                        // A INVARIANTE, afirmada uma unica vez para todos os caminhos.
                        expect([undefined, LOCAL_ROUTE], label).toContain(selected.route)
                        // E o bloqueio nunca e mudo: quem foi barrado le por que.
                        if (selected.route === undefined) expect(selected.reason.trim(), label).not.toBe('')
                      } else {
                        externalCases += 1
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // A contagem e a prova de que a varredura rodou de verdade: uma suite que
    // deixasse de gerar casos passaria em silencio sem ela.
    expect(privateCases).toBe(6_144)
    expect(externalCases).toBe(9_216)
  })

  it('a cascata do stream tambem nao sai para fora sob privado-local', async () => {
    // A escolha da rota e uma decisao; a cascata e outra, e acontece DEPOIS,
    // quando o modelo local ja falhou. Sem o perfil carimbado na requisicao,
    // era exatamente aqui que o dado escapava.
    for (const privacy of ['privado-local', 'local-only'] as const) {
      const h = service()
      await h.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
      let cascades = 0
      const output = await collect(h.service.streamWithFallback(scope, options, () => chunks(error()), () => {
        cascades += 1
        return chunks({ type: 'finish', reason: { kind: 'stop' } })
      }, false, privacy))
      expect(cascades, privacy).toBe(0)
      expect(output.at(-1)?.type).toBe('finish')
      expect(h.service.switches(scope), privacy).toEqual([])
    }
    // E o mesmo fluxo, sem o perfil privado, continua descendo a cascata: o
    // teste acima so vale porque este mostra que a cascata existe.
    const open = service()
    await open.service.initialize(scope, new Set(['omniroute', 'deepseek-official']))
    let opened = 0
    await collect(open.service.streamWithFallback(scope, options, () => chunks(error()), () => {
      opened += 1
      return chunks({ type: 'finish', reason: { kind: 'stop' } })
    }, false, 'equilibrado'))
    expect(opened).toBe(1)
  })

  it('o funil barra uma rota externa que qualquer caminho novo tentasse devolver', () => {
    // A garantia nao pode depender de nenhum `if` la dentro estar certo: se um
    // caminho futuro devolver `omniroute` sob `privado-local`, e AQUI que ele
    // para. Este teste chama o funil com exatamente essa escolha proibida.
    const forbidden = { route: 'omniroute', explicit: true, reason: 'caminho novo', reasonCode: 'EXPLICIT' } as const
    expect(enforceRoutePrivacy('privado-local', LOCAL_ROUTE, forbidden, 'bloqueado')).toEqual({
      route: undefined, explicit: true, reason: 'bloqueado', reasonCode: 'LOCAL_BLOCKED',
    })
    // O que o perfil admite passa intacto.
    const local = { route: LOCAL_ROUTE, explicit: false, reason: 'local', reasonCode: 'SAFE_READ_LOCAL' } as const
    expect(enforceRoutePrivacy('privado-local', LOCAL_ROUTE, local, 'bloqueado')).toBe(local)
    const blocked = { route: undefined, explicit: false, reason: 'ja bloqueado', reasonCode: 'LOCAL_BLOCKED' } as const
    expect(enforceRoutePrivacy('privado-local', LOCAL_ROUTE, blocked, 'bloqueado')).toBe(blocked)
    // E os outros perfis nao sao tocados pelo funil.
    expect(enforceRoutePrivacy('equilibrado', LOCAL_ROUTE, forbidden, 'bloqueado')).toBe(forbidden)
    expect(enforceRoutePrivacy('melhor-qualidade', LOCAL_ROUTE, forbidden, 'bloqueado')).toBe(forbidden)
  })
})

function m03(capabilities?: RouteHealthConfig['capabilities']) {
  const repository = new MemoryRepository()
  return {
    repository,
    service: new StudioRouteHealthService(repository, {
      routes: ['ollama', 'omniroute', 'deepseek-official'],
      localRoute: 'ollama', fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash',
      now: () => new Date('2026-09-03T00:00:00.000Z'), createId: () => 'event-1',
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  }
}

describe('M-03 — o que cada rota sabe fazer, e o que ela NÃO diz', () => {
  it('a janela de contexto e o suporte a ferramentas são DECLARADOS, e chegam ao registro', () => {
    const rows = m03({
      ollama: { contextWindowTokens: 8_192, supportsTools: false },
      'deepseek-official': { contextWindowTokens: 128_000, supportsTools: true },
    }).service.list(scope)
    expect(rows.find(row => row.route === 'ollama')).toMatchObject({ context_window_tokens: 8_192, supports_tools: false })
    expect(rows.find(row => row.route === 'deepseek-official')).toMatchObject({ context_window_tokens: 128_000, supports_tools: true })
  })

  it('rota sem declaração fica DESCONHECIDA, e não com zero nem com `false`', () => {
    // Um `0` de janela seria lido como "não cabe nada" e um `false` de
    // ferramentas seria lido como "não aceita". As duas são afirmações que
    // ninguém fez.
    const row = m03().service.list(scope).find(candidate => candidate.route === 'deepseek-official')!
    expect(row.context_window_tokens).toBeUndefined()
    expect(row.supports_tools).toBeUndefined()
  })

  it('declaração parcial traz só o que foi declarado', () => {
    const row = m03({ 'deepseek-official': { supportsTools: true } }).service.list(scope)
      .find(candidate => candidate.route === 'deepseek-official')!
    expect(row.supports_tools).toBe(true)
    expect(row.context_window_tokens).toBeUndefined()
  })

  it('a PRIVACIDADE não é declarada: ela é derivada do mesmo fato que bloqueia', () => {
    // Se fosse configuração, alguém marcaria uma rota externa como local e a
    // tela mentiria sobre para onde o texto da pessoa vai.
    const rows = m03().service.list(scope)
    expect(rows.find(row => row.route === 'ollama')!.privacy).toBe('local')
    expect(rows.find(row => row.route === 'deepseek-official')!.privacy).toBe('externa')
    expect(rows.find(row => row.route === 'omniroute')!.privacy).toBe('externa')
  })

  it('uma declaração NÃO consegue marcar a rota externa como local, nem contrabandeando o campo', () => {
    // O tipo não oferece `privacy`, e este teste passa por baixo do tipo de
    // propósito: se um dia alguém abrir essa porta na configuração, a tela
    // passa a mentir sobre para onde o texto da pessoa vai, e é aqui que isso
    // tem de falhar.
    const smuggled = { 'deepseek-official': { contextWindowTokens: 1, supportsTools: true, privacy: 'local' } } as never
    const rows = m03(smuggled).service.list(scope)
    expect(rows.find(row => row.route === 'deepseek-official')!.privacy).toBe('externa')
    // E o contrário também: a rota local não vira externa por declaração.
    const other = m03({ ollama: { privacy: 'externa' } } as never).service.list(scope)
    expect(other.find(row => row.route === 'ollama')!.privacy).toBe('local')
  })

  it('os fatos sobrevivem a uma requisição registrada, e não somem na gravação', async () => {
    const h = m03({ 'deepseek-official': { contextWindowTokens: 128_000, supportsTools: true } })
    await collect(h.service.streamWithFallback(scope, options,
      () => chunks({ type: 'text-delta', text: 'oi' } as StreamChunk), () => chunks()))
    const stored = [...h.repository.routeMap.values()].find(row => row.route === 'omniroute')
    expect(stored).toMatchObject({ privacy: 'externa', requests: 1 })
    const external = h.service.list(scope).find(row => row.route === 'deepseek-official')!
    expect(external).toMatchObject({ context_window_tokens: 128_000, supports_tools: true })
  })

  it('RETIRAR a declaração LIMPA o valor gravado: desconhecido volta a ser desconhecido', async () => {
    // Sem isto, uma janela declarada por engano continuaria sendo afirmada
    // para sempre — e "desconhecido" é o estado que este requisito insiste em
    // preservar. Só omitir a chave deixaria o valor velho de pé no
    // espalhamento sobre a linha anterior.
    const repository = new MemoryRepository()
    const withDeclaration = new StudioRouteHealthService(repository, {
      routes: ['omniroute'], localRoute: 'ollama', fallbackRoute: 'omniroute', fallbackModel: 'x',
      capabilities: { omniroute: { contextWindowTokens: 64_000, supportsTools: true } },
      now: () => new Date('2026-09-03T00:00:00.000Z'), createId: () => 'event-1',
    })
    await collect(withDeclaration.streamWithFallback(scope, options,
      () => chunks({ type: 'text-delta', text: 'oi' } as StreamChunk), () => chunks()))
    expect([...repository.routeMap.values()][0]!.context_window_tokens).toBe(64_000)

    const withoutDeclaration = new StudioRouteHealthService(repository, {
      routes: ['omniroute'], localRoute: 'ollama', fallbackRoute: 'omniroute', fallbackModel: 'x',
      now: () => new Date('2026-09-03T00:00:00.000Z'), createId: () => 'event-2',
    })
    await collect(withoutDeclaration.streamWithFallback(scope, options,
      () => chunks({ type: 'text-delta', text: 'oi' } as StreamChunk), () => chunks()))
    const after = [...repository.routeMap.values()][0]!
    expect(after.context_window_tokens).toBeUndefined()
    expect(after.supports_tools).toBeUndefined()
  })

  it('uma linha gravada ANTES da declaração passa a carregá-la na requisição seguinte', async () => {
    // Sem isto, declarar a janela de uma rota exigiria migrar linhas.
    const repository = new MemoryRepository()
    const before = new StudioRouteHealthService(repository, {
      routes: ['omniroute'], localRoute: 'ollama', fallbackRoute: 'omniroute', fallbackModel: 'x',
      now: () => new Date('2026-09-03T00:00:00.000Z'), createId: () => 'event-1',
    })
    await collect(before.streamWithFallback(scope, options,
      () => chunks({ type: 'text-delta', text: 'oi' } as StreamChunk), () => chunks()))
    expect([...repository.routeMap.values()][0]!.context_window_tokens).toBeUndefined()

    const after = new StudioRouteHealthService(repository, {
      routes: ['omniroute'], localRoute: 'ollama', fallbackRoute: 'omniroute', fallbackModel: 'x',
      capabilities: { omniroute: { contextWindowTokens: 64_000 } },
      now: () => new Date('2026-09-03T00:00:00.000Z'), createId: () => 'event-2',
    })
    await collect(after.streamWithFallback(scope, options,
      () => chunks({ type: 'text-delta', text: 'oi' } as StreamChunk), () => chunks()))
    expect([...repository.routeMap.values()][0]!.context_window_tokens).toBe(64_000)
  })
})
