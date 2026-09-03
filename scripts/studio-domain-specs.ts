import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { studioHelloDomainSpec } from '../plugins/hello/src/index.ts'
import { identityAuditDomainSpec, identityCredentialsDomainSpec, identitySessionsDomainSpec, identityUsersDomainSpec } from '../plugins/identity/src/model.ts'
import { studioPolicyAuditDomainSpec } from '../plugins/policy/src/index.ts'
import { studioAgentLeasesDomainSpec, studioAgentRunsDomainSpec } from '../plugins/agents/src/model.ts'
import { studioRouteHealthDomainSpec } from '../plugins/route-health/src/model.ts'
import { studioMembershipsDomainSpec, studioOrgsDomainSpec, studioWorkspacesDomainSpec } from '../plugins/tenancy/src/model.ts'

/** The only units migration tools may touch. Session/event logs use another seam. */
export const STUDIO_DOMAIN_SPECS: readonly DomainSpec[] = [
  studioHelloDomainSpec,
  identityUsersDomainSpec,
  identityCredentialsDomainSpec,
  identitySessionsDomainSpec,
  identityAuditDomainSpec,
  studioOrgsDomainSpec,
  studioWorkspacesDomainSpec,
  studioMembershipsDomainSpec,
  studioPolicyAuditDomainSpec,
  studioAgentRunsDomainSpec,
  studioAgentLeasesDomainSpec,
  studioRouteHealthDomainSpec,
]
