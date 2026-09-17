import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import type {
  PromptToAppWorkspaceHttpExtension,
  PromptToAppWorkspaceHttpExtensionRequest,
} from '@dz23-studio/prompt-to-app'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { studioProjectSchema } from '@dz23-studio/prompt-to-app'
import { t } from './i18n.js'
import { BusinessError, type BusinessService } from './service.js'

const planoSchema = z.object({
  objetivo: z.string().min(10).max(2_000),
  publico: z.string().min(3).max(500),
  oferta: z.string().max(2_000),
  limites: z.array(z.string().min(3).max(300)).max(20),
}).strict()

const criarSchema = z.object({
  nome: z.string().min(2).max(120),
  origem: z.enum(['criada', 'vinculada']),
  identidade_juridica_declarada: z.string().max(200).nullable().optional(),
  plano: planoSchema,
}).strict()

const revisarSchema = z.object({ plano: planoSchema }).strict()

/**
 * O pedido de uma tarefa criada a partir da empresa.
 *
 * `request_key` atravessa INTEIRA para o serviço de tarefas, que já sabe tratá-la
 * — é a mesma identidade de intenção de envio da criação normal, e não uma
 * segunda. Opcional no contrato porque um cliente antigo não pode deixar de
 * criar tarefa de um dia para o outro.
 */
const criarTarefaSchema = z.object({
  pedido: z.string().min(3).max(10_000),
  // Os dois esquemas saem do esquema da TAREFA, que é o dono deles — e não de
  // uma lista de literais copiada, que seria a segunda verdade de sempre:
  // ela diverge no primeiro valor novo, e a rota da empresa passaria a recusar
  // uma categoria que o produto aceita. Sair do esquema do projeto também evita
  // uma dependência nova só para alcançar o enum de privacidade.
  category: studioProjectSchema.shape.category,
  privacy: studioProjectSchema.shape.privacy,
  request_key: z.string().min(1).max(200).optional(),
}).strict()

/**
 * As rotas do Modo Empresa.
 *
 * Todas pedem escopo `workspace` e permissão do papel, como as demais: a
 * empresa mora DENTRO do inquilino que o Studio já isola, e nenhuma delas
 * aceita `org_id` ou `tenant_id` do corpo — eles vêm do ator autenticado.
 *
 * Arquivar é `POST` e não `DELETE` de propósito: arquivar NÃO apaga, e um
 * verbo de remoção faria a próxima pessoa achar que apaga.
 */
export const BUSINESS_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/businesses', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/businesses', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'GET', path: '/businesses/:businessId', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/businesses/:businessId/plan', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'POST', path: '/businesses/:businessId/archive', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'GET', path: '/businesses/:businessId/tasks', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/businesses/:businessId/tasks', access: 'authorized', permission: 'project.write', scope: 'workspace' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(BUSINESS_ROUTE_CONTRACTS)

/** O sufixo de uma rota de empresa, quando é uma. */
const ROTA = /^\/businesses(?:\/([^/]+)(?:\/(plan|archive|tasks))?)?$/u

/**
 * As rotas do Modo Empresa, registradas como fatia do Studio.
 *
 * Como a parada de emergência, ela NÃO abre uma segunda autoridade sobre
 * `/api/studio/apps`: quem autentica, valida CSRF e resolve o papel continua
 * sendo o núcleo do prompt-to-app. Esta função só decide o que fazer com um
 * pedido já autenticado.
 * @param service - o serviço de empresas.
 * @returns a extensão de escopo pronta para registro.
 */
export function createBusinessHttpExtension(service: BusinessService): PromptToAppWorkspaceHttpExtension {
  return async (input): Promise<boolean> => {
    const casado = ROTA.exec(input.suffix)
    if (casado === null) return false
    const businessId = casado[1]
    const acao = casado[2]
    try {
      if (input.request.method === 'GET' && businessId === undefined) {
        return responder(input.response, 200, { businesses: service.list(input.actor) })
      }
      if (input.request.method === 'POST' && businessId === undefined) {
        const corpo = criarSchema.parse(await lerJson(input))
        const criada = await service.create(input.actor, corpo)
        return responder(input.response, 201, { business: criada.empresa, plan: criada.plano })
      }
      if (input.request.method === 'GET' && businessId !== undefined && acao === undefined) {
        // A empresa E as versões do plano no mesmo corpo: a tela precisa das
        // duas para desenhar, e duas chamadas dariam duas verdades sobre a
        // mesma empresa em instantes diferentes.
        return responder(input.response, 200, {
          business: service.get(input.actor, businessId),
          plans: service.planos(input.actor, businessId),
        })
      }
      if (input.request.method === 'POST' && businessId !== undefined && acao === 'plan') {
        const corpo = revisarSchema.parse(await lerJson(input))
        return responder(input.response, 201, { plan: await service.revisarPlano(input.actor, businessId, corpo.plano) })
      }
      if (input.request.method === 'POST' && businessId !== undefined && acao === 'archive') {
        return responder(input.response, 200, { business: await service.arquivar(input.actor, businessId) })
      }
      if (input.request.method === 'GET' && businessId !== undefined && acao === 'tasks') {
        return responder(input.response, 200, { tasks: service.tarefas(input.actor, businessId) })
      }
      if (input.request.method === 'POST' && businessId !== undefined && acao === 'tasks') {
        const { request_key: requestKey, ...corpo } = criarTarefaSchema.parse(await lerJson(input))
        const criada = await service.criarTarefa(input.actor, businessId, corpo, requestKey)
        return responder(input.response, 201, { task: criada.tarefa, link: criada.vinculo })
      }
      return responder(input.response, 404, { error: t('errors.routeNotFound') })
    } catch (erro) {
      return responder(input.response, statusDe(erro), { error: mensagemSegura(erro) })
    }
  }
}

async function lerJson(input: PromptToAppWorkspaceHttpExtensionRequest): Promise<unknown> {
  const contentType = input.request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new BusinessError('INVALID', t('errors.jsonRequired'))
  }
  const partes: Buffer[] = []
  let tamanho = 0
  for await (const parte of input.request) {
    const bytes = Buffer.isBuffer(parte) ? parte : Buffer.from(parte as string)
    tamanho += bytes.length
    if (tamanho > 32 * 1024) throw new BusinessError('INVALID', t('errors.requestTooLarge'))
    partes.push(bytes)
  }
  const valor = Buffer.concat(partes).toString('utf8')
  return valor === '' ? {} : JSON.parse(valor)
}

function responder(response: ServerResponse, status: number, body: unknown): true {
  if (!response.writableEnded) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(body))
  }
  return true
}

function statusDe(erro: unknown): number {
  if (erro instanceof BusinessError) {
    if (erro.code === 'FORBIDDEN') return 403
    if (erro.code === 'NOT_FOUND') return 404
    // Plano repetido e empresa arquivada não são pedido malformado: são
    // conflito com o estado de agora, e a tela precisa da diferença.
    if (erro.code === 'CONFLICT') return 409
    return 400
  }
  if (erro instanceof z.ZodError || erro instanceof SyntaxError) return 400
  return 500
}

function mensagemSegura(erro: unknown): string {
  if (erro instanceof BusinessError || erro instanceof z.ZodError || erro instanceof SyntaxError) return erro.message
  return t('errors.operationFailed')
}
