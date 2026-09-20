import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  authenticatedMutation,
  IdentityError,
  assertRequestTrust,
  singleHeader,
  type StudioIdentityService,
} from '@dz23-studio/identity'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { TenancyError, type StudioTenancyService } from '@dz23-studio/tenancy'
import { z } from 'zod'
import { designSelectionSchema } from './design.js'
import { t } from './i18n.js'
import { pedidosDeRevisao } from './revision.js'
import { intakeAnswerSchema, nextIntakeQuestion, type IntakeConversation, type IntakeEngine } from './intake.js'
import { respostasDoQuestionario } from './pergunta.js'
import { PERGUNTAS_DA_LEITURA, respostasLidas, type PerguntaDaLeitura } from './leitura.js'
import { ModelRouteUnavailableError } from './ports.js'
import type { CodeGeneratorPort } from './pipeline.js'
import type { EmergencyStopGuard, PromptToAppJobService } from './jobs.js'
import { RUN_REPORT_FILE } from './run-report.js'
import { CABECALHO_DA_ESPERA, OperacoesLongas, RespostaCapturada, pedidoRelido } from './operacoes-longas.js'
import { FonteNaoServida, conteudoQueCabe, fonteAServir } from './fonte-do-artefato.js'
import { FormCategoryCapabilityError, type PlannerCodeContext, type PlannerEngine } from './planner.js'
import { consultedView } from './plan-consulted.js'
import { routePrivacySchema } from '@dz23-studio/route-health'
import { studioProjectCategorySchema, type StudioIntakeTurn } from './model.js'
import type { LogoProcessorPort } from './logo.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from './service.js'
import { planEditSchema } from './plan-edit.js'
import { InvalidTransitionError, UndoNotAvailableError } from './state.js'

const JSON_LIMIT = 64 * 1024
const LOGO_LIMIT = 2 * 1024 * 1024
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  original_brief: z.string().trim().min(10).max(10_000),
  category: studioProjectCategorySchema,
  privacy: routePrivacySchema,
  /**
   * O identificador da INTENÇÃO de envio.
   *
   * Opcional no contrato porque um cliente antigo não pode deixar de criar
   * tarefa de um dia para o outro; a interface deste produto manda sempre. Sem
   * ele, o reenvio depois de um tempo esgotado cria a segunda tarefa — que é o
   * defeito que ele existe para fechar.
   */
  request_key: z.string().trim().min(16).max(128).optional(),
}).strict()
const answerSchema = intakeAnswerSchema.extend({
  confirm_sensitive: z.boolean().optional(),
  request_key: z.string().min(1).max(200).optional(),
}).strict()
const correctionSchema = z.object({
  question_id: z.enum(PERGUNTAS_DA_LEITURA),
  answer: z.string().trim().min(1).max(2_000),
  request_key: z.string().min(1).max(200).optional(),
}).strict()
const changeRequestSchema = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict()
const changeRequestComChaveSchema = changeRequestSchema.extend({
  request_key: z.string().min(1).max(200).optional(),
}).strict()
/*
  `request_key` e OPCIONAL nos dois envios, e e a identidade da INTENCAO.

  Ela nao e credencial: o escopo de quem pede entra na chave de armazenamento e
  a reserva e reconferida contra o ator. O que ela faz e impedir que a mesma
  intencao — reenviada depois de a resposta se perder, ou mandada de duas abas
  ao mesmo tempo — produza dois efeitos.
*/
const chaveDeEnvio = z.string().min(16).max(128).optional()
const planEditComChaveSchema = planEditSchema.extend({ request_key: chaveDeEnvio }).strict()
const planSliceComChaveSchema = changeRequestSchema.extend({
  request_key: chaveDeEnvio,
  base_revision: z.number().int().positive().optional(),
}).strict()
const reviseSchema = z.object({ request: z.string().min(1).max(2_000), request_key: chaveDeEnvio }).strict()
const perguntaSchema = z.object({ question: z.string().min(1).max(2_000), request_key: chaveDeEnvio }).strict()
const undoSchema = z.object({ run_id: z.string().trim().min(1).max(96) }).strict()

export interface PromptToAppHttpExtensionRequest {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly actor: PromptToAppActor
  readonly projectId: string
  readonly suffix: string
}

export type PromptToAppHttpExtension = (input: PromptToAppHttpExtensionRequest) => Promise<boolean>
const HTTP_EXTENSIONS = new Set<PromptToAppHttpExtension>()

/** Registers a Studio-owned vertical slice without adding another `/api/studio/apps` authority. */
export function registerPromptToAppHttpExtension(extension: PromptToAppHttpExtension): () => void {
  HTTP_EXTENSIONS.add(extension)
  return () => { HTTP_EXTENSIONS.delete(extension) }
}

/**
 * O mesmo pedido de uma fatia, mas de uma rota que NÃO pertence a um projeto.
 *
 * A extensão de projeto exige `projectId` porque toda rota dela vive debaixo de
 * um projeto. Existe fatia cujo assunto é o espaço de trabalho inteiro - a
 * parada de emergência é o exemplo: ela vale para `org_id:tenant_id`, e forçá-la
 * a se pendurar em um projeto qualquer inventaria um dono que ela não tem.
 */
export interface PromptToAppWorkspaceHttpExtensionRequest {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly actor: PromptToAppActor
  readonly suffix: string
}

export type PromptToAppWorkspaceHttpExtension = (input: PromptToAppWorkspaceHttpExtensionRequest) => Promise<boolean>
const WORKSPACE_HTTP_EXTENSIONS = new Set<PromptToAppWorkspaceHttpExtension>()

/**
 * Registers a workspace-scoped slice under the same `/api/studio/apps`
 * authority: authentication, CSRF and role resolution stay in the core, and the
 * slice only owns its own suffix grammar.
 */
export function registerPromptToAppWorkspaceHttpExtension(extension: PromptToAppWorkspaceHttpExtension): () => void {
  WORKSPACE_HTTP_EXTENSIONS.add(extension)
  return () => { WORKSPACE_HTTP_EXTENSIONS.delete(extension) }
}

export interface StudioAppsHealth {
  readonly state: 'OK' | 'ATTENTION'
  readonly route: string | null
  /**
   * POR QUE esta rota, em uma frase.
   *
   * O motivo era calculado a cada escolha e jogado fora: nenhuma tela lia o
   * endereço de saúde, e a pessoa via o NOME da rota sem nunca saber se era a
   * local por preferência, a direta por falta de rota saudável, ou a que ela
   * mesma escolheu. `null` quando não há rota, e aí a frase de privacidade é
   * que explica.
   */
  readonly route_reason: string | null
  /** O mesmo motivo em código estável, para a tela traduzir sem casar texto. */
  readonly route_reason_code: string
  /**
   * O NOME da rota em uso, para a pessoa ("Mistral (chave)"), e não o
   * identificador interno (`chave-mistral`) que a tela mostrava na frase de
   * privacidade. `null` junto com `route`.
   */
  readonly route_name?: string | null
  /**
   * A rota da IA local, quando o perfil `privado-local` consegue usá-la.
   *
   * `null` diz que esse perfil está BLOQUEADO agora - a tela precisa disso para
   * avisar antes, e não deixar a pessoa apertar "continuar" para descobrir
   * depois que nada podia ser criado. Ausente é diferente de `null`: servidor
   * que não conhece o campo não sabe responder, e inventar um bloqueio a partir
   * de silêncio seria tão errado quanto esconder um.
   */
  readonly local_route?: string | null
  /**
   * O que esta instalacao consegue de fato fazer AGORA (T-22).
   *
   * Os tres campos acima respondem "a rota esta boa?", "o construtor
   * respondeu?", "tem disco?" — e nenhum deles responde a pergunta que a pessoa
   * realmente faz, que e se ela consegue CRIAR UM APLICATIVO. Este bloco
   * responde essa, e responde DERIVANDO de sinais medidos, nunca declarando.
   *
   * OPCIONAL: um servidor que nao conhece o campo nao sabe responder, e a tela
   * tem de saber a diferenca entre "nao consegue" e "nao perguntei".
   */
  readonly capabilities?: readonly {
    readonly id: string
    readonly state: 'UNKNOWN' | 'ABSENT' | 'PRESENT' | 'CONFIGURED' | 'OPERATIONAL'
    readonly reason?: string
    readonly blocked_by?: string
  }[]
  readonly builder: 'OK' | 'BLOCKED_EXTERNAL'
  readonly disk: 'OK' | 'ATTENTION'
}

export const PROMPT_TO_APP_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/health', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  /*
    O USO do espaço de trabalho — tokens, custo medido, chamadas não
    precificadas e o veredito do teto, por rota.

    `project.read`, e não uma permissão nova: quem pode ver as tarefas do
    espaço já vê o que elas consumiram no painel de cada uma. Esta rota mostra o
    MESMO consumo somado, lido da MESMA autoridade — o adendo proíbe um segundo
    contador, e não há nenhum aqui.
  */
  { method: 'GET', path: '/usage', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  /*
    TUDO o que este espaço guardou, para a pessoa levar consigo.

    `project.read`, e não uma permissão nova: ela devolve exatamente o que quem
    já pode ler as tarefas consegue ver abrindo uma por uma. O que ela poupa é o
    trabalho, e não a autorização.
  */
  { method: 'GET', path: '/export', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'GET', path: '/projects', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/projects', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'GET', path: '/projects/:projectId', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'GET', path: '/projects/:projectId/report', access: 'authorized', permission: 'project.read', scope: 'project' },
  /*
    O CÓDIGO de UM arquivo da versão mais recente.

    `project.read`, e não uma permissão nova: quem pode ler a tarefa já vê o
    nome, o tamanho e o autor de cada arquivo no relato — esta rota mostra o
    conteúdo do mesmo arquivo, para a mesma pessoa, com a mesma autoridade.

    O que pode ser lido vem do RELATO daquela tentativa, e não de uma
    conferência de caminho; `fonte-do-artefato.ts` explica por quê.
  */
  { method: 'GET', path: '/projects/:projectId/source', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/intake/answer', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/intake/correct', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/design', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/design/logo', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/approve', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/change', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/revise', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/ask', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/edit', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/slice', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/generate', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/generate/cancel', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'GET', path: '/projects/:projectId/checkpoints', access: 'authorized', permission: 'project.read', scope: 'project' },
  // O resultado de uma operação longa (`operacoes-longas.ts`): só LÊ, e só o dono.
  { method: 'GET', path: '/projects/:projectId/operation', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/undo', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'DELETE', path: '/projects/:projectId', access: 'authorized', permission: 'project.delete', scope: 'project' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(PROMPT_TO_APP_ROUTE_CONTRACTS)

/**
 * A expressão que reconhece um caminho de projeto, DERIVADA do contrato.
 *
 * Ela era escrita à mão, com os sufixos repetidos um a um, e as duas listas
 * discordaram em silêncio: `POST /projects/:projectId/revise` entrou no
 * contrato, ganhou tratamento no despachante e respondeu 404 porque o sufixo
 * não fora copiado para cá. Um teste que conferisse as duas listas ainda
 * deixaria duas listas; derivar uma da outra deixa UMA.
 *
 * Os sufixos vão do mais longo para o mais curto porque a alternância do regex
 * para no primeiro que casa: com `/plan` antes de `/plan/approve`, aprovar
 * plano viraria "sufixo /plan com lixo depois" e deixaria de casar.
 */
/**
 * Monta a expressão que reconhece um caminho de projeto, a partir dos sufixos.
 *
 * A ORDEM DOS SUFIXOS NÃO IMPORTA, e isto foi MEDIDO, não suposto. A primeira
 * versão ordenava do mais longo para o mais curto, com um comentário dizendo
 * que `/plan` antes de `/plan/approve` quebraria aprovar plano. A sabotagem que
 * removeu a ordenação sobreviveu — e sobreviveu porque a afirmação estava
 * errada: a alternância do regex RETROCEDE. Casar `/plan` deixa `/approve`
 * sobrando, a âncora `$` falha, e o motor volta para tentar a alternativa
 * seguinte até uma delas fechar o caminho inteiro. Como os sufixos são
 * distintos e a expressão é ancorada nas duas pontas, no máximo uma fecha.
 *
 * A ordenação saiu em vez de ganhar um teste, porque não havia comportamento
 * para testar: ela era código morto com um comentário convincente, que é pior
 * do que nenhum dos dois.
 * @param sufixos - os sufixos declarados, em qualquer ordem.
 * @returns a expressão, com o projeto no grupo 1 e o sufixo no grupo 2.
 */
export function expressaoDeRota(sufixos: readonly string[]): RegExp {
  const alternativa = [...new Set(sufixos)]
    .filter(sufixo => sufixo !== '')
    .map(sufixo => sufixo.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|')
  return new RegExp(`^/projects/([^/]+)(${alternativa})?$`, 'u')
}

/**
 * A expressão que reconhece um caminho de projeto, DERIVADA do contrato.
 *
 * Ela era escrita à mão, com os sufixos repetidos um a um, e as duas listas
 * discordaram em silêncio: `POST /projects/:projectId/revise` entrou no
 * contrato, ganhou tratamento no despachante e respondeu 404 porque o sufixo
 * não fora copiado para cá. Um teste que conferisse as duas listas ainda
 * deixaria duas listas; derivar uma da outra deixa UMA.
 */
const ROTA_DE_PROJETO = expressaoDeRota(PROMPT_TO_APP_ROUTE_CONTRACTS
  .filter(rota => rota.path.startsWith('/projects/:projectId'))
  .map(rota => rota.path.slice('/projects/:projectId'.length)))

export interface PromptToAppHttpConfig {
  readonly service: PromptToAppService
  readonly identity: StudioIdentityService
  readonly tenancy: StudioTenancyService
  readonly intake: IntakeEngine
  readonly planner: PlannerEngine
  readonly jobs: PromptToAppJobService
  readonly logos: LogoProcessorPort
  readonly generatorFor: (actor: PromptToAppActor, projectId: string) => CodeGeneratorPort
  readonly health: (actor: PromptToAppActor) => Promise<StudioAppsHealth>
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  /** Ausente = nenhum botão de emergência montado neste perfil, e nada a perguntar. */
  readonly emergencyStop?: EmergencyStopGuard
  /**
   * Lê o código que JÁ existe, para planejar uma MUDANÇA sabendo o que há.
   *
   * OPCIONAL, e a ausência é honesta: um perfil que não monta isto planeja
   * mudança sem inventário, exatamente como antes. O que ele NÃO faz é
   * planejar com um inventário vazio, que seria afirmar que o aplicativo não
   * tem nada.
   *
   * Devolve `undefined` quando não há execução da qual ler — projeto que nunca
   * gerou nada não tem código, e isso não é uma leitura falhada.
   */
  readonly codeContext?: (actor: PromptToAppActor, projectId: string) => Promise<PlannerCodeContext | undefined>
  /**
   * O uso e o custo do espaço de trabalho, lidos de quem já os grava.
   *
   * OPCIONAL: um perfil sem `route-health` não tem o que responder, e a rota
   * diz `measured: false` em vez de devolver zeros que seriam lidos como
   * "não gastou nada".
   */
  readonly usage?: (actor: PromptToAppActor) => StudioWorkspaceUsage
  /** As operações longas; ausente, uma instância do processo. */
  readonly operacoes?: OperacoesLongas
}

/** O consumo somado do espaço de trabalho, como a rota o devolve. */
export interface StudioWorkspaceUsage {
  readonly routes: readonly {
    readonly route: string
    readonly requests: number
    readonly input_tokens: number
    readonly output_tokens: number
    readonly estimated_cost_usd: number
    readonly unpriced_requests: number
  }[]
  readonly budget: {
    readonly measuredCostUsd: number
    readonly unpricedRequests: number
    readonly verdict: string
  }
}

export function createPromptToAppHttpHandler(config: PromptToAppHttpConfig) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertRequestTrust(request, config)
      const path = new URL(request.url ?? '/', 'http://local').pathname
      const route = path.slice('/api/studio/apps'.length)
      const matched = matchRoute(request.method, route)
      // The core authenticates every extension request, but each extension owns
      // its exact suffix grammar. This prevents a second route list from drifting.
      const extension = matched === undefined ? /^\/projects\/([^/]+)(\/.+)$/u.exec(route) : null
      const actor = await authenticatedActor(request, config, response)
      if (matched === undefined && extension === null) {
        // Uma rota que não é de projeto ainda pode pertencer a uma fatia de
        // espaço de trabalho. Ela é oferecida DEPOIS da autenticação, pelo mesmo
        // motivo das de projeto: quem decide quem é a pessoa é o núcleo, não a
        // fatia. Ninguém reivindicando, continua sendo 404.
        for (const handler of WORKSPACE_HTTP_EXTENSIONS) {
          if (await handler({ request, response, actor, suffix: route })) return
        }
        return json(response, 404, { error: t('errors.routeNotFound') })
      }
      if (extension !== null) {
        const input: PromptToAppHttpExtensionRequest = {
          request, response, actor,
          projectId: decodeURIComponent(extension[1]!), suffix: extension[2]!,
        }
        for (const handler of HTTP_EXTENSIONS) {
          if (await handler(input)) return
        }
        return json(response, 404, { error: t('errors.routeNotFound') })
      }
      if (matched === undefined) return json(response, 404, { error: t('errors.routeNotFound') })

      /*
        A espera LONGA (ver `operacoes-longas.ts`): as rotas que esperam o
        modelo respondem 202 com um identificador quando o cliente sabe
        perguntar pelo resultado depois. O trabalho é o MESMO `atender`, numa
        resposta capturada — o resultado não tem como divergir do síncrono.
      */
      if (esperaLonga(request, matched) && matched.projectId !== undefined) {
        const relido = await pedidoRelido(request)
        const dono = { orgId: actor.orgId, tenantId: actor.tenantId, userId: actor.userId ?? '', projectId: matched.projectId }
        const operacoes = config.operacoes ?? OPERACOES_PADRAO
        const id = operacoes.iniciar(dono, async () => {
          const capturada = new RespostaCapturada()
          await atender(config, relido, capturada.comoResposta(), actor, matched, route)
          return capturada.resultado()
        })
        return json(response, 202, { operacao_pendente: id })
      }
      if (request.method === 'GET' && matched.suffix === '/operation' && matched.projectId !== undefined) {
        const id = new URL(request.url ?? '/', 'http://local').searchParams.get('id') ?? ''
        const dono = { orgId: actor.orgId, tenantId: actor.tenantId, userId: actor.userId ?? '', projectId: matched.projectId }
        const estado = (config.operacoes ?? OPERACOES_PADRAO).consultar(dono, id)
        if (estado === undefined) return json(response, 404, { error: t('errors.operacaoDesconhecida') })
        return json(response, 200, estado)
      }
      return await atender(config, request, response, actor, matched, route)
    } catch (error) {
      return json(response, statusOf(error), { error: error instanceof Error ? error.message : t('errors.invalidRequest') })
    }
  }
}

/** As rotas que esperam o modelo e aceitam a espera longa. */
export const ROTAS_DE_ESPERA_LONGA: ReadonlySet<string> = new Set(['/intake/answer', '/intake/correct', '/plan', '/plan/slice', '/revise', '/ask'])

/**
 * O pedido vai pela espera longa?
 * @param request - o pedido.
 * @param matched - a rota reconhecida.
 * @returns se sim.
 */
export function esperaLonga(request: IncomingMessage, matched: { readonly projectId?: string; readonly suffix: string }): boolean {
  return request.method === 'POST' && matched.projectId !== undefined && ROTAS_DE_ESPERA_LONGA.has(matched.suffix)
    && singleHeader(request.headers[CABECALHO_DA_ESPERA]) === 'longa'
}

const OPERACOES_PADRAO = new OperacoesLongas()

async function atender(
  config: PromptToAppHttpConfig, request: IncomingMessage, response: ServerResponse,
  actor: PromptToAppActor, matched: { readonly projectId?: string; readonly suffix: string }, route: string,
): Promise<void> {
    try {
      if (request.method === 'GET' && route === '/health') return json(response, 200, await config.health(actor))
      if (request.method === 'GET' && route === '/export') {
        /*
          O cabeçalho de ANEXO faz o navegador salvar em vez de desenhar.

          Sem ele, um JSON de espaço inteiro abriria dentro da aba e a pessoa
          teria de salvar à mão — e o nome do arquivo carrega a data, para duas
          exportações não se sobrescreverem na pasta de downloads.
        */
        const conteudo = await config.service.exportWorkspace(actor)
        const nome = `dz23-studio-${conteudo.exported_at.slice(0, 10)}.json`
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${nome}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        response.end(JSON.stringify(conteudo, null, 2))
        return
      }
      if (request.method === 'GET' && route === '/usage') {
        config.service.assertAuthorized(actor, 'project.read')
        // Um Studio montado sem `route-health` responde a AUSÊNCIA, e não um
        // zero: dizer "custou zero" sobre o que não foi medido é exatamente o
        // que o adendo proíbe.
        return json(response, 200, config.usage === undefined ? { measured: false } : { measured: true, ...config.usage(actor) })
      }
      if (request.method === 'GET' && route === '/projects') return json(response, 200, { projects: config.service.listProjects(actor) })
      if (request.method === 'POST' && route === '/projects') {
        const { request_key: requestKey, ...input } = createProjectSchema.parse(await readJson(request))
        const project = await config.service.createProject(actor, input, requestKey)
        return json(response, 201, { project, next: nextIntakeQuestion({ project, answers: {} }) })
      }

      const projectId = matched.projectId
      if (projectId === undefined) return json(response, 404, { error: t('errors.routeNotFound') })
      if (request.method === 'GET' && matched.suffix === '') {
        const project = config.service.project(actor, projectId)
        const runs = config.service.runs(actor, projectId)
        // A tentativa CORRENTE é a que a pessoa escolheu olhar, quando ela
        // desfez para um ponto seguro; sem escolha, é a mais recente - que é o
        // que sempre valeu. Ignorar a escolha aqui faria o desfazer não
        // desfazer nada visível.
        const chosenRun = project.current_run_id === undefined || project.current_run_id === null
          ? null
          : runs.find(run => run.run_id === project.current_run_id) ?? null
        const currentRun = chosenRun ?? [...runs].sort((left, right) => right.started_at.localeCompare(left.started_at) || right.attempt - left.attempt)[0] ?? null
        const verificationCodes = project.state === 'VERIFIED_PROTOTYPE' && currentRun?.state === 'PASSED'
          ? await capturedVerificationCodes(currentRun.run_directory)
          : []
        /*
          A pergunta AINDA SEM RESPOSTA viaja junto do corpo.

          Ela não é um registro novo: `nextIntakeQuestion` a deriva dos turnos
          já gravados, e é a mesma função que a rota de resposta usa — duas
          derivações diferentes discordariam na primeira pergunta nova.

          Sem ela aqui, recarregar a página no meio das perguntas devolvia a
          tarefa sem a pergunta, e a pessoa ficava numa etapa sem saída. A tela
          contornava isso desistindo de restaurar tarefas sem plano; com a
          conversa, a pergunta aberta é só mais um lance, e o contorno saiu.

          NÃO há um `if` de estado aqui, e a ausência foi medida: a primeira
          versão só perguntava quando o projeto estava em `DRAFT`. A sabotagem
          que removia essa condição SOBREVIVEU — porque `nextIntakeQuestion` já
          responde "não há o que perguntar" quando tudo foi respondido. Duas
          condições para o mesmo fato é a segunda verdade de sempre; ficou uma.
        */
        const pendente = nextIntakeQuestion(await conversationFor(config.service, actor, projectId))
        /*
          Os PEDIDOS DE MUDANÇA da pessoa, para a conversa poder mostrá-los
          como mensagens dela. São derivados das especificações já gravadas
          (ver `pedidosDeRevisao`); nada novo é guardado para isto existir.
        */
        const revisoes = pedidosDeRevisao(await config.service.specs(actor, projectId))
        return json(response, 200, {
          project,
          next: pendente ?? null,
          revisions: revisoes,
          turns: await config.service.intakeTurns(actor, projectId),
          plan: await optionalAsync(async () => config.service.plan(actor, projectId)),
          design: await optionalAsync(async () => config.service.latestDesign(actor, projectId)),
          runs,
          current_run: currentRun === null ? null : { ...currentRun, verification_codes: verificationCodes },
          evidence: await config.service.evidence(actor, projectId),
        })
      }
      if (request.method === 'GET' && matched.suffix === '/report') {
        // O relato do que aconteceu, já em português. A tela NUNCA lê o
        // `pipeline.log` cru: ele pode carregar caminho de disco e saída de
        // ferramenta, e quem decide o que atravessa é o servidor.
        config.service.assertAuthorized(actor, 'project.read')
        config.service.project(actor, projectId)
        const runs = config.service.runs(actor, projectId)
        const latest = runs.at(-1)
        const report = latest === undefined || latest.run_directory === 'not-created'
          ? null
          : await readRunReport(latest.run_directory)
        return json(response, 200, { report })
      }
      if (request.method === 'GET' && matched.suffix === '/source') {
        /*
          O CÓDIGO da versão, para o painel de prévia mostrar o que foi escrito.

          A lista do que pode ser lido vem do RELATO daquela tentativa, e não de
          uma conferência de caminho: um caminho que o produto não gravou não é
          servido, por mais bem formado que seja. `fonte-do-artefato.ts` explica
          por que a lista branca ganha da normalização, e tem a falsificação.

          Só a tentativa MAIS RECENTE. Servir uma antiga exigiria a mesma
          conferência contra o relato dela, e misturar as duas listas é
          exatamente como um arquivo de uma execução vaza para outra.
        */
        config.service.assertAuthorized(actor, 'project.read')
        config.service.project(actor, projectId)
        const pedido = new URL(request.url ?? '/', 'http://local').searchParams.get('path') ?? ''
        const latest = config.service.runs(actor, projectId).at(-1)
        if (latest === undefined || latest.run_directory === 'not-created') return json(response, 404, { error: 'RUN_NOT_FOUND' })
        const relato = await readRunReport(latest.run_directory)
        try {
          const caminho = fonteAServir(relato, pedido)
          const conteudo = conteudoQueCabe(await readFile(resolve(latest.run_directory, caminho), 'utf8'))
          return json(response, 200, { path: caminho, content: conteudo, run_id: latest.run_id })
        } catch (erro) {
          if (erro instanceof FonteNaoServida) return json(response, 404, { error: erro.code })
          throw erro
        }
      }
      if (request.method === 'GET' && matched.suffix === '/checkpoints') {
        // Os pontos aos quais a pessoa pode voltar. Quando não há nenhum, o
        // motivo viaja junto: "não há para onde voltar" sem o porquê é a mesma
        // caixa preta que E-06 desmontou.
        config.service.assertAuthorized(actor, 'project.read')
        return json(response, 200, config.service.checkpoints(actor, projectId))
      }
      if (request.method === 'POST' && matched.suffix === '/undo') {
        // Desfazer é NAVEGAÇÃO: nada em disco é apagado aqui, e o serviço
        // sequer tem acesso a disco. O que muda é o estado do projeto e qual
        // tentativa é a corrente.
        const input = undoSchema.parse(await readJson(request))
        const undone = await config.service.undoToCheckpoint(actor, projectId, input.run_id)
        return json(response, 200, { project: undone.project, checkpoint: undone.checkpoint })
      }
      if (request.method === 'POST' && matched.suffix === '/revise') {
        // Continuar a MESMA tarefa depois de um resultado. A recusa por estado
        // e a por texto vêm do serviço com os mesmos códigos das outras rotas,
        // e não de uma validação repetida aqui.
        const input = reviseSchema.parse(await readJson(request))
        const revised = await config.service.reviseProject(actor, projectId, input.request, input.request_key)
        return json(response, 200, { project: revised.project, spec_id: revised.spec.spec_id })
      }
      if (request.method === 'POST' && matched.suffix === '/ask') {
        /*
          PERGUNTAR não é pedir alteração, e por isso é outra rota.

          Uma rota só, com um campo dizendo qual dos dois é, colocaria a
          escolha num `if` que nenhum contrato de rota vigia — e a permissão, o
          escopo e o efeito dos dois gestos passariam a depender do corpo do
          pedido. São gestos diferentes: um escreve na especificação e devolve
          um plano para aprovar, o outro não muda nada.
        */
        const input = perguntaSchema.parse(await readJson(request))
        const turn = await config.service.askAboutProject(actor, projectId, input.question, input.request_key)
        return json(response, 201, { turn })
      }
      if (request.method === 'POST' && matched.suffix === '/intake/answer') {
        return await answerIntake(request, response, config, actor, projectId)
      }
      if (request.method === 'POST' && matched.suffix === '/intake/correct') {
        const input = correctionSchema.parse(await readJson(request))
        const turn = await config.service.correctIntakeAnswer(actor, projectId, input.question_id, input.answer, input.request_key)
        /*
          Com a especificação já sintetizada, a correção só vale quando chega
          nela: a síntese é refeita com as respostas atuais, e a especificação
          ganha uma VERSÃO nova — a anterior continua gravada. Sem
          especificação, a próxima pergunta (ou a síntese) segue o caminho de
          sempre.
        */
        const conversation = await conversationFor(config.service, actor, projectId)
        const next = nextIntakeQuestion(conversation)
        if (next === undefined) return await sintetizarEspecificacao(response, config, actor, projectId, conversation, { turn })
        return json(response, 200, { turn, next })
      }
      if (request.method === 'POST' && matched.suffix === '/design') {
        const input = designSelectionSchema.parse(await readJson(request))
        return json(response, 200, { design: await config.service.saveDesign(actor, projectId, input) })
      }
      if (request.method === 'POST' && matched.suffix === '/design/logo') {
        config.service.assertAuthorized(actor, 'project.write'); config.service.project(actor, projectId)
        const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.toLowerCase() ?? ''
        const logo = await config.logos.process({ orgId: actor.orgId, tenantId: actor.tenantId }, await readBytes(request, LOGO_LIMIT), contentType)
        return json(response, 200, { design: await config.service.attachLogo(actor, projectId, logo) })
      }
      if (request.method === 'POST' && matched.suffix === '/plan') {
        const project = config.service.project(actor, projectId)
        const spec = await config.service.latestSpec(actor, projectId)
        const previous = await optionalAsync(async () => config.service.plan(actor, projectId))
        // O inventário só é buscado quando há mudança a planejar: ler o disco
        // para um plano novo seria trabalho por nada, e o resultado seria
        // descartado logo em seguida pelo próprio planejador.
        const change = previous?.status === 'CHANGE_REQUESTED' ? previous.change_request ?? undefined : undefined
        const code = change === undefined ? undefined : await config.codeContext?.(actor, projectId)
        const planned = await config.planner.plan(
          // O ATOR inteiro, e não só o escopo: é o registro de habilidades que
          // precisa de quem pergunta, e ele confere papel. Passar meio ator
          // faria o planejamento acontecer sem habilidade nenhuma e sem dizer
          // por quê.
          { orgId: actor.orgId, tenantId: actor.tenantId, userId: actor.userId, role: actor.role },
          project.privacy, spec.app_spec, project.category, change, code,
        )
        // O que o Studio CONSULTOU sai JUNTO do plano, e vem do RETORNO da
        // chamada — nunca de campo do planejador.
        //
        // A primeira versao lia `config.planner.lastLedger` aqui. O planejador
        // e criado UMA VEZ por processo e servido a todos os inquilinos, e esta
        // leitura acontecia DEPOIS do `await` de `proposePlan`: nessa janela
        // outro pedido, de outra organizacao, ja tinha sobrescrito os campos, e
        // a resposta saia com o contexto dela. A revisao adversarial REPRODUZIU
        // a corrida. O valor devolvido pela chamada nao tem essa janela: ele
        // pertence a quem o pediu, e a mais ninguem.
        const consulted = consultedView(planned.ledger, planned.skills, planned.codeIncomplete)
        return json(response, 201, {
          plan: await config.service.proposePlan(actor, projectId, planned.output.slices),
          consulted,
        })
      }
      if (request.method === 'POST' && matched.suffix === '/plan/change') {
        const input = changeRequestComChaveSchema.parse(await readJson(request))
        return json(response, 200, { plan: await config.service.requestPlanChange(actor, projectId, input.reason, input.request_key) })
      }
      if (request.method === 'POST' && matched.suffix === '/plan/slice') {
        // A pessoa descreve o que falta; quem escreve a etapa é o planejador.
        // `planned_files` é a autorização de escrita do gerador, e não um
        // campo de formulário.
        const input = planSliceComChaveSchema.parse(await readJson(request))
        const project = config.service.project(actor, projectId)
        return json(response, 200, {
          plan: await config.service.addPlanSlice(actor, projectId, input.reason, config.planner, project.privacy, input.request_key, input.base_revision),
        })
      }
      if (request.method === 'POST' && matched.suffix === '/plan/edit') {
        const { request_key, ...edit } = planEditComChaveSchema.parse(await readJson(request))
        return json(response, 200, { plan: await config.service.editPlan(actor, projectId, edit, request_key) })
      }
      if (request.method === 'POST' && matched.suffix === '/plan/approve') {
        return json(response, 200, { plan: await config.service.approvePlan(actor, projectId) })
      }
      if (request.method === 'POST' && matched.suffix === '/generate') {
        // A porta por onde a pessoa manda começar. O serviço de trabalhos
        // pergunta de novo logo adiante, e a repetição é de propósito: esta
        // recusa vira 409 com a frase da parada, em vez de um erro genérico
        // vindo de dentro.
        config.emergencyStop?.assertRunning({ orgId: actor.orgId, tenantId: actor.tenantId })
        const plan = await config.service.plan(actor, projectId)
        if (plan.status !== 'APPROVED') throw new PromptToAppError('INVALID', t('errors.planRequired'))
        const accepted = await config.jobs.start(actor, projectId, config.generatorFor(actor, projectId))
        return json(response, 202, { run_id: accepted.runId })
      }
      if (request.method === 'POST' && matched.suffix === '/generate/cancel') {
        return json(response, 202, { status: config.jobs.cancel(actor, projectId) })
      }
      if (request.method === 'DELETE' && matched.suffix === '') {
        return json(response, 200, { project: await config.service.archive(actor, projectId) })
      }
      return json(response, 404, { error: t('errors.routeNotFound') })
    } catch (error) {
      return json(response, statusOf(error), { error: error instanceof Error ? error.message : t('errors.invalidRequest') })
    }
}

const capturedMessageSchema = z.array(z.object({
  kind: z.enum(['code', 'invitation']), email: z.string().email(), code: z.string().regex(/^\d{6}$/u).optional(), expiresAt: z.iso.datetime(),
}).passthrough()).max(20)

/**
 * Lê o relato gravado ao lado da execução.
 *
 * Ausência não é erro: uma execução antiga, ou interrompida antes de gravar,
 * simplesmente não tem relato - e dizer isso é melhor do que inventar etapas.
 * @param runDirectory - o diretório da execução.
 * @returns o relato, ou `null`.
 */
async function readRunReport(runDirectory: string): Promise<unknown> {
  try {
    const raw = await readFile(resolve(runDirectory, RUN_REPORT_FILE), 'utf8')
    if (raw.length > MAX_RUN_REPORT_BYTES) return null
    return JSON.parse(raw)
  } catch { return null }
}

/** Teto do relato: um log gigante não pode virar uma resposta gigante. */
const MAX_RUN_REPORT_BYTES = 256 * 1024

async function capturedVerificationCodes(runDirectory: string): Promise<readonly { email: string; code: string; expires_at: string }[]> {
  try {
    const decoded = capturedMessageSchema.parse(JSON.parse(await readFile(resolveRunCapture(runDirectory), 'utf8')))
    return decoded.filter((message): message is typeof message & { code: string } => message.kind === 'code' && message.code !== undefined)
      .map(message => ({ email: message.email, code: message.code, expires_at: message.expiresAt }))
  } catch { return [] }
}

function resolveRunCapture(runDirectory: string): string {
  if (runDirectory === 'not-created') throw new Error('RUN_DIRECTORY_NOT_CREATED')
  return resolve(runDirectory, 'data', 'studio-capture.json')
}

async function answerIntake(
  request: IncomingMessage,
  response: ServerResponse,
  config: PromptToAppHttpConfig,
  actor: PromptToAppActor,
  projectId: string,
): Promise<void> {
  const input = answerSchema.parse(await readJson(request))
  const conversation = await conversationFor(config.service, actor, projectId)
  const question = nextIntakeQuestion(conversation)
  if (question === undefined) {
    /*
      AS PERGUNTAS ACABARAM — E ISSO NÃO QUER DIZER QUE A TAREFA ESTÁ PRONTA.

      A síntese da especificação acontece DEPOIS da última resposta, e ela
      chama o modelo. Quando essa chamada falha, o turno já está gravado: as
      perguntas ficam respondidas, a especificação não existe, e toda rota
      seguinte recusa — `/plan` diz que a especificação não existe, `/revise`
      diz que ainda não houve resultado, e responder de novo dizia que as
      perguntas já foram respondidas. Um beco: a tarefa não anda e não dá para
      recomeçá-la. Medido em 18/09/2026, com o Ollama local devolvendo falha de
      conexão na última resposta.

      A saída honesta é REFAZER a síntese, e não recusar para sempre. Nenhuma
      resposta é pedida de novo: o que faltou não foi a pessoa, foi o modelo.
    */
    /*
      Especificação existente só é "já respondido" quando ela é MAIS NOVA que a
      última resposta. Uma correção cuja nova síntese falhou deixa a
      especificação para trás — e recusar aqui repetiria o beco de 18/09 com
      outra porta: a resposta corrigida gravada e nunca aplicada.
    */
    if (await temEspecificacao(config.service, actor, projectId) && !(await especificacaoDesatualizada(config.service, actor, projectId))) {
      throw new PromptToAppError('REPLAY', t('errors.questionsAnswered'))
    }
    return await sintetizarEspecificacao(response, config, actor, projectId, conversation)
  }
  let lidas: Partial<Record<PerguntaDaLeitura, string>> = {}
  let leitura: { route: string; model: string } | undefined
  if (question.id === 'sensitive-confirmation') {
    if (input.confirm_sensitive === undefined) throw new PromptToAppError('INVALID', t('errors.sensitiveConfirmation'))
    const resposta = input.confirm_sensitive ? t('values.confirmed') : t('values.notConfirmed')
    await config.service.answerIntakeTurn(
      actor, projectId,
      { questionId: question.id, question: question.text, recommended: false, digitada: resposta },
      async () => ({ answer: resposta, route: null, model: null }),
      input.request_key,
    )
    if (!input.confirm_sensitive) {
      return json(response, 200, { blocked: true, message: t('errors.sensitiveBlocked') })
    }
  } else {
    const digitada = input.answer.trim()
    if (!input.recommend && digitada === '') throw new PromptToAppError('INVALID', t('errors.answerRequired'))
    /*
      A CHAMADA AO MODELO mora dentro da função que só roda quando o envio é
      novo. Fora dela, o reenvio depois de a resposta se perder chamaria o
      modelo de novo — e o custo dessa chamada é real, mesmo quando o turno
      acabasse descartado.
    */
    /*
      A LEITURA roda dentro de `produzir`, e por isso só quando o envio é novo:
      o reenvio da mesma resposta não paga a leitura de novo. O que ela
      encontra é gravado DEPOIS do turno da pessoa, como resposta recomendada.
    */
    await config.service.answerIntakeTurn(
      actor, projectId,
      { questionId: question.id, question: question.text, recommended: input.recommend, digitada },
      async () => {
        if (!input.recommend) {
          const faltando = PERGUNTAS_DA_LEITURA.filter(id => id !== question.id && conversation.answers[id] === undefined)
          if (faltando.length > 0) {
            const lido = await lerSemTravar(config.intake, conversation, faltando, digitada)
            if (lido !== undefined) { lidas = lido.respostas; leitura = { route: lido.route, model: lido.model } }
          }
          return { answer: digitada, route: null, model: null }
        }
        const result = await config.intake.recommend(conversation, question)
        const answer = z.string().trim().min(1).max(2_000).parse(result.value)
        if (answer === '') throw new PromptToAppError('INVALID', t('errors.answerRequired'))
        return { answer, route: result.route, model: result.model }
      },
      input.request_key,
    )
  }

  const inferidas: StudioIntakeTurn[] = []
  if (leitura !== undefined) {
    for (const id of PERGUNTAS_DA_LEITURA) {
      const texto = lidas[id]
      if (texto === undefined) continue
      inferidas.push(await config.service.recordTurn(actor, projectId, {
        question_id: id, question: t(`questions.${id}`), answer: texto, recommended: true, route: leitura.route, model: leitura.model,
      }))
    }
  }
  const updated = await conversationFor(config.service, actor, projectId)
  const next = nextIntakeQuestion(updated)
  const lidasNaResposta = inferidas.length === 0 ? {} : { inferred: inferidas }
  if (next !== undefined) return json(response, 200, { next, ...lidasNaResposta })
  return await sintetizarEspecificacao(response, config, actor, projectId, updated, lidasNaResposta)
}

/**
 * A leitura, sem poder travar o questionário.
 *
 * Só a falha de ROTA vira "não li": sem modelo, a conversa segue perguntando,
 * como fazia antes de a leitura existir. Qualquer outro erro sobe — engolir
 * tudo esconderia um defeito do próprio produto atrás de uma pergunta a mais.
 * @param intake - o motor.
 * @param conversation - a conversa até aqui.
 * @param faltando - o que ainda falta.
 * @param ultima - a resposta que a pessoa acabou de escrever.
 * @returns o que foi lido, ou `undefined` quando não houve leitura.
 */
async function lerSemTravar(
  intake: IntakeEngine, conversation: IntakeConversation, faltando: readonly PerguntaDaLeitura[], ultima: string,
): Promise<{ respostas: Partial<Record<PerguntaDaLeitura, string>>; route: string; model: string } | undefined> {
  try {
    const resultado = await intake.ler(conversation, faltando, ultima)
    return { respostas: respostasLidas(resultado.value, faltando), route: resultado.route, model: resultado.model }
  } catch (erro) {
    if (erro instanceof ModelRouteUnavailableError) return undefined
    throw erro
  }
}

/**
 * A especificação ficou para trás de uma resposta?
 *
 * Só as respostas do QUESTIONÁRIO contam — a pergunta que a pessoa faz sobre a
 * tarefa não muda a especificação. E só antes do plano: depois dele, o
 * questionário não é mais a fonte da especificação (ver `correctIntakeAnswer`).
 * @param service - o serviço.
 * @param actor - quem pergunta.
 * @param projectId - a tarefa.
 * @returns se há resposta mais nova que a especificação.
 */
async function especificacaoDesatualizada(service: PromptToAppService, actor: PromptToAppActor, projectId: string): Promise<boolean> {
  const spec = await service.latestSpec(actor, projectId)
  if (spec.origin !== 'intake') return false
  const turnos = (await service.intakeTurns(actor, projectId)).filter(turno => (PERGUNTAS_DA_LEITURA as readonly string[]).includes(turno.question_id))
  return turnos.some(turno => turno.created_at > spec.created_at)
}

/**
 * A especificação desta tarefa já existe?
 *
 * `NOT_FOUND` aqui quer dizer "ainda não há", e não erro — a mesma leitura que
 * `#perguntar` faz do plano. Qualquer outra falha sobe: tratar um erro de
 * leitura como ausência faria a síntese rodar de novo por cima de uma
 * especificação que existe.
 * @param service - o serviço.
 * @param actor - quem pergunta.
 * @param projectId - a tarefa.
 * @returns se existe.
 */
async function temEspecificacao(service: PromptToAppService, actor: PromptToAppActor, projectId: string): Promise<boolean> {
  try {
    await service.latestSpec(actor, projectId)
    return true
  } catch (erro) {
    if (erro instanceof PromptToAppError && erro.code === 'NOT_FOUND') return false
    throw erro
  }
}

/**
 * A síntese da especificação a partir do questionário respondido.
 *
 * Ela existe como função porque é chamada de DOIS lugares: ao fim da última
 * resposta, e de novo quando a pessoa volta a uma tarefa cuja síntese falhou.
 * Duas cópias divergiriam no primeiro conserto de uma delas.
 * @param response - a resposta HTTP.
 * @param config - a configuração do manipulador.
 * @param actor - quem pede.
 * @param projectId - a tarefa.
 * @param conversation - o questionário já respondido.
 */
async function sintetizarEspecificacao(
  response: ServerResponse,
  config: PromptToAppHttpConfig,
  actor: PromptToAppActor,
  projectId: string,
  conversation: IntakeConversation,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const built = await config.intake.buildSpec(conversation)
  const spec = await config.service.saveSpec(actor, projectId, built.spec, 'intake')
  return json(response, 201, { spec, next: null, ...extra })
}

async function conversationFor(service: PromptToAppService, actor: PromptToAppActor, projectId: string): Promise<IntakeConversation> {
  const project = service.project(actor, projectId)
  const turns = await service.intakeTurns(actor, projectId)
  // A escolha do que é resposta do questionário mora em `pergunta.ts`, com
  // teste próprio: aqui dentro ela sobreviveu à sabotagem.
  const answers = respostasDoQuestionario(turns)
  const sensitive = turns.find(turn => turn.question_id === 'sensitive-confirmation')
  return {
    project, answers,
    ...(sensitive === undefined ? {} : { sensitiveConfirmed: sensitive.answer === t('values.confirmed') }),
  }
}

async function authenticatedActor(request: IncomingMessage, config: PromptToAppHttpConfig, response: ServerResponse): Promise<PromptToAppActor> {
  const session = await authenticatedMutation(request, config.identity, response)
  const authorization = config.tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  if (authorization === undefined) throw new PromptToAppError('FORBIDDEN', t('errors.membershipRequired'))
  return { ...authorization, sessionId: session.session_id }
}

/**
 * Que rota este pedido é, ou nenhuma.
 *
 * EXPORTADA, e o motivo é um defeito encontrado: a rota de revisão foi
 * declarada no contrato, ganhou tratamento no despachante e respondia 404,
 * porque o sufixo dela não estava nesta expressão. Duas listas descrevendo o
 * mesmo conjunto discordaram em silêncio — o defeito mais caro deste
 * repositório, na sua forma mais simples.
 *
 * Com ela visível, o teste consegue perguntar ao contrato e ao casador a MESMA
 * pergunta e comparar as respostas, em vez de exercitar uma rota por vez e
 * torcer para ninguém esquecer a próxima.
 * @param method - o método do pedido.
 * @param path - o caminho, já sem o prefixo da API.
 * @returns o projeto e o sufixo, ou `undefined` quando não é rota daqui.
 */
export function matchRoute(method: string | undefined, path: string): { readonly projectId?: string; readonly suffix: string } | undefined {
  /*
    As rotas de ESPAÇO DE TRABALHO, que não vivem debaixo de um projeto.

    A lista é fechada de propósito, e o comentário abaixo já dizia que um
    sufixo novo precisa entrar em DOIS lugares: aqui e no contrato. Eu fiz só
    metade ao acrescentar `/usage`, e o e2e cobrou — a rota existia no contrato,
    o manipulador tinha o caso, e `matchRoute` devolvia `undefined`, então o
    pedido caía nas extensões e terminava em 404.

    Fica como está: uma lista fechada que o teste de ponta a ponta confere é
    melhor que uma aberta que aceita qualquer coisa em silêncio.
  */
  if ((method === 'GET' && (path === '/health' || path === '/usage' || path === '/export' || path === '/projects')) || (method === 'POST' && path === '/projects')) return { suffix: path }
  const match = ROTA_DE_PROJETO.exec(path)
  if (match === null) return undefined
  const suffix = match[2] ?? ''
  // `/report` e `/checkpoints` só LEEM, e são as únicas leituras com sufixo. A
  // lista continua fechada: um sufixo novo precisa entrar aqui E no contrato de
  // rotas.
  const readOnlySuffixes = new Set(['/report', '/checkpoints', '/source', '/operation'])
  const allowed = (method === 'GET' && (suffix === '' || readOnlySuffixes.has(suffix)))
    || (method === 'DELETE' && suffix === '')
    || (method === 'POST' && suffix !== '' && !readOnlySuffixes.has(suffix))
  if (!allowed) return undefined
  return { projectId: decodeURIComponent(match[1]!), suffix }
}

function optional<T>(read: () => T): T | null {
  try { return read() } catch (error) { if (error instanceof PromptToAppError && error.code === 'NOT_FOUND') return null; throw error }
}

/** O mesmo `optional`, para leitura assíncrona: `NOT_FOUND` vira `null`. */
async function optionalAsync<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read() } catch (error) { if (error instanceof PromptToAppError && error.code === 'NOT_FOUND') return null; throw error }
}

function statusOf(error: unknown): number {
  if (error instanceof IdentityError) return error.code === 'locked' ? 429 : 401
  if (error instanceof TenancyError) return error.code === 'not-found' ? 404 : error.code === 'forbidden' ? 403 : 400
  if (error instanceof PromptToAppError) return error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : error.code === 'CAPACITY' ? 429 : error.code === 'REPLAY' || error.code === 'CONFLICT' ? 409 : 400
  if (error instanceof FormCategoryCapabilityError) return 409
  if (error instanceof InvalidTransitionError) return 409
  // Desfazer recusado pelo estado atual não é pedido malformado: é conflito com
  // onde o projeto está agora, e a tela precisa dessa diferença para explicar.
  if (error instanceof UndoNotAvailableError) return 409
  // A recusa do botão de emergência vem de outro plugin, então não há classe a
  // testar aqui - só o código que o contrato de `EmergencyStopGuard` promete.
  // 409 e não 403: não é falta de permissão, é o Studio parado de propósito, e
  // a tela precisa dessa diferença para mostrar como retomar.
  if (isEmergencyStopRefusal(error)) return 409
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
  return 500
}

/** Uma recusa por parada de emergência, reconhecida pelo código que o contrato do guarda promete. */
function isEmergencyStopRefusal(error: unknown): boolean {
  return error instanceof Error && (error as { readonly code?: unknown }).code === 'STOPPED'
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) throw new Error(t('errors.jsonRequired'))
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new Error(t('errors.requestTooLarge'))
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new PromptToAppError('INVALID', t('errors.invalidLogo'))
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}
