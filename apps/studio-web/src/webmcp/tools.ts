/**
 * WebMCP — o Studio como PROVEDOR de ferramentas para o agente do navegador.
 *
 * O que é: a partir do Chrome 149 (origin trial) uma página pode registrar
 * ferramentas em `document.modelContext`, e um agente do navegador as descobre
 * e as executa. Quem chama NÃO é o Studio e NÃO é a pessoa: é um programa de
 * terceiro rodando na mesma sessão autenticada dela, com o mesmo cookie.
 *
 * Por isso as três linhas que este arquivo não cruza, decididas no P37
 * (docs/inventory/p37/webmcp.md) antes da primeira linha de código:
 *
 * 1. NENHUMA ferramenta faz o que a interface não faria com a mesma
 *    autorização e a mesma confirmação. Toda ferramenta chama as MESMAS rotas
 *    do produto, com o mesmo cookie e o mesmo CSRF. Não existe caminho
 *    privado: se o servidor recusaria a pessoa, recusa o agente;
 * 2. nenhuma ferramenta toca segredo, publicação, parada de emergência,
 *    remoção, aprovação de plano nem início de geração. Essas são as decisões
 *    da PESSOA, e um agente tomando-as é exatamente o modo de falha que a
 *    arquitetura de confirmação existe para impedir;
 * 3. nada é exposto a origem de terceiro: sem `exposedTo`, o padrão da própria
 *    especificação (mesma origem e agente embutido do navegador) é o teto.
 *
 * E nada disto é registrado sem a pessoa ligar explicitamente.
 */
import t from '../i18n/pt-BR.json'

/** O resultado que a especificação espera de `execute`. */
export interface WebMcpToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly isError?: boolean
}

export interface WebMcpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  execute(args: Readonly<Record<string, unknown>>): Promise<WebMcpToolResult>
}

/** A parte de `document.modelContext` que este código usa. Nada além disto. */
export interface ModelContextLike {
  registerTool(tool: WebMcpToolDescriptor, options?: { signal?: AbortSignal }): Promise<unknown>
}

/**
 * O que as ferramentas precisam do produto: as MESMAS chamadas que a tela faz.
 *
 * É uma porta, e não `api` importado direto, para o teste poder provar que
 * nenhuma ferramenta constrói um caminho próprio — tudo que sai daqui passa
 * por este objeto, e o teste vê cada rota chamada.
 */
export interface StudioPort {
  listProjects(): Promise<readonly { readonly project_id: string; readonly name: string; readonly state: string }[]>
  projectDetails(projectId: string): Promise<{ readonly project: { readonly state: string }; readonly plan?: { readonly slices: readonly { readonly title: string; readonly description: string }[] } | null }>
  createProject(input: { readonly name: string; readonly brief: string }): Promise<{ readonly project_id: string }>
}

/** Texto simples de volta, no formato que a especificação pede. */
export function say(text: string): WebMcpToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * O erro como o agente consegue usar: uma frase que diz o que corrigir.
 *
 * O explicador da especificação é explícito sobre isto — falha de schema faz o
 * agente travar, e mensagem de erro clara faz ele tentar de novo certo. Mas a
 * mensagem sai daqui SEM o que veio do servidor: uma mensagem de erro nossa
 * pode trazer identificador interno, e o agente é terceiro.
 */
export function fail(text: string): WebMcpToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Um campo obrigatório de texto, validado NO CÓDIGO e não só no schema. */
function text(args: Readonly<Record<string, unknown>>, field: string, max: number): string | undefined {
  const value = args[field]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return undefined
  return trimmed
}

export const PROJECT_ID_MAX = 200
export const NAME_MAX = 120
export const BRIEF_MAX = 2_000

/**
 * As ferramentas que o Studio oferece ao agente do navegador.
 *
 * Cinco, e não cinquenta, de propósito: cada ferramenta registrada ocupa a
 * janela de contexto do modelo, e um catálogo grande piora a escolha do agente
 * em vez de melhorar. E, mais importante, cada ferramenta a mais é uma porta a
 * mais aberta a um programa que não é o Studio nem a pessoa.
 * @param port - as chamadas do produto.
 * @returns os descritores, na ordem em que são registrados.
 */
export function studioTools(port: StudioPort): readonly WebMcpToolDescriptor[] {
  const w = t.webmcp.tools
  return [
    {
      name: w.listName,
      description: w.listDescription,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(): Promise<WebMcpToolResult> {
        const projects = await port.listProjects()
        if (projects.length === 0) return say(w.listEmpty)
        return say(projects.map(project => `${project.name} (${project.project_id}): ${project.state}`).join('\n'))
      },
    },
    {
      name: w.stateName,
      description: w.stateDescription,
      inputSchema: {
        type: 'object',
        properties: { project_id: { type: 'string', description: w.stateProjectId } },
        required: ['project_id'], additionalProperties: false,
      },
      async execute(args): Promise<WebMcpToolResult> {
        const projectId = text(args, 'project_id', PROJECT_ID_MAX)
        if (projectId === undefined) return fail(w.needProjectId)
        const details = await port.projectDetails(projectId)
        const plan = details.plan
        const parts = plan == null || plan.slices.length === 0
          ? w.stateNoPlan
          : `${w.statePlanTitle}\n${plan.slices.map(slice => `- ${slice.title}: ${slice.description}`).join('\n')}`
        return say(`${w.stateStage} ${details.project.state}\n${parts}`)
      },
    },
    {
      name: w.createName,
      description: w.createDescription,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: w.createNameField },
          brief: { type: 'string', description: w.createBriefField },
        },
        required: ['name', 'brief'], additionalProperties: false,
      },
      async execute(args): Promise<WebMcpToolResult> {
        const name = text(args, 'name', NAME_MAX)
        const brief = text(args, 'brief', BRIEF_MAX)
        if (name === undefined) return fail(w.needName.replace('{max}', String(NAME_MAX)))
        if (brief === undefined) return fail(w.needBrief.replace('{max}', String(BRIEF_MAX)))
        const created = await port.createProject({ name, brief })
        return say(w.createDone.replace('{id}', created.project_id))
      },
    },
  ]
}

/**
 * Registra as ferramentas quando o navegador oferece a API, e não faz nada
 * quando não oferece.
 *
 * A detecção é de CAPACIDADE e não de versão: `document.modelContext` existe a
 * partir do Chrome 149 sob origin trial, e perguntar pelo número da versão
 * quebraria em todo navegador que passar a oferecer a API depois.
 *
 * O `AbortSignal` é o desligamento: abortá-lo tira as ferramentas do catálogo
 * do agente. É por ele que o botão de desligar funciona de verdade, em vez de
 * só esconder o botão da tela.
 * @param context - o `document.modelContext` do navegador, ou `undefined`.
 * @param port - as chamadas do produto.
 * @param signal - o desligamento.
 * @returns quantas ferramentas foram registradas; `0` quando o navegador não oferece a API.
 */
export async function registerStudioTools(context: ModelContextLike | undefined, port: StudioPort, signal: AbortSignal): Promise<number> {
  if (context === undefined) return 0
  // Já abortado antes de começar: registrar e desregistrar em seguida deixaria
  // as ferramentas visíveis ao agente por um instante, e um instante basta.
  if (signal.aborted) return 0
  const tools = studioTools(port)
  for (const tool of tools) await context.registerTool(tool, { signal })
  return tools.length
}

/** O `document.modelContext` deste navegador, ou `undefined` quando ele não oferece a API. */
export function browserModelContext(scope: { readonly modelContext?: unknown } | undefined): ModelContextLike | undefined {
  const candidate = scope?.modelContext
  if (candidate === null || typeof candidate !== 'object') return undefined
  return typeof (candidate as ModelContextLike).registerTool === 'function' ? candidate as ModelContextLike : undefined
}
