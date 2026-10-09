import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { HubActor, IntegrationCallResult, IntegrationHubService, McpCallOutcome, McpProbeOutcome } from '@dz23-studio/integration-hub'
import { t } from './i18n.js'

/**
 * Os CONECTORES dentro da conversa do agente geral.
 *
 * Três ferramentas, e nenhuma autoridade nova: todas passam pelo Hub, que já
 * confere assinatura do manifesto, parada de emergência, desligamento por
 * alcance, teto, custo e auditoria (`callMcpTool`/`mcpTools`). O que estas
 * ferramentas acrescentam é só a PORTA para o agente — e a política do perfil
 * dá a cada uma o seu nível: listar é T0, perguntar as ferramentas de um
 * servidor é T1 (sobe o processo, não executa nada), chamar é T2 (a pessoa
 * confirma na conversa).
 */

/** Quem está pedindo, resolvido a partir do agente da conversa. */
export type ResolverAtor = (agent: unknown) => HubActor | undefined

/** O teto do texto que volta ao modelo por chamada. */
export const MAXIMO_DO_RESULTADO = 16_000

const saidaJson = {
  schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string', required: true } } },
  render: (_args: unknown, value: { readonly json: string }) => [{ type: 'text' as const, text: value.json }],
} as const

function ator(resolver: ResolverAtor, agent: unknown): HubActor {
  const encontrado = resolver(agent)
  if (encontrado === undefined) throw new Error(t('agente.semDono'))
  return encontrado
}

/**
 * O desfecho de uma chamada do Hub, como o agente o lê.
 * @param resultado - o que o Hub devolveu.
 * @param valor - o que extrair do sucesso.
 * @returns o texto JSON.
 */
export function desfechoParaOAgente<T>(resultado: IntegrationCallResult<T>, valor: (ok: T) => unknown): string {
  if (resultado.state !== 'OK') return JSON.stringify({ ok: false, estado: resultado.state, motivo: resultado.message })
  const texto = JSON.stringify({ ok: true, ...valor(resultado.value) as object })
  return texto.length > MAXIMO_DO_RESULTADO ? texto.slice(0, MAXIMO_DO_RESULTADO - 1) + '\u2026' : texto
}

/**
 * As três ferramentas.
 * @param hub - o Hub de integrações.
 * @param resolver - quem é o dono do agente.
 * @returns as definições.
 */
export function ferramentasDeConector(hub: Pick<IntegrationHubService, 'list' | 'mcpTools' | 'callMcpTool'>, resolver: ResolverAtor): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'studio_connector_list',
      description: t('agente.listar'),
      parameters: {},
      output: saidaJson,
      async execute(_args, exec) {
        const lista = await hub.list(ator(resolver, exec.agent))
        const ligados = lista.filter(item => item.kind === 'mcp' && item.enabled)
          .map(item => ({ integration_id: item.integration_id, name: item.name }))
        return { json: JSON.stringify({ conectores: ligados, ...(ligados.length === 0 ? { aviso: t('agente.nenhum') } : {}) }) }
      },
    }),
    defineTool({
      name: 'studio_connector_tools',
      description: t('agente.ferramentas'),
      parameters: { integration_id: { type: 'string', required: true, description: t('agente.idDoConector') } },
      output: saidaJson,
      async execute(args, exec) {
        const resultado = await hub.mcpTools(ator(resolver, exec.agent), args.integration_id)
        return { json: desfechoParaOAgente<McpProbeOutcome>(resultado, ok => ({ servidor: ok.serverName, ferramentas: ok.tools })) }
      },
    }),
    defineTool({
      name: 'studio_connector_call',
      description: t('agente.chamar'),
      parameters: {
        integration_id: { type: 'string', required: true, description: t('agente.idDoConector') },
        tool: { type: 'string', required: true, description: t('agente.nomeDaFerramenta') },
        arguments: { type: 'object', additionalProperties: true, description: t('agente.argumentos') },
      },
      output: saidaJson,
      async execute(args, exec) {
        const resultado = await hub.callMcpTool(ator(resolver, exec.agent), args.integration_id, {
          tool: args.tool,
          arguments: (args.arguments ?? {}) as Readonly<Record<string, unknown>>,
          // Na dúvida, NÃO é seguro repetir: o Hub só repete o que foi declarado assim.
          idempotent: false,
        })
        return { json: desfechoParaOAgente<McpCallOutcome>(resultado, ok => ({
          servidor: ok.serverName, erro_da_ferramenta: ok.isError,
          conteudo: ok.content.map(item => item.text ?? `[${item.type}]`).join('\n'),
        })) }
      },
    }),
  ]
}
