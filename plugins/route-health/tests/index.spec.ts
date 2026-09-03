import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { apply, type StudioRouteHealthRuntime } from '../src/index.ts'

function table() {
  const records = new Map<string, unknown>()
  return {
    entries: () => records.entries(),
    put: (key: string, value: unknown) => { records.set(key, value); return Promise.resolve() },
  }
}

describe('@dz23-studio/route-health composition', () => {
  it('mounts observation, tenant scope, protected HTTP and clean teardown', async () => {
    const routes = table()
    const events = table()
    const close = vi.fn(() => Promise.resolve())
    let runtime!: StudioRouteHealthRuntime
    let listener!: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
    let handler!: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    const ctx = {
      storageDomain: { open: vi.fn(() => Promise.resolve({ table: (name: string) => name === 'routes' ? routes : events, close })) },
      effect: vi.fn((factory: () => unknown) => factory()),
      provide: vi.fn((_name: string, value: StudioRouteHealthRuntime) => { runtime = value }),
      llm: {
        listProviders: () => [{ id: 'ollama', name: 'Ollama' }, { id: 'deepseek-official', name: 'DeepSeek' }],
        stream: vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk }),
      },
      studioIdentity: { service: {
        principalForHarnessSession: vi.fn(() => ({ userId: 'u', orgId: 'org', tenantId: 'tenant' })),
        authenticate: vi.fn(() => Promise.resolve({ org_id: 'org', tenant_id: 'tenant' })),
      } },
      on: vi.fn((_name: string, callback: typeof listener) => { listener = callback; return vi.fn() }),
      webServer: { register: vi.fn((route: { handler: typeof handler }) => { handler = route.handler; return vi.fn() }) },
    }
    await apply(ctx as never)
    const options: GenerateOptions = { provider: 'ollama', model: 'qwen', messages: [], sessionId: 'session' as never }
    expect(runtime.markExplicit(options)).toBe(options)
    const output: StreamChunk[] = []
    for await (const chunk of listener(options, () => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })())) output.push(chunk)
    expect(output).toHaveLength(1)
    expect(runtime.service.list({ orgId: 'org', tenantId: 'tenant' })[0]).toMatchObject({ route: 'ollama', requests: 1 })
    expect(ctx.studioIdentity.service.principalForHarnessSession).toHaveBeenCalledWith('session')
    expect(ctx.webServer.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: '/api/studio/routes/health' }))
    expect(handler).toBeTypeOf('function')
    await close()
  })
})
