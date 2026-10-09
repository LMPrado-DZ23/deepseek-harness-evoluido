import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  STUDIO_ACTION_APPROVALS_PHYSICAL_DOMAIN,
  approvalRecordSchema,
  type ApprovalRecord,
} from './model.js'

declare const approvalKeyBrand: unique symbol
export type ApprovalKey = string & { readonly [approvalKeyBrand]: true }

export const studioActionApprovalsDomainSpec = defineDomain({
  name: STUDIO_ACTION_APPROVALS_PHYSICAL_DOMAIN,
  // Continua v1 de propósito. O campo `summary` entrou como OPCIONAL no
  // registro justamente para não subir a versão: subir faria `open` falhar com
  // `version-mismatch` em qualquer instalação que já rodou, e a autoridade
  // falha fechada - o portão T3 inteiro recusaria para sempre, sem log que
  // apontasse a causa. A API de domínio não tem passo de migração.
  version: 1,
  tables: { approvals: domainTable<ApprovalKey, ApprovalRecord>(approvalRecordSchema) },
})
