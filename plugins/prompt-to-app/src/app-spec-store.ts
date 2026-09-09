import type { StudioAppSpecRecord } from './model.js'

/**
 * A ESPECIFICAÇÃO do aplicativo guardada em tabela por inquilino, com RLS.
 *
 * Terceiro domínio do plano do `S-08`, e o de maior peso dos três: a
 * especificação é o que a pessoa aprovou, e é dela que saem o plano, os
 * critérios de aceite e o aplicativo. Se a versão errada atravessar, o Studio
 * constrói uma coisa que ninguém pediu — e constrói com convicção.
 *
 * Por isso a ordem por VERSÃO é ordenada aqui, e não confiada à tabela:
 * `latestSpec` devolve a mais alta, e é ela que o pipeline lê. A chave-valor
 * devolvia na ordem de inserção; a tabela não promete ordem nenhuma.
 *
 * Interface estrutural, como nos outros dois: `prompt-to-app` NÃO depende de
 * `storage-postgres`, e uma instalação sem PostgreSQL continua funcionando na
 * chave-valor.
 */

/** A unidade de armazenamento deste domínio. */
export const APP_SPEC_UNIT = 'studio_app_specs'
/** A tabela dentro da unidade. */
export const APP_SPEC_TABLE = 'specs'

/** O escopo, do jeito que o armazenamento por inquilino o recebe. */
export interface AppSpecScope {
  readonly orgId: string
  readonly tenantId: string
}

/** O recorte do armazenamento por inquilino que este domínio usa. */
export interface AppSpecRecordStore {
  list<T>(scope: AppSpecScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  put(scope: AppSpecScope, unit: string, table: string, key: string, value: unknown): Promise<void>
}

/**
 * As especificações de um inquilino, da versão MAIS ALTA para a mais baixa.
 * @param store - o armazenamento por inquilino.
 * @param scope - organização e inquilino.
 * @returns os registros, mais novo primeiro.
 */
export async function listAppSpecs(store: AppSpecRecordStore, scope: AppSpecScope): Promise<readonly StudioAppSpecRecord[]> {
  const rows = await store.list<StudioAppSpecRecord>(scope, APP_SPEC_UNIT, APP_SPEC_TABLE)
  return rows.map(row => row.value).sort(newestFirst)
}

/** Grava no escopo do PRÓPRIO registro, nunca no de quem pediu. */
export async function putAppSpec(store: AppSpecRecordStore, value: StudioAppSpecRecord): Promise<void> {
  await store.put({ orgId: value.org_id, tenantId: value.tenant_id }, APP_SPEC_UNIT, APP_SPEC_TABLE, value.spec_id, value)
}

/** Versão mais alta primeiro, com o identificador desempatando. */
function newestFirst(left: StudioAppSpecRecord, right: StudioAppSpecRecord): number {
  if (left.version !== right.version) return right.version - left.version
  return left.spec_id < right.spec_id ? 1 : left.spec_id > right.spec_id ? -1 : 0
}
