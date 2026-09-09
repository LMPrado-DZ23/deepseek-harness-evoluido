import type { HubEvent, IntegrationKillSwitch, StudioExport, StudioIntegration } from './model.js'
import { securityFingerprint, type HubActor, type HubRepository } from './service.js'

/**
 * O segundo domínio do Studio a sair da chave-valor opaca e ir para uma TABELA
 * com isolamento por linha (RLS) — o `studio_integrations`, com as três tabelas
 * que ele guarda: integrações, exportações e eventos.
 *
 * A diferença que importa não é o banco, é QUEM separa os inquilinos. Sob a
 * chave-valor, o Hub abre a unidade inteira e a separação é um índice montado
 * dentro do processo; se um dia esse índice for consultado com o escopo errado,
 * a linha do outro inquilino chega a quem pediu. Aqui a organização e o
 * inquilino viajam na própria consulta, e o PostgreSQL recusa o que não é do
 * escopo — sem depender de nenhum `filter` deste arquivo estar correto.
 *
 * O que isto NÃO conserta, e está escrito porque a diferença é fácil de
 * confundir com segurança que não existe:
 *
 * 1. `compareAndSwapIntegration` continua sendo leitura e escrita em duas idas
 *    ao banco, serializadas por uma FILA DESTE PROCESSO. RLS separa inquilinos;
 *    ela não cria transação. O Studio continua sendo escritor único, e é isso
 *    que sustenta a troca condicional — não o banco.
 * 2. A paginação de eventos ordena e corta EM MEMÓRIA, depois de ler as linhas
 *    do inquilino. Elas são limitadas pela retenção (`pruneEvents`), então não
 *    é uma varredura sem teto — mas também não é `ORDER BY ... LIMIT`, e não
 *    vai virar enquanto a porta do armazenamento por inquilino não oferecer
 *    consulta ordenada. Dizer o contrário seria vender um limite que não existe.
 * 3. Os desligamentos por alcance NÃO estão aqui: são de outro domínio, lidos
 *    em guarda de caminho quente, e continuam servidos por quem já os servia.
 */

/** A unidade e as tabelas onde o Hub mora na tabela por inquilino. */
export const HUB_TENANT_UNIT = 'studio_integrations'
export const HUB_INTEGRATIONS_TABLE = 'integrations'
export const HUB_EXPORTS_TABLE = 'exports'
export const HUB_EVENTS_TABLE = 'events'

/** O escopo, do jeito que o armazenamento por inquilino o recebe. */
export interface HubTenantScope {
  readonly orgId: string
  readonly tenantId: string
}

/**
 * O recorte do armazenamento por inquilino que este repositório usa.
 *
 * É uma interface estrutural de propósito: `@dz23-studio/integration-hub` não
 * depende de `@dz23-studio/storage-postgres`. O Hub não pode passar a exigir um
 * banco específico para compilar.
 */
export interface HubTenantRecordStore {
  list<T>(scope: HubTenantScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  get<T>(scope: HubTenantScope, unit: string, table: string, key: string): Promise<T | undefined>
  put(scope: HubTenantScope, unit: string, table: string, key: string, value: unknown): Promise<void>
  delete(scope: HubTenantScope, unit: string, table: string, key: string): Promise<boolean>
}

/** Quem continua servindo os desligamentos por alcance, que são de outro domínio. */
export type HubKillSwitchSource = Pick<HubRepository, 'killSwitch' | 'putKillSwitch' | 'killSwitches'>

/** Mais novo primeiro, com o identificador desempatando — a mesma ordem da chave-valor. */
function newestFirst(left: Pick<HubEvent, 'created_at' | 'event_id'>, right: Pick<HubEvent, 'created_at' | 'event_id'>): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.event_id < right.event_id ? 1 : left.event_id > right.event_id ? -1 : 0
}

/**
 * A chave da exportação carrega o projeto.
 *
 * O escopo do banco é a organização e o inquilino; o projeto não faz parte
 * dele. Sem o projeto na chave, duas exportações de projetos diferentes com o
 * mesmo identificador colidiriam.
 *
 * O separador é uma barra, e a barra é RECUSADA nos dois lados em vez de
 * confiada: `project_id` é `z.string().min(1)` e chega da URL depois de
 * `decodeURIComponent`, então "confiar que ninguém põe uma barra" é confiar em
 * quem manda o pedido. Com uma barra no projeto, `a/b` + `c` e `a` + `b/c`
 * viram a MESMA chave — uma exportação lida como se fosse de outro projeto.
 */
function exportKey(projectId: string, exportId: string): string {
  if (projectId.includes('/') || exportId.includes('/')) throw new Error('HUB_EXPORT_KEY_INVALID')
  return `${projectId}/${exportId}`
}

export class TenantRecordHubRepository implements HubRepository {
  #integrationTail: Promise<unknown> = Promise.resolve()
  #eventTail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: HubTenantRecordStore,
    private readonly switches: HubKillSwitchSource,
  ) {}

  // ---- integrações ---------------------------------------------------------

  async integrations(scope: HubActor): Promise<readonly StudioIntegration[]> {
    const rows = await this.store.list<StudioIntegration>(scope, HUB_TENANT_UNIT, HUB_INTEGRATIONS_TABLE)
    return rows.map(row => row.value).filter(value => this.#inScope(scope, value))
  }

  async integration(scope: HubActor, integrationId: string): Promise<StudioIntegration | undefined> {
    const value = await this.store.get<StudioIntegration>(scope, HUB_TENANT_UNIT, HUB_INTEGRATIONS_TABLE, integrationId)
    // O escopo já foi imposto pelo banco. Esta conferência é a segunda tranca,
    // e existe porque a linha guarda a organização e o inquilino DENTRO do
    // valor: uma linha gravada com o escopo errado no corpo some da leitura em
    // vez de aparecer como se fosse de quem perguntou.
    return value === undefined || !this.#inScope(scope, value) ? undefined : value
  }

  putIntegration(value: StudioIntegration): Promise<void> {
    return this.#exclusive(() => this.store.put(
      { orgId: value.org_id, tenantId: value.tenant_id }, HUB_TENANT_UNIT, HUB_INTEGRATIONS_TABLE, value.integration_id, value,
    ))
  }

  deleteIntegration(scope: HubActor, integrationId: string): Promise<void> {
    return this.#exclusive(async () => {
      // O REGISTRO sai; os eventos ficam. Apagar o rastro junto seria
      // transformar "remover uma integração" em "apagar a auditoria de tudo que
      // ela fez".
      const current = await this.integration(scope, integrationId)
      if (current === undefined) return
      await this.store.delete(scope, HUB_TENANT_UNIT, HUB_INTEGRATIONS_TABLE, integrationId)
    })
  }

  compareAndSwapIntegration(scope: HubActor, integrationId: string, expectedFingerprint: string, value: StudioIntegration): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = await this.integration(scope, integrationId)
      if (current === undefined || securityFingerprint(current) !== expectedFingerprint) return false
      await this.store.put(
        { orgId: value.org_id, tenantId: value.tenant_id }, HUB_TENANT_UNIT, HUB_INTEGRATIONS_TABLE, value.integration_id, value,
      )
      return true
    })
  }

  // ---- exportações ---------------------------------------------------------

  async exports(scope: HubActor, projectId: string): Promise<readonly StudioExport[]> {
    const rows = await this.store.list<StudioExport>(scope, HUB_TENANT_UNIT, HUB_EXPORTS_TABLE)
    return rows.map(row => row.value).filter(value => this.#inScope(scope, value) && value.project_id === projectId)
  }

  async export(scope: HubActor, projectId: string, exportId: string): Promise<StudioExport | undefined> {
    const value = await this.store.get<StudioExport>(scope, HUB_TENANT_UNIT, HUB_EXPORTS_TABLE, exportKey(projectId, exportId))
    return value === undefined || !this.#inScope(scope, value) || value.project_id !== projectId ? undefined : value
  }

  async putExport(value: StudioExport): Promise<void> {
    await this.store.put(
      { orgId: value.org_id, tenantId: value.tenant_id }, HUB_TENANT_UNIT, HUB_EXPORTS_TABLE,
      exportKey(value.project_id, value.export_id), value,
    )
  }

  // ---- eventos -------------------------------------------------------------

  async eventPage(scope: HubActor, after: Pick<HubEvent, 'created_at' | 'event_id'> | undefined, limit: number): Promise<readonly HubEvent[]> {
    const rows = await this.#events(scope)
    const start = after === undefined ? 0 : rows.findIndex(value => newestFirst(value, after) > 0)
    return start < 0 ? [] : rows.slice(start, start + limit)
  }

  async eventCount(scope: HubActor): Promise<number> {
    return (await this.#events(scope)).length
  }

  putEvent(value: HubEvent): Promise<void> {
    // Mesma fila das integrações, por um motivo próprio: a poda LÊ a lista e
    // apaga a cauda. Uma gravação no meio de uma poda faria a poda devolver
    // uma contagem que não corresponde ao que ela apagou.
    return this.#exclusiveEvent(() => this.store.put(
      { orgId: value.org_id, tenantId: value.tenant_id }, HUB_TENANT_UNIT, HUB_EVENTS_TABLE, value.event_id, value,
    ))
  }

  pruneEvents(scope: HubActor, keep: number): Promise<number> {
    return this.#exclusiveEvent(() => this.#pruneEvents(scope, keep))
  }

  async #pruneEvents(scope: HubActor, keep: number): Promise<number> {
    const rows = await this.#events(scope)
    // Os mais novos ficam: a retenção corta a CAUDA, e nunca o que acabou de
    // acontecer. Um `keep` negativo apagaria tudo por engano de chamada.
    const removed = rows.slice(Math.max(keep, 0))
    for (const row of removed) await this.store.delete(scope, HUB_TENANT_UNIT, HUB_EVENTS_TABLE, row.event_id)
    return removed.length
  }

  // ---- desligamentos por alcance (outro domínio) ---------------------------

  killSwitch(switchId: string): IntegrationKillSwitch | undefined { return this.switches.killSwitch(switchId) }
  putKillSwitch(value: IntegrationKillSwitch): Promise<void> { return this.switches.putKillSwitch(value) }
  killSwitches(orgId: string): readonly IntegrationKillSwitch[] { return this.switches.killSwitches(orgId) }

  // ---- internos ------------------------------------------------------------

  async #events(scope: HubActor): Promise<readonly HubEvent[]> {
    const rows = await this.store.list<HubEvent>(scope, HUB_TENANT_UNIT, HUB_EVENTS_TABLE)
    return rows.map(row => row.value).filter(value => this.#inScope(scope, value)).sort(newestFirst)
  }

  #inScope(scope: HubTenantScope, value: { readonly org_id: string; readonly tenant_id: string }): boolean {
    return value.org_id === scope.orgId && value.tenant_id === scope.tenantId
  }

  /**
   * Uma fila para as escritas de integração.
   *
   * A troca condicional é lida e escrita em duas idas ao banco: duas chamadas
   * simultâneas poderiam ler a MESMA versão e as duas passarem na conferência
   * de impressão digital. A fila serializa; ela não é transação, e o item 1 do
   * comentário do arquivo diz por quê.
   */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#integrationTail.then(work)
    this.#integrationTail = run.catch(() => undefined)
    return run
  }

  /** A fila dos eventos, separada da das integrações: uma auditoria não espera um registro. */
  #exclusiveEvent<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#eventTail.then(work)
    this.#eventTail = run.catch(() => undefined)
    return run
  }
}
