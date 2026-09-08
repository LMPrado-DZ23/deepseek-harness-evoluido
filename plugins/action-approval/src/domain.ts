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
  // v2: o registro passou a carregar `summary`, a frase que a pessoa lê antes
  // de decidir. Um registro v1 não tem esse campo e é recusado na leitura.
  version: 2,
  tables: { approvals: domainTable<ApprovalKey, ApprovalRecord>(approvalRecordSchema) },
})
