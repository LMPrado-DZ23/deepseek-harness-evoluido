/**
 * O cliente MCP do Studio: apresentação (`initialize`) com negociação de versão,
 * catálogo (`tools/list`) e chamada (`tools/call`), sobre o transporte stdio.
 *
 * Este é o único lugar do Studio que fala MCP. Ele NÃO conhece integração, nem
 * assinatura, nem auditoria: quem decide se esta conexão pode existir é
 * `dispatch.ts`, e quem conta a chamada é o Hub.
 */
import { t } from './i18n.js'
import {
  DEFAULT_MCP_LIMITS, SUPPORTED_PROTOCOL_VERSIONS,
  callToolResultSchema, initializeResultSchema, listToolsResultSchema,
  type McpCallToolResult, type McpConnectionLimits, type McpServerCommand, type McpTool,
} from './model.js'
import { McpError, StdioMcpTransport } from './transport.js'

/** Como este Studio se apresenta ao servidor. Nome fixo: não é telemetria, é identificação de protocolo. */
export const CLIENT_INFO = { name: 'dz23-studio', version: '1' } as const

/** O que se soube do servidor na apresentação. Volta com a chamada para poder ser mostrado e auditado. */
export interface McpServerIdentity {
  readonly protocolVersion: string
  readonly serverName: string
  readonly serverVersion: string | null
}

export interface McpConnection {
  readonly identity: McpServerIdentity
  /** As ferramentas REAIS que o servidor anunciou nesta conexão, dentro do teto. */
  readonly tools: readonly McpTool[]
  /** Chama uma ferramenta anunciada. Uma ferramenta fora da lista é recusada antes de sair daqui. */
  call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallToolResult>
  /** Encerra a conexão e o processo. Idempotente; nunca lança. */
  close(): Promise<void>
  /** O processo do servidor, para quem precise observá-lo de fora. */
  readonly pid: number | undefined
}

/**
 * Abre uma conexão MCP: sobe o processo, faz a apresentação e lê o catálogo.
 *
 * FALHA FECHADA em todo passo: qualquer problema — o processo não subiu, a
 * apresentação estourou o tempo, a versão do protocolo não é conhecida, o
 * catálogo passou do teto — encerra o processo antes de propagar o erro. Não
 * existe caminho neste arquivo que devolva erro deixando processo de pé.
 * @param command - o servidor a iniciar, já validado por quem cadastrou.
 * @param options - tetos desta conexão e o sinal de desistência de quem chamou.
 * @returns a conexão pronta, com a identidade e as ferramentas reais do servidor.
 */
export async function openMcpConnection(
  command: McpServerCommand,
  options: { readonly limits?: Partial<McpConnectionLimits>; readonly signal?: AbortSignal | undefined } = {},
): Promise<McpConnection> {
  const limits: McpConnectionLimits = { ...DEFAULT_MCP_LIMITS, ...options.limits }
  const transport = StdioMcpTransport.start(command, limits)
  try {
    const identity = await handshake(transport, limits, options.signal)
    const tools = await listTools(transport, limits, options.signal)
    const offered = new Set(tools.map(tool => tool.name))
    return {
      identity,
      tools,
      pid: transport.pid,
      async call(tool, args, signal) {
        // A lista anunciada é a fronteira: pedir uma ferramenta que o servidor
        // não ofereceu nesta conexão é erro de quem chamou, e sai daqui sem
        // gastar uma ida ao processo.
        if (!offered.has(tool)) throw new McpError('TOOL_NOT_OFFERED', t('errors.toolNotOffered'))
        const result = await transport.request('tools/call', { name: tool, arguments: args },
          { timeoutMs: limits.callTimeoutMs, signal })
        const parsed = callToolResultSchema.safeParse(result)
        if (!parsed.success) throw new McpError('PROTOCOL_VIOLATION', t('errors.protocolViolation'))
        return parsed.data
      },
      close: () => transport.close(),
    }
  } catch (error) {
    await transport.close()
    throw error
  }
}

/**
 * A apresentação real do MCP, com negociação de versão.
 *
 * O cliente PROPÕE a versão que prefere; o servidor responde com a que vai
 * usar, e ela pode ser outra. Aceitar qualquer resposta seria continuar falando
 * um protocolo que este Studio não sabe interpretar — por isso uma versão fora
 * da lista conhecida encerra a conexão em vez de seguir adiante. O aviso
 * `notifications/initialized` que fecha a apresentação é obrigatório: sem ele,
 * servidores reais recusam as requisições seguintes.
 */
async function handshake(transport: StdioMcpTransport, limits: McpConnectionLimits, signal: AbortSignal | undefined): Promise<McpServerIdentity> {
  const raw = await transport.request('initialize', {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    // Este cliente não anuncia amostragem nem raízes: o que ele não sabe
    // atender, ele não promete. Prometer faria o servidor pedir e esperar.
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, { timeoutMs: limits.handshakeTimeoutMs, signal })
  const parsed = initializeResultSchema.safeParse(raw)
  if (!parsed.success) throw new McpError('PROTOCOL_VIOLATION', t('errors.protocolViolation'))
  const negotiated = parsed.data.protocolVersion
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
    throw new McpError('VERSION_UNSUPPORTED', t('errors.versionUnsupported'))
  }
  transport.notify('notifications/initialized')
  return {
    protocolVersion: negotiated,
    serverName: parsed.data.serverInfo.name,
    serverVersion: parsed.data.serverInfo.version ?? null,
  }
}

/**
 * O catálogo real do servidor, paginado como o protocolo manda.
 *
 * O teto de ferramentas RECUSA, não trunca: um catálogo truncado em silêncio
 * faria o Studio dizer "essa ferramenta não existe" sobre uma ferramenta que
 * existe, e ninguém conseguiria explicar por quê. O mesmo teto fecha o laço de
 * paginação — um servidor que devolve `nextCursor` para sempre para aqui.
 */
async function listTools(transport: StdioMcpTransport, limits: McpConnectionLimits, signal: AbortSignal | undefined): Promise<readonly McpTool[]> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (;;) {
    const raw = await transport.request('tools/list', cursor === undefined ? {} : { cursor },
      { timeoutMs: limits.callTimeoutMs, signal })
    const parsed = listToolsResultSchema.safeParse(raw)
    if (!parsed.success) throw new McpError('PROTOCOL_VIOLATION', t('errors.protocolViolation'))
    tools.push(...parsed.data.tools)
    if (tools.length > limits.maxTools) throw new McpError('TOO_MANY_TOOLS', t('errors.tooManyTools'))
    if (parsed.data.nextCursor === undefined) return tools
    cursor = parsed.data.nextCursor
  }
}
