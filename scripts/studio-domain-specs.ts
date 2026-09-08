import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { studioHelloDomainSpec } from '../plugins/hello/src/index.ts'
import { identityAuditDomainSpec, identityCredentialsDomainSpec, identitySessionsDomainSpec, identityUsersDomainSpec } from '../plugins/identity/src/model.ts'
import { studioPolicyAuditDomainSpec } from '../plugins/policy/src/index.ts'
import { studioAgentLeasesDomainSpec, studioAgentRunsDomainSpec } from '../plugins/agents/src/model.ts'
import { studioAgentTeamsDomainSpec } from '../plugins/agent-team/src/model.ts'
import { studioRouteHealthDomainSpec } from '../plugins/route-health/src/model.ts'
import { studioPreviewAdmissionsDomainSpec, studioPreviewsDomainSpec } from '../plugins/preview/src/model.ts'
import { studioMembershipsDomainSpec, studioOrgsDomainSpec, studioWorkspacesDomainSpec } from '../plugins/tenancy/src/model.ts'
import { PROMPT_TO_APP_DOMAIN_SPECS } from '../plugins/prompt-to-app/src/model.ts'
import { studioIntegrationSwitchesDomainSpec, studioIntegrationsDomainSpec } from '../plugins/integration-hub/src/model.ts'
import { studioStagingReleasesDomainSpec } from '../plugins/staging/src/domain.ts'
import { studioActionApprovalsDomainSpec } from '../plugins/action-approval/src/domain.ts'
import { studioEmergencyStopDomainSpec } from '../plugins/emergency-stop/src/model.ts'

/** The only units migration tools may touch. Session/event logs use another seam. */
export const STUDIO_DOMAIN_SPECS: readonly DomainSpec[] = [
  studioHelloDomainSpec,
  studioActionApprovalsDomainSpec,
  studioEmergencyStopDomainSpec,
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
  studioAgentTeamsDomainSpec,
  studioRouteHealthDomainSpec,
  studioPreviewsDomainSpec,
  studioPreviewAdmissionsDomainSpec,
  ...PROMPT_TO_APP_DOMAIN_SPECS,
  studioIntegrationsDomainSpec,
  studioIntegrationSwitchesDomainSpec,
  studioStagingReleasesDomainSpec,
]
