/**
 * A ponte entre o registro de integrações do Hub e um servidor MCP real.
 *
 * A assinatura do manifesto responde "este manifesto é AUTÊNTICO". Ela não
 * responde "e este computador concorda em executar este programa" — nenhuma
 * assinatura de terceiro pode responder isso. Por isso existe o catálogo:
 * quem administra o Studio declara, no perfil, qual executável corresponde a
 * cada manifesto. Um manifesto assinado sem servidor cadastrado é RECUSADO, e a
 * recusa é auditada pelo Hub como qualquer outra.
 *
 * Este arquivo não tem tempo máximo de chamada próprio, nem teto por escopo, nem
 * repetição, nem custo: tudo isso é de `callIntegration`. Os tetos do processo
 * filho são derivados do teto do Hub em `mcpLimitsFromCallPolicy`, para que não
 * exista um segundo número capaz de discordar do primeiro.
 */
import type { IntegrationCallPolicy, McpCallOutcome, McpDispatchInput, McpDispatchPort, McpProbeInput, McpProbeOutcome } from '@dz23-studio/integration-hub'
import { t } from './i18n.js'
import { openMcpConnection } from './client.js'
import { DEFAULT_MCP_LIMITS, mcpServerCommandSchema, type McpConnectionLimits, type McpServerCommand } from './model.js'
import { McpError } from './transport.js'

/** Os servidores que ESTE computador concorda em executar, por `id` de manifesto. */
export type McpServerCatalog = Readonly<Record<string, McpServerCommand>>

export class McpCatalogError extends Error {
  constructor(readonly code: 'COMMAND_INVALID', message: string) {
    super(message)
    this.name = 'McpCatalogError'
  }
}

/**
 * Valida o catálogo declarado no perfil, de uma vez, na montagem do plugin.
 *
 * Falhar aqui derruba a montagem, e é o que se quer: um cadastro torto
 * descoberto na primeira chamada apareceria como "a integração falhou" para
 * quem estivesse usando o Studio, e não como "o perfil está errado" para quem
 * pode consertar.
 * @param declared - o mapa `id do manifesto` → comando, como veio do perfil.
 * @returns o catálogo validado, sem protótipo herdado.
 */
export function parseServerCatalog(declared: Readonly<Record<string, unknown>>): McpServerCatalog {
  const catalog: Record<string, McpServerCommand> = Object.create(null) as Record<string, McpServerCommand>
  for (const id of Object.keys(declared)) {
    const parsed = mcpServerCommandSchema.safeParse(declared[id])
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))].join(', ')
      throw new McpCatalogError('COMMAND_INVALID', t('errors.commandInvalid', { detail: `${id}: ${fields}` }))
    }
    catalog[id] = parsed.data
  }
  return catalog
}

/**
 * Os tetos do processo filho, derivados do teto de chamada do Hub.
 *
 * UMA fonte para o tempo: o Hub. A apresentação recebe metade do orçamento
 * porque ela precisa acabar bem antes da chamada — um servidor que demora todo
 * o tempo só para se apresentar não vai responder nada dentro do prazo, e é
 * melhor descobrir isso com o processo já morto e o Hub ainda com folga para
 * registrar o desfecho.
 * @param policy - a política de chamada em vigor no Hub.
 * @param overrides - o que o perfil ajustou (tamanho de mensagem, número de ferramentas).
 * @returns os tetos desta conexão.
 */
export function mcpLimitsFromCallPolicy(policy: IntegrationCallPolicy, overrides: Partial<McpConnectionLimits> = {}): McpConnectionLimits {
  return {
    ...DEFAULT_MCP_LIMITS,
    handshakeTimeoutMs: Math.max(1, Math.floor(policy.timeoutMs / 2)),
    callTimeoutMs: policy.timeoutMs,
    ...overrides,
  }
}

/**
 * O despachante que o Hub chama quando uma integração do tipo `mcp` é acionada.
 *
 * UM processo por chamada, encerrado no `finally`. Manter conexões vivas entre
 * chamadas seria mais rápido e traria de volta o problema que este plugin
 * existe para não ter: processo de terceiro de pé no computador de alguém sem
 * ninguém olhando, guardando estado entre pessoas e entre espaços de trabalho.
 * @param options - o catálogo declarado e os tetos desta montagem.
 * @returns o despachante, pronto para ser instalado no Hub.
 */
export function createMcpDispatcher(options: {
  readonly catalog: McpServerCatalog
  readonly limits: () => McpConnectionLimits
}): McpDispatchPort {
  return {
    /**
     * O teste de conexão (X-04): sobe o servidor, cumprimenta, lê o catálogo e
     * FECHA — sem chamar ferramenta nenhuma.
     *
     * `openMcpConnection` já faz exatamente esses três passos, e a conexão é
     * fechada no `finally` pelo mesmo motivo do `call`: um aperto de mão que
     * estourou o tempo ou foi abandonado é justamente o caso em que um processo
     * de terceiro ficaria de pé no computador de alguém.
     * @param input - qual servidor e até quando esperar.
     * @returns quem respondeu e o que ele anunciou.
     */
    async probe(input: McpProbeInput): Promise<McpProbeOutcome> {
      const command = Object.hasOwn(options.catalog, input.manifest.id) ? options.catalog[input.manifest.id] : undefined
      if (command === undefined) throw new McpError('SPAWN_FAILED', t('errors.serverNotRegistered'))
      const connection = await openMcpConnection(command, { limits: options.limits(), signal: input.signal })
      try {
        return {
          protocolVersion: connection.identity.protocolVersion,
          serverName: connection.identity.serverName,
          tools: connection.tools.map(tool => tool.name),
        }
      } finally {
        await connection.close()
      }
    },
    async call(input: McpDispatchInput): Promise<McpCallOutcome> {
      const command = Object.hasOwn(options.catalog, input.manifest.id) ? options.catalog[input.manifest.id] : undefined
      if (command === undefined) throw new McpError('SPAWN_FAILED', t('errors.serverNotRegistered'))
      const connection = await openMcpConnection(command, { limits: options.limits(), signal: input.signal })
      try {
        const result = await connection.call(input.tool, input.arguments, input.signal)
        return {
          protocolVersion: connection.identity.protocolVersion,
          serverName: connection.identity.serverName,
          tools: connection.tools.map(tool => tool.name),
          content: result.content.map(item => (item.text === undefined ? { type: item.type } : { type: item.type, text: item.text })),
          isError: result.isError,
        }
      } finally {
        // No `finally` e não no caminho feliz: uma chamada que estourou o tempo,
        // que foi abandonada pelo botão de emergência ou que explodiu no meio
        // é exatamente o caso em que um processo ficaria para trás.
        await connection.close()
      }
    },
  }
}
