import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { RouteHealthRecord, RouteSwitchEvent } from '../src/model.ts'
import {
  ROUTE_FAILURE_MESSAGE,
  StudioRouteHealthService,
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
    expect(h.service.chooseRoute(scope, 'T0')).toMatchObject({ route: 'ollama', explicit: false })
    expect(h.service.chooseRoute({ orgId: 'org-2', tenantId: 'tenant-2' }, 'T0')).toMatchObject({ route: 'ollama' })
    expect(h.service.list({ orgId: 'org-2', tenantId: 'tenant-2' })).toHaveLength(3)
    expect(h.service.chooseRoute(scope, 'T2', 'omniroute')).toEqual({
      route: 'omniroute', explicit: true, reason: 'Rota escolhida pela pessoa.',
    })
    expect(h.service.chooseRoute(scope, 'T2')).toMatchObject({ route: 'ollama' })

    await h.service.initialize(scope, new Set())
    expect(h.service.chooseRoute(scope, 'T2')).toMatchObject({ route: 'deepseek-official' })
    expect(h.service.list({ orgId: 'other', tenantId: 'other' }).every(record => record.state === 'NOT_CONFIGURED')).toBe(true)
    expect(h.service.switches(scope)).toEqual([])
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
