import type { ZodType } from 'zod'
import {
  studioAppSpecsDomainSpec, studioApprovalsDomainSpec, studioDesignSpecsDomainSpec, studioEvidenceDomainSpec,
  studioIntakeTurnsDomainSpec, studioPlansDomainSpec, studioProjectsDomainSpec, studioRunsDomainSpec,
} from '../src/model.js'

/**
 * Os repositórios em memória dos testes conferem o registro com o MESMO schema
 * que o armazenamento real usa ao reabrir. Sem isto, um teste de ponta a ponta
 * gravava um registro que o produto recusaria no próximo reinício, e passava —
 * foi exatamente assim que `title` e o `form_test_id` vazio do painel chegaram
 * ao disco do titular em 19/09/2026 sem que nenhum teste acusasse.
 */
const SCHEMAS: Record<string, ZodType> = {
  project_id: studioProjectsDomainSpec.tables.projects.valueSchema,
  spec_id: studioAppSpecsDomainSpec.tables.specs.valueSchema,
  design_id: studioDesignSpecsDomainSpec.tables.designs.valueSchema,
  turn_id: studioIntakeTurnsDomainSpec.tables.turns.valueSchema,
  plan_id: studioPlansDomainSpec.tables.plans.valueSchema,
  run_id: studioRunsDomainSpec.tables.runs.valueSchema,
  evidence_id: studioEvidenceDomainSpec.tables.evidence.valueSchema,
  approval_id: studioApprovalsDomainSpec.tables.approvals.valueSchema,
}

export function conferido<T>(value: T, chave: string): T {
  const schema = SCHEMAS[chave]
  if (schema === undefined) throw new Error(`sem schema para ${chave}`)
  schema.parse(value)
  return value
}
