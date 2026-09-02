import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  STUDIO_CREATED_AT,
  STUDIO_MODEL,
  STUDIO_LOGICAL_DOMAIN,
  STUDIO_PHYSICAL_DOMAIN,
  STUDIO_PROVIDER,
  STUDIO_RECORD_KEY,
  STUDIO_TENANT,
  StudioFakeAdapter,
  apply,
  createStudioEchoTool,
  studioHelloDomainSpec,
  type StudioHelloRecord,
  type StudioRecordKey,
} from '../src/index.ts'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'

function options(messages: Message[], signal?: AbortSignal): GenerateOptions {
  return { provider: STUDIO_PROVIDER, model: STUDIO_MODEL, messages, ...(signal === undefined ? {} : { signal }) }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function user(text: string): Message {
  return { id: 'u' as never, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function toolResult(text: string): Message {
  return {
    id: 'r' as never,
    role: 'user',
    source: { kind: 'tool', callId: ToolCallId('call') },
    content: [{ type: 'tool-result', toolCallId: ToolCallId('call'), content: [{ type: 'text', text }] }],
  }
}

describe('@studio/hello', () => {
  it('pins the upstream dotted-domain incompatibility without patching it', () => {
    expect(STUDIO_LOGICAL_DOMAIN).toBe('studio.hello')
    expect(STUDIO_PHYSICAL_DOMAIN).toBe('studio_hello')
    expect(() => defineDomain({ name: STUDIO_LOGICAL_DOMAIN, version: 1, tables: {} }))
      .toThrow("domain name 'studio.hello' must match /^[a-z][a-z0-9_]*$/")
  })

  it('persists and renders the typed studio_echo record', async () => {
    const put = vi.fn<(key: StudioRecordKey, value: StudioHelloRecord) => Promise<void>>().mockResolvedValue()
    const table = { put } as unknown as KvTable<StudioRecordKey, StudioHelloRecord>
    const tool = createStudioEchoTool(table)
    const value = await tool.execute({ note: 'hello' }, {
      callId: ToolCallId('echo'),
      rootCallId: ToolCallId('echo'),
      name: 'studio_echo',
      arguments: { note: 'hello' },
      signal: new AbortController().signal,
    } as never)
    expect(value).toEqual({
      tenant_id: STUDIO_TENANT,
      created_at: STUDIO_CREATED_AT,
      note: 'hello',
      echoed: 'hello',
    })
    expect(put).toHaveBeenCalledWith(STUDIO_RECORD_KEY, {
      tenant_id: STUDIO_TENANT,
      created_at: STUDIO_CREATED_AT,
      note: 'hello',
    })
    expect(tool.output.render({ note: 'hello' }, value as never)).toEqual([
      { type: 'text', text: JSON.stringify(value) },
    ])
  })

  it('streams tool, sandbox, restart, and final responses deterministically', async () => {
    const adapter = new StudioFakeAdapter()
    await expect(adapter.listModels(STUDIO_PROVIDER)).resolves.toEqual([
      { provider: STUDIO_PROVIDER, id: STUDIO_MODEL, name: 'Studio deterministic model' },
    ])
    await expect(adapter.resolveModel(STUDIO_PROVIDER, STUDIO_MODEL)).resolves.toEqual({
      provider: STUDIO_PROVIDER, id: STUDIO_MODEL, name: 'Studio deterministic model',
    })

    const first = await collect(adapter.stream(options([])))
    expect(first.find(chunk => chunk.type === 'tool-call-delta')).toMatchObject({ name: 'studio_echo' })

    const echo = await collect(adapter.stream(options([user('echo'), toolResult('{"echoed":"ok"}')])))
    expect(echo.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'STUDIO_ECHO_OK {"echoed":"ok"}' })

    const sandbox = await collect(adapter.stream(options([user('SANDBOX_PROBE')], new AbortController().signal)))
    expect(sandbox.find(chunk => chunk.type === 'tool-call-delta')).toMatchObject({ name: 'bash' })
    const sandboxDone = await collect(adapter.stream(options([user('SANDBOX_PROBE'), toolResult('sandbox-ok')])))
    expect(sandboxDone.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'SANDBOX_OK sandbox-ok' })

    const restart = await collect(adapter.stream(options([
      user('old'),
      { id: 'a' as never, role: 'assistant', source: { kind: 'model', provider: STUDIO_PROVIDER, model: STUDIO_MODEL }, content: [{ type: 'text', text: 'STUDIO_ECHO_OK old' }] },
      user('RESTART_PROBE'),
    ])))
    expect(restart.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'RESTART_OK history_restored=true' })
  })

  it('mounts the real seams and closes its owned domain', async () => {
    const record: StudioHelloRecord = { tenant_id: STUDIO_TENANT, created_at: STUDIO_CREATED_AT, note: 'saved' }
    const table = { get: vi.fn().mockReturnValue(record) } as unknown as KvTable<StudioRecordKey, StudioHelloRecord>
    const close = vi.fn<() => Promise<void>>().mockResolvedValue()
    const domain = { table: vi.fn().mockReturnValue(table), close } as unknown as Domain<typeof studioHelloDomainSpec>
    const registerTool = vi.fn()
    const registerAdapter = vi.fn()
    const provide = vi.fn()
    let cleanup: (() => Promise<void>) | undefined
    const ctx = {
      storageDomain: { open: vi.fn().mockResolvedValue(domain) },
      tools: { register: registerTool },
      llm: { registerAdapter },
      provide,
      effect: (factory: () => () => Promise<void>) => { cleanup = factory() },
    }
    await apply(ctx as never)
    expect(ctx.storageDomain.open).toHaveBeenCalledWith(studioHelloDomainSpec)
    expect(registerTool).toHaveBeenCalledOnce()
    expect(registerAdapter).toHaveBeenCalledWith([STUDIO_PROVIDER], expect.any(StudioFakeAdapter))
    const runtime = provide.mock.calls[0]?.[1] as { record(): StudioHelloRecord | undefined }
    expect(runtime.record()).toEqual(record)
    await cleanup?.()
    expect(close).toHaveBeenCalledOnce()
  })
})
