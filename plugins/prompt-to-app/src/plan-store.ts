import type { StudioPlan } from './model.js'

/**
 * O PLANO aprovado guardado em tabela por inquilino, com RLS.
 *
 * Quarto domínio do plano do `S-08`, e o mais delicado dos cinco: o plano é o
 * que a pessoa aprovou, e `planned_files` — a lista dentro de cada fatia — é a
 * autorização de escrita do gerador. Ler o plano errado não produz um
 * aplicativo com defeito: produz um aplicativo que escreve onde não devia.
 *
 * A ordem é por REVISÃO, a mais alta primeiro, e é ordenada aqui: `plan()`
 * devolve a mais recente, e uma revisão antiga atravessando faria a criação
 * usar um plano que a pessoa já tinha editado. Planos anteriores ao campo
 * valem como revisão 1, exatamente como `planRevision` já trata.
 *
 * Interface estrutural, como nos outros: `prompt-to-app` NÃO depende de
 * `storage-postgres`.
 */

/** A unidade de armazenamento deste domínio. */
export const PLAN_UNIT = 'studio_plans'
/** A tabela dentro da unidade. */
export const PLAN_TABLE = 'plans'

/** O escopo, do jeito que o armazenamento por inquilino o recebe. */
export interface PlanScope {
  readonly orgId: string
  readonly tenantId: string
}

/** O recorte do armazenamento por inquilino que este domínio usa. */
export interface PlanRecordStore {
  list<T>(scope: PlanScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  put(scope: PlanScope, unit: string, table: string, key: string, value: unknown): Promise<void>
}

/**
 * Os planos de um inquilino, da revisão MAIS ALTA para a mais baixa.
 * @param store - o armazenamento por inquilino.
 * @param scope - organização e inquilino.
 * @returns os planos, mais recente primeiro.
 */
export async function listPlans(store: PlanRecordStore, scope: PlanScope): Promise<readonly StudioPlan[]> {
  const rows = await store.list<StudioPlan>(scope, PLAN_UNIT, PLAN_TABLE)
  return rows.map(row => row.value).sort(newestFirst)
}

/** Grava no escopo do PRÓPRIO plano, nunca no de quem pediu. */
export async function putPlanRecord(store: PlanRecordStore, value: StudioPlan): Promise<void> {
  await store.put({ orgId: value.org_id, tenantId: value.tenant_id }, PLAN_UNIT, PLAN_TABLE, value.plan_id, value)
}

/**
 * Revisão mais alta primeiro, com a data de criação e o identificador
 * desempatando — a MESMA ordem que a leitura da chave-valor já usava.
 */
function newestFirst(left: StudioPlan, right: StudioPlan): number {
  const revision = (right.revision ?? 0) - (left.revision ?? 0)
  if (revision !== 0) return revision
  const created = right.created_at.localeCompare(left.created_at)
  if (created !== 0) return created
  return left.plan_id < right.plan_id ? 1 : left.plan_id > right.plan_id ? -1 : 0
}
