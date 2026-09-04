import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StudioRouteHealthService } from '@dz23-studio/route-health'
import { describe, expect, it, vi } from 'vitest'
import { HarnessPromptModel, ModelRouteUnavailableError } from '../src/ports.ts'

const scope = { org_id: 'org-1', tenant_id: 'tenant-1' } as never

function routes(route: string | undefined, reason = 'unavailable'): StudioRouteHealthService {
  return {
    chooseRoute: vi.fn(async () => route === undefined ? { route, reason } : { route, reason: 'healthy' }),
  } as unknown as StudioRouteHealthService
}

function runtime(chunks: readonly StreamChunk[], captured: GenerateOptions[]): LlmRuntime {
  return {
    stream: (options: GenerateOptions) => {
      captured.push(options)
      return (async function* () { for (const chunk of chunks) yield chunk })()
    },
  } as unknown as LlmRuntime
}

describe('HarnessPromptModel route and stream boundaries', () => {
  it('fails before streaming when no healthy route or route model exists', async () => {
    const noRoute = new HarnessPromptModel({ llm: runtime([], []), routes: routes(undefined), modelByRoute: {} })
    await expect(noRoute.complete(scope, 'intake', 'local-only', 'brief')).rejects.toMatchObject({
      code: 'MODEL_ROUTE_UNAVAILABLE', message: 'unavailable',
    })

    const noModel = new HarnessPromptModel({ llm: runtime([], []), routes: routes('local'), modelByRoute: {} })
    await expect(noModel.complete(scope, 'plan', 'any', 'brief')).rejects.toBeInstanceOf(ModelRouteUnavailableError)
  })

  it.each(['error', 'aborted'] as const)('turns a terminal %s finish into a route failure', async kind => {
    const captured: GenerateOptions[] = []
    const model = new HarnessPromptModel({
      llm: runtime([{ type: 'finish', reason: { kind, failure: { code: 'WIRE', message: `${kind}-message` } } } as StreamChunk], captured),
      routes: routes('local'),
      modelByRoute: { local: 'model-1' },
    })
    await expect(model.complete(scope, 'generate', 'any', 'brief')).rejects.toMatchObject({
      code: 'MODEL_ROUTE_UNAVAILABLE', message: `${kind}-message`,
    })
    expect(captured).toHaveLength(1)
  })

  it('assembles text, applies the scope marker, and omits absent usage', async () => {
    const captured: GenerateOptions[] = []
    const markScope = vi.fn((options: GenerateOptions) => ({ ...options, temperature: 0.25 }))
    const model = new HarnessPromptModel({
      llm: runtime([
        { type: 'text-delta', index: 0, text: '  hello ' } as StreamChunk,
        { type: 'text-delta', index: 0, text: 'world  ' } as StreamChunk,
        { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
      ], captured),
      routes: routes('local'),
      modelByRoute: { local: 'model-1' },
      markScope,
    })
    await expect(model.complete(scope, 'generate', 'local-only', 'brief')).resolves.toEqual({
      value: 'hello world', route: 'local', model: 'model-1',
    })
    expect(markScope).toHaveBeenCalledOnce()
    expect(captured[0]).toMatchObject({ provider: 'local', model: 'model-1', temperature: 0.25 })
  })

  it('returns usage only when the provider emitted it', async () => {
    const usage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 } as never
    const model = new HarnessPromptModel({
      llm: runtime([
        { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk,
        { type: 'usage', usage } as StreamChunk,
      ], []),
      routes: routes('external'),
      modelByRoute: { external: 'model-2' },
    })
    await expect(model.complete(scope, 'intake', 'any', 'brief')).resolves.toMatchObject({ usage })
  })
})
