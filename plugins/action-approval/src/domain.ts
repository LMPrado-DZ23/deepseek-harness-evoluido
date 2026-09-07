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
  version: 1,
  tables: { approvals: domainTable<ApprovalKey, ApprovalRecord>(approvalRecordSchema) },
})
