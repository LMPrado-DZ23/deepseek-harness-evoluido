/** Isolated Harness Studio PoC plugin over public DeepSeek Harness seams. */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  defineDomain,
  domainTable,
  type Domain,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

export const name = 'studio-hello'
export const inject = ['tools', 'llm', 'storageDomain']

export const STUDIO_PROVIDER = 'studio-fake'
export const STUDIO_MODEL = 'studio-deterministic'
export const STUDIO_TENANT = 'tenant-poc-01'
export const STUDIO_LOGICAL_DOMAIN = 'studio.hello'
export const STUDIO_PHYSICAL_DOMAIN = 'studio_hello'
export const STUDIO_RECORD_KEY = 'primary' as StudioRecordKey
export const STUDIO_CREATED_AT = '2026-09-01T00:00:00.000Z'

declare const studioRecordKeyBrand: unique symbol
export type StudioRecordKey = string & { readonly [studioRecordKeyBrand]: true }

export const studioHelloRecord = z.object({
  tenant_id: z.string().min(1),
  created_at: z.iso.datetime(),
  note: z.string().min(1),
}).strict()

export type StudioHelloRecord = z.infer<typeof studioHelloRecord>

export const studioHelloDomainSpec = defineDomain({
  name: STUDIO_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    records: domainTable<StudioRecordKey, StudioHelloRecord>(studioHelloRecord),
  },
})

export interface StudioHelloRuntime {
  record(key?: StudioRecordKey): StudioHelloRecord | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioHello: StudioHelloRuntime
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(name: 'studio_echo' | 'bash' | 'write', args: object, callId: string): StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function lastUserIndex(options: GenerateOptions): number {
  return options.messages.findLastIndex(message => message.role === 'user'
    && message.content.some(block => block.type === 'text'))
}

function latestUserText(options: GenerateOptions): string {
  const index = lastUserIndex(options)
  if (index < 0) return ''
  return options.messages[index]!.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function latestToolText(options: GenerateOptions): string | undefined {
  const message = options.messages.slice(lastUserIndex(options) + 1)
    .findLast(candidate => candidate.content.some(block => block.type === 'tool-result'))
  const block = message?.content.find(candidate => candidate.type === 'tool-result')
  if (block?.type !== 'tool-result') return undefined
  return block.content.filter(item => item.type === 'text').map(item => item.text).join('')
}

/** Deterministic, keyless provider used only by this PoC. */
export class StudioFakeAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: STUDIO_MODEL, name: 'Studio deterministic model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Studio deterministic model' })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = latestUserText(options)
    const result = latestToolText(options)
    let chunks: StreamChunk[]
    if (prompt.includes('RESTART_PROBE')) {
      const restored = options.messages.some(message => message.content.some(
        block => block.type === 'text' && block.text.includes('STUDIO_ECHO_OK'),
      ))
      chunks = textChunks(`RESTART_OK history_restored=${String(restored)}`)
    } else if (prompt.includes('SANDBOX_ESCAPE_PROBE')) {
      chunks = result === undefined
        ? toolChunks('bash', {
          command: "printf 'escape-must-not-land' > ../studio-sandbox-outside.txt",
          description: 'Attempt a deterministic write immediately outside the Studio workspace; the sandbox must deny it.',
        }, 'studio-sandbox-escape-call')
        : textChunks(`SANDBOX_ESCAPE_RESULT ${result}`)
    } else if (prompt.includes('SANDBOX_PROBE')) {
      chunks = result === undefined
        ? toolChunks('bash', {
          command: "mkdir -p runtime && printf 'sandbox-ok' > runtime/sandbox-inside.txt && cat runtime/sandbox-inside.txt",
          description: 'Write and read a deterministic marker inside the Studio workspace sandbox.',
        }, 'studio-sandbox-call')
        : textChunks(`SANDBOX_OK ${result}`)
    } else if (prompt.includes('PHASE3_WORKTREE_PROBE')) {
      chunks = result === undefined
        ? toolChunks('write', {
          file_path: 'src/poc3a.txt',
          content: 'poc-3a-isolated\n',
        }, 'studio-phase3-worktree-call')
        : textChunks(`PHASE3_WORKTREE_OK ${result}`)
    } else if (prompt.includes('PHASE3_ESCAPE_PROBE')) {
      chunks = result === undefined
        ? toolChunks('write', {
          file_path: '../phase3-outside.txt',
          content: 'must-never-land\n',
        }, 'studio-phase3-escape-call')
        : textChunks(`PHASE3_ESCAPE_BLOCKED ${result}`)
    } else if (prompt.includes('PHASE3_TOOL_DENIAL_PROBE')) {
      chunks = result === undefined
        ? toolChunks('bash', {
          command: "printf 'must-never-run' > src/denied.txt",
          description: 'This tool is deliberately absent from the delegated child catalog.',
        }, 'studio-phase3-tool-denial-call')
        : textChunks(`PHASE3_TOOL_DENIED ${result}`)
    } else {
      chunks = result === undefined
        ? toolChunks('studio_echo', { note: 'PoC-01 deterministic echo' }, 'studio-echo-call')
        : textChunks(`STUDIO_ECHO_OK ${result}`)
    }
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

export function createStudioEchoTool(table: KvTable<StudioRecordKey, StudioHelloRecord>) {
  return defineTool({
    name: 'studio_echo',
    description: 'Persist and echo one tenant-scoped Studio note through the logical studio.hello namespace.',
    parameters: {
      note: { type: 'string', required: true, description: 'Non-empty note to persist and echo.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tenant_id: { type: 'string', required: true },
          created_at: { type: 'string', required: true },
          note: { type: 'string', required: true },
          echoed: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const record: StudioHelloRecord = {
        tenant_id: STUDIO_TENANT,
        created_at: STUDIO_CREATED_AT,
        note: args.note,
      }
      await table.put(STUDIO_RECORD_KEY, record)
      return { ...record, echoed: args.note }
    },
  })
}

/** Mount the tool, fake LLM route, and owned typed storage domain. */
export async function apply(ctx: Context): Promise<void> {
  const domain: Domain<typeof studioHelloDomainSpec> = await ctx.storageDomain.open(studioHelloDomainSpec)
  ctx.effect(() => () => domain.close(), 'studio-hello.domainClose')
  const table = domain.table('records')
  ctx.provide('studioHello', {
    record: (key = STUDIO_RECORD_KEY) => table.get(key),
  })
  ctx.tools.register(createStudioEchoTool(table))
  ctx.llm.registerAdapter([STUDIO_PROVIDER], new StudioFakeAdapter())
}
