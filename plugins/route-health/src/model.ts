import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const routeStateSchema = z.enum(['OK', 'DEGRADED', 'DOWN', 'NOT_CONFIGURED'])
export type RouteState = z.infer<typeof routeStateSchema>

export const routeHealthRecordSchema = z.object({
  record_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  route: z.string().min(1),
  state: routeStateSchema,
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  average_latency_ms: z.number().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  /**
   * Quantas requisições entraram na conta SEM preço configurado.
   *
   * Sem este campo, `estimated_cost_usd` somava 0 para elas e o resultado era
   * apresentado como custo medido: "não sei o preço" virava "custou zero".
   *
   * É opcional de propósito. Torná-lo obrigatório exigiria subir a versão do
   * domínio, e `open()` falha com `version-mismatch` em qualquer instalação que
   * já rodou - não existe passo de migração. Registro antigo, sem o campo,
   * significa zero não precificadas.
   */
  unpriced_requests: z.number().int().nonnegative().optional(),
  /**
   * Falhas seguidas desde o último sucesso desta rota, NESTE escopo.
   *
   * A contagem é por registro - `org_id`/`tenant_id`/rota - e nunca global:
   * uma contagem global fecharia a rota de um locatário por causa da chave
   * quebrada de outro.
   */
  consecutive_failures: z.number().int().nonnegative().optional(),
  /**
   * Quando o circuito desta rota abriu, ou `null` com ele fechado.
   *
   * Sem isto, uma rota que falha sempre era tentada de novo a cada requisição:
   * cada pessoa pagava a espera inteira do erro para descobrir o que a
   * requisição anterior já sabia.
   *
   * Os dois campos são OPCIONAIS pelo mesmo motivo de `unpriced_requests`:
   * torná-los obrigatórios exigiria subir a versão do domínio, e `open()`
   * falha com `version-mismatch` em qualquer instalação que já rodou - não
   * existe passo de migração. Registro antigo, sem os campos, significa
   * circuito fechado, que é exatamente o estado dele antes desta mudança.
   */
  circuit_opened_at: z.iso.datetime().nullable().optional(),
  /**
   * Se esta rota está ligada NESTE escopo.
   *
   * O liga/desliga é por escopo e por rota: desligar globalmente tiraria a rota
   * de locatários que não pediram nada.
   *
   * Opcional pelo mesmo motivo dos campos acima - a versão do domínio não pode
   * subir. Registro antigo, sem o campo, significa LIGADA, que é exatamente o
   * mundo em que ele foi gravado.
   */
  enabled: z.boolean().optional(),
  last_failure: z.string().nullable(),
  updated_at: z.iso.datetime(),
}).strict()

/**
 * O perfil de rota como ele é ACEITO em disco e na borda HTTP.
 *
 * Os três nomes novos e os dois valores do binário anterior convivem na mesma
 * enumeração de propósito: a versão do domínio não pode subir, então o registro
 * gravado com `local-only` ou `any` precisa continuar validando. Quem decide
 * comportamento usa `routePrivacyProfile`, que traduz os antigos; ninguém
 * compara com o valor cru.
 */
export const routePrivacySchema = z.enum(['privado-local', 'equilibrado', 'melhor-qualidade', 'local-only', 'any'])

export const routeSwitchEventSchema = z.object({
  event_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  from_route: z.string().min(1),
  to_route: z.string().min(1),
  reason: z.string().min(1),
  explicit_route: z.boolean(),
  created_at: z.iso.datetime(),
}).strict()

export type RouteHealthRecord = z.infer<typeof routeHealthRecordSchema>
export type RouteSwitchEvent = z.infer<typeof routeSwitchEventSchema>
declare const routeHealthKeyBrand: unique symbol
declare const routeEventKeyBrand: unique symbol
export type RouteHealthKey = string & { readonly [routeHealthKeyBrand]: true }
export type RouteEventKey = string & { readonly [routeEventKeyBrand]: true }

export const STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN = 'studio_route_health'
export const STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN = 'studio.route.health'

export const studioRouteHealthDomainSpec = defineDomain({
  name: STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    routes: domainTable<RouteHealthKey, RouteHealthRecord>(routeHealthRecordSchema),
    events: domainTable<RouteEventKey, RouteSwitchEvent>(routeSwitchEventSchema),
  },
})
