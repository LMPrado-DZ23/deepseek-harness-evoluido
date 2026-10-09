import type { StudioEvidence } from './model.js'

/**
 * As EVIDÊNCIAS da execução guardadas em tabela por inquilino, com RLS.
 *
 * Quinto e último domínio alcançável do plano do `S-08`. É o registro do que
 * aconteceu — diff, log de construção, relatório de teste, varredura de
 * segurança —, e ele existe justamente para ser lido depois, por alguém que
 * quer saber por que algo passou ou reprovou. Uma evidência do inquilino errado
 * atravessando não quebra a criação: ela **conta a história de outra pessoa**.
 *
 * A ordem é por data de criação, mais antiga primeiro, e é ordenada aqui: a
 * tela mostra a sequência da execução, e uma lista embaralhada faria a
 * varredura de segurança aparecer antes do build que a produziu.
 *
 * Interface estrutural, como nos outros quatro.
 */

/** A unidade de armazenamento deste domínio. */
export const EVIDENCE_UNIT = 'studio_evidence'
/** A tabela dentro da unidade. */
export const EVIDENCE_TABLE = 'evidence'

/** O escopo, do jeito que o armazenamento por inquilino o recebe. */
export interface EvidenceScope {
  readonly orgId: string
  readonly tenantId: string
}

/** O recorte do armazenamento por inquilino que este domínio usa. */
export interface EvidenceRecordStore {
  list<T>(scope: EvidenceScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  put(scope: EvidenceScope, unit: string, table: string, key: string, value: unknown): Promise<void>
}

/**
 * As evidências de um inquilino, mais antiga primeiro.
 * @param store - o armazenamento por inquilino.
 * @param scope - organização e inquilino.
 * @returns os registros, na ordem em que aconteceram.
 */
export async function listEvidence(store: EvidenceRecordStore, scope: EvidenceScope): Promise<readonly StudioEvidence[]> {
  const rows = await store.list<StudioEvidence>(scope, EVIDENCE_UNIT, EVIDENCE_TABLE)
  return rows.map(row => row.value).sort(oldestFirst)
}

/** Grava no escopo da PRÓPRIA evidência, nunca no de quem pediu. */
export async function putEvidenceRecord(store: EvidenceRecordStore, value: StudioEvidence): Promise<void> {
  await store.put({ orgId: value.org_id, tenantId: value.tenant_id }, EVIDENCE_UNIT, EVIDENCE_TABLE, value.evidence_id, value)
}

/** Mais antiga primeiro, com o identificador desempatando. */
function oldestFirst(left: StudioEvidence, right: StudioEvidence): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1
  return left.evidence_id < right.evidence_id ? -1 : left.evidence_id > right.evidence_id ? 1 : 0
}
