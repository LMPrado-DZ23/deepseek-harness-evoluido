import type { StudioDesignSpecRecord } from './model.js'

/**
 * As escolhas de VISUAL do projeto guardadas em tabela por inquilino, com RLS.
 *
 * Segundo domínio do plano do `S-08`, depois de `studio_intake_turns`. Ele já
 * toca o caminho central — o pipeline lê o visual antes de escrever os arquivos
 * do aplicativo —, e por isso a travessia foi feita na mesma ordem da primeira:
 * a FORMA da leitura primeiro, o armazenamento depois, com a suíte inteira
 * entre uma coisa e outra.
 *
 * ## A ordem é por versão, e ela é gravada aqui
 *
 * `latestDesign` devolve a versão mais alta, e é essa que o pipeline usa para
 * pintar o aplicativo. Numa lista fora de ordem a pessoa receberia o visual
 * ANTIGO depois de já ter trocado — e não teria como saber por quê. A
 * chave-valor devolvia na ordem de inserção; a tabela não promete ordem
 * nenhuma, então quem ordena é este arquivo.
 *
 * Interface estrutural, como no outro: `prompt-to-app` NÃO depende de
 * `storage-postgres`, e uma instalação sem PostgreSQL continua funcionando.
 */

/** A unidade de armazenamento deste domínio. */
export const DESIGN_SPEC_UNIT = 'studio_design_specs'
/** A tabela dentro da unidade. */
export const DESIGN_SPEC_TABLE = 'designs'

/** O escopo, do jeito que o armazenamento por inquilino o recebe. */
export interface DesignSpecScope {
  readonly orgId: string
  readonly tenantId: string
}

/** O recorte do armazenamento por inquilino que este domínio usa. */
export interface DesignSpecRecordStore {
  list<T>(scope: DesignSpecScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  put(scope: DesignSpecScope, unit: string, table: string, key: string, value: unknown): Promise<void>
}

/**
 * As escolhas de visual de um inquilino, da versão MAIS ALTA para a mais baixa.
 * @param store - o armazenamento por inquilino.
 * @param scope - organização e inquilino.
 * @returns os registros, mais novo primeiro.
 */
export async function listDesignSpecs(store: DesignSpecRecordStore, scope: DesignSpecScope): Promise<readonly StudioDesignSpecRecord[]> {
  const rows = await store.list<StudioDesignSpecRecord>(scope, DESIGN_SPEC_UNIT, DESIGN_SPEC_TABLE)
  return rows.map(row => row.value).sort(newestFirst)
}

/** Grava no escopo do PRÓPRIO registro, nunca no de quem pediu. */
export async function putDesignSpec(store: DesignSpecRecordStore, value: StudioDesignSpecRecord): Promise<void> {
  await store.put({ orgId: value.org_id, tenantId: value.tenant_id }, DESIGN_SPEC_UNIT, DESIGN_SPEC_TABLE, value.design_id, value)
}

/** Versão mais alta primeiro, com o identificador desempatando. */
function newestFirst(left: StudioDesignSpecRecord, right: StudioDesignSpecRecord): number {
  if (left.version !== right.version) return right.version - left.version
  return left.design_id < right.design_id ? 1 : left.design_id > right.design_id ? -1 : 0
}
