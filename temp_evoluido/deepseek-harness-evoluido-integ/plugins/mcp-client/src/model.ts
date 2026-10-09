/**
 * O que este cliente MCP aceita como servidor, como limite e como mensagem.
 *
 * Tudo aqui é declaração e validação pura. As POLÍTICAS de chamada — tempo
 * máximo por chamada, teto por escopo, repetição única, custo e auditoria —
 * NÃO moram aqui: elas já existem em `plugins/integration-hub/src/runtime.ts`
 * e em `callIntegration`. Repeti-las neste plugin criaria dois tetos que um dia
 * discordariam, e o mais frouxo dos dois é o que valeria.
 */
import { z } from 'zod'

/**
 * Versões do protocolo MCP que este Studio sabe falar, da preferida para a mais
 * antiga.
 *
 * A negociação do MCP é: o cliente propõe uma versão no `initialize`, o servidor
 * responde com a que VAI usar — que pode não ser a proposta. Se a resposta não
 * estiver nesta lista, a conexão é recusada em vez de seguir adivinhando o
 * formato das mensagens seguintes.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export type McpProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]

/** Nome de variável de ambiente aceito no ambiente explícito do processo filho. */
export const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * O comando de UM servidor MCP, como quem administra o Studio o declara.
 *
 * `env` é o ambiente COMPLETO do processo filho, e não um acréscimo: o que não
 * estiver aqui não existe lá dentro. É por isso que ele é obrigatório e não tem
 * padrão — um ambiente que "herda o resto" é exatamente por onde um segredo do
 * Studio sai para um programa de terceiro.
 */
export const mcpServerCommandSchema = z.object({
  /** Caminho absoluto do executável. Nunca uma linha de comando: nada aqui passa por interpretador. */
  command: z.string().min(1).refine(value => value.startsWith('/'), 'absolute'),
  args: z.array(z.string().max(4096)).max(32).default([]),
  /** Pasta de trabalho, absoluta e explícita. O filho começa aqui e não onde o Studio por acaso estava. */
  cwd: z.string().min(1).refine(value => value.startsWith('/'), 'absolute'),
  env: z.record(z.string().regex(ENVIRONMENT_NAME), z.string().max(4096)),
}).strict()
export type McpServerCommand = z.infer<typeof mcpServerCommandSchema>

/**
 * Os limites que ESTE plugin tem para si.
 *
 * `handshakeTimeoutMs` e `callTimeoutMs` são tetos de último recurso do
 * processo filho. Dentro do Hub eles NÃO são um segundo teto concorrente: o
 * despachante os deriva de `service.callPolicy.timeoutMs`, e o sinal de
 * desistência do Hub sempre chega antes ou junto. Fora do Hub — num teste, numa
 * ferramenta de linha de comando — eles são o único teto, e é por isso que
 * existem.
 */
export interface McpConnectionLimits {
  /** Tempo máximo do `initialize`. Estourou: o processo é morto, não abandonado. */
  readonly handshakeTimeoutMs: number
  /** Tempo máximo de UMA requisição já conectada. Estourou: o processo é morto. */
  readonly callTimeoutMs: number
  /** Teto de bytes de UMA mensagem do servidor, e do que se acumula sem terminar numa linha. */
  readonly maxMessageBytes: number
  /** Teto de ferramentas anunciadas. Acima disso a conexão é RECUSADA, nunca truncada em silêncio. */
  readonly maxTools: number
  /** Quanto se espera entre o pedido educado de saída (SIGTERM) e o SIGKILL. */
  readonly shutdownGraceMs: number
}

/**
 * O padrão da casa.
 *
 * 256 KiB por mensagem cabe folgadamente num `tools/list` de servidor real (o
 * `server-everything` responde com ~14 KiB) e não deixa um servidor hostil
 * encher a memória do Studio com uma linha que nunca termina. 128 ferramentas é
 * mais do que qualquer servidor honesto anuncia e menos do que um catálogo
 * gerado para cansar quem lê.
 */
export const DEFAULT_MCP_LIMITS: McpConnectionLimits = {
  handshakeTimeoutMs: 5_000,
  callTimeoutMs: 10_000,
  maxMessageBytes: 256 * 1024,
  maxTools: 128,
  shutdownGraceMs: 500,
}

/** Uma resposta JSON-RPC 2.0, na forma mínima que este cliente aceita. */
export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
})
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>

/** Um pedido ou aviso vindo DO servidor. Avisos são ignorados; pedidos recebem "método não existe". */
export const jsonRpcIncomingSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
}).loose()

/** O resultado do `initialize`: só o que este cliente realmente usa. */
export const initializeResultSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  serverInfo: z.object({ name: z.string().min(1), version: z.string().optional() }).loose(),
}).loose()

/** Uma ferramenta anunciada. O esquema de entrada é guardado como veio, sem interpretar. */
export const mcpToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
}).loose()
export type McpTool = z.infer<typeof mcpToolSchema>

export const listToolsResultSchema = z.object({
  tools: z.array(mcpToolSchema),
  nextCursor: z.string().optional(),
}).loose()

/**
 * O resultado de `tools/call`.
 *
 * `isError` é do PROTOCOLO: o servidor executou e a ferramenta falhou. Isso não
 * é a mesma coisa que a chamada ter falhado, e por isso ele volta como dado em
 * vez de virar exceção — quem chamou decide o que fazer com uma ferramenta que
 * respondeu "não deu".
 */
export const callToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().default(false),
}).loose()
export type McpCallToolResult = z.infer<typeof callToolResultSchema>
