import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ZodType } from 'zod'
import { chaveArmazenada } from './creation-key.js'
import {
  studioAppSpecsDomainSpec, studioApprovalsDomainSpec, studioCreationKeysDomainSpec, studioDesignSpecsDomainSpec,
  studioEvidenceDomainSpec, studioIntakeTurnsDomainSpec, studioPlansDomainSpec, studioProjectsDomainSpec, studioRunsDomainSpec,
  type PromptToAppKey, type StudioApproval, type StudioAppSpecRecord, type StudioCreationKey, type StudioDesignSpecRecord,
  type StudioEvidence, type StudioIntakeTurn, type StudioPlan, type StudioProject, type StudioRun,
} from './model.js'
import type { PromptToAppRepository } from './service.js'

/**
 * Grava um registro SÓ depois de conferi-lo com o MESMO schema que a abertura
 * do domínio usa para lê-lo de volta.
 *
 * O armazenamento do harness confere o schema na ABERTURA, e não na escrita.
 * Isso deixava uma armadilha, e o FRIGG caiu nela em 19/09/2026: a lista de
 * conferências ganhou o campo `title` (a frase em português) em `acceptance.ts`,
 * o schema dos registros de execução em `model.ts` não ganhou, e toda criação
 * gravou sem reclamar um registro que o próprio produto recusava ao reabrir. O
 * efeito aparecia só no reinício seguinte, e era o pior possível: o FRIGG não
 * subia mais, por causa de um dado que ele mesmo escreveu.
 *
 * Conferir aqui troca esse defeito tardio e fatal por uma falha imediata, na
 * operação que escreveu o dado errado — que é onde ele pode ser corrigido.
 * @param table - a tabela.
 * @param key - a chave.
 * @param schema - o schema da tabela, o mesmo do `defineDomain`.
 * @param value - o registro.
 * @returns a gravação.
 */
export function gravarConferido<T>(table: KvTable<PromptToAppKey, T>, key: PromptToAppKey, schema: ZodType<T>, value: T): ReturnType<KvTable<PromptToAppKey, T>['put']> {
  schema.parse(value)
  return table.put(key, value)
}

function tableValues<T>(table: KvTable<PromptToAppKey, T>): T[] { return [...table.entries()].map(([, value]) => value) }

/** O repositório do produto sobre os domínios do harness. */
export class DomainPromptToAppRepository implements PromptToAppRepository {
  constructor(
    private readonly projectTable: KvTable<PromptToAppKey, StudioProject>,
    private readonly specTable: KvTable<PromptToAppKey, StudioAppSpecRecord>,
    private readonly designTable: KvTable<PromptToAppKey, StudioDesignSpecRecord>,
    private readonly turnTable: KvTable<PromptToAppKey, StudioIntakeTurn>,
    private readonly planTable: KvTable<PromptToAppKey, StudioPlan>,
    private readonly runTable: KvTable<PromptToAppKey, StudioRun>,
    private readonly evidenceTable: KvTable<PromptToAppKey, StudioEvidence>,
    private readonly approvalTable: KvTable<PromptToAppKey, StudioApproval>,
    private readonly creationKeyTable: KvTable<PromptToAppKey, StudioCreationKey>,
  ) {}
  projects() { return tableValues(this.projectTable) }
  putProject(value: StudioProject) { return gravarConferido(this.projectTable, value.project_id as PromptToAppKey, studioProjectsDomainSpec.tables.projects.valueSchema, value) }
  specs() { return tableValues(this.specTable) }
  putSpec(value: StudioAppSpecRecord) { return gravarConferido(this.specTable, value.spec_id as PromptToAppKey, studioAppSpecsDomainSpec.tables.specs.valueSchema, value) }
  designs() { return tableValues(this.designTable) }
  putDesign(value: StudioDesignSpecRecord) { return gravarConferido(this.designTable, value.design_id as PromptToAppKey, studioDesignSpecsDomainSpec.tables.designs.valueSchema, value) }
  turns() { return tableValues(this.turnTable) }
  putTurn(value: StudioIntakeTurn) { return gravarConferido(this.turnTable, value.turn_id as PromptToAppKey, studioIntakeTurnsDomainSpec.tables.turns.valueSchema, value) }
  plans() { return tableValues(this.planTable) }
  putPlan(value: StudioPlan) { return gravarConferido(this.planTable, value.plan_id as PromptToAppKey, studioPlansDomainSpec.tables.plans.valueSchema, value) }
  runs() { return tableValues(this.runTable) }
  putRun(value: StudioRun) { return gravarConferido(this.runTable, value.run_id as PromptToAppKey, studioRunsDomainSpec.tables.runs.valueSchema, value) }
  evidence() { return tableValues(this.evidenceTable) }
  putEvidence(value: StudioEvidence) { return gravarConferido(this.evidenceTable, value.evidence_id as PromptToAppKey, studioEvidenceDomainSpec.tables.evidence.valueSchema, value) }
  approvals() { return tableValues(this.approvalTable) }
  putApproval(value: StudioApproval) { return gravarConferido(this.approvalTable, value.approval_id as PromptToAppKey, studioApprovalsDomainSpec.tables.approvals.valueSchema, value) }
  creationKeys() { return tableValues(this.creationKeyTable) }
  putCreationKey(value: StudioCreationKey) {
    // A chave de armazenamento leva o escopo junto, e nao so a chave do
    // cliente: duas pessoas podem escolher a mesma, e a segunda nao pode
    // sobrescrever a reserva da primeira.
    return gravarConferido(this.creationKeyTable, chaveArmazenada({ orgId: value.org_id, tenantId: value.tenant_id, userId: value.user_id }, value.request_key) as PromptToAppKey, studioCreationKeysDomainSpec.tables.keys.valueSchema, value)
  }
}
