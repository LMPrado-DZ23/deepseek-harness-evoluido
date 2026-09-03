import { describe, expect, it } from 'vitest'
import { identityAuditDomainSpec, identityCredentialsDomainSpec, identitySessionsDomainSpec, identityUsersDomainSpec } from '../../identity/src/model.ts'
import { studioPolicyAuditDomainSpec } from '../../policy/src/index.ts'
import { studioAgentLeasesDomainSpec, studioAgentRunsDomainSpec } from '../../agents/src/model.ts'
import { studioRouteHealthDomainSpec } from '../../route-health/src/model.ts'
import { studioMembershipsDomainSpec, studioOrgsDomainSpec, studioWorkspacesDomainSpec } from '../../tenancy/src/model.ts'
import { studioHelloDomainSpec } from '../../hello/src/index.ts'
import { assertDomainScopeManifest, STUDIO_DOMAIN_SCOPES } from '../../../scripts/domain-scope-gate.ts'

const SPECS = [
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

describe('Studio domain tenant-scope gate', () => {
  it('classifies every defineDomain declaration with no wildcard', async () => {
    await expect(assertDomainScopeManifest(process.cwd())).resolves.toBeUndefined()
  })

  it('matches every physical domain and table and requires its structural scope fields', () => {
    expect(STUDIO_DOMAIN_SCOPES).toHaveLength(SPECS.length)
    for (const entry of STUDIO_DOMAIN_SCOPES) {
      const spec = SPECS.find(candidate => candidate.name === entry.physicalName)
      expect(spec, entry.physicalName).toBeDefined()
      expect(Object.keys(spec!.tables).sort()).toEqual(Object.keys(entry.tables).sort())
      for (const [tableName, rule] of Object.entries(entry.tables)) {
        const table = (spec!.tables as Record<string, { valueSchema: unknown }>)[tableName]!
        const fields = schemaFields(table.valueSchema)
        expect(fields, `${entry.physicalName}.${tableName}`).toEqual(expect.arrayContaining([...rule.requiredFields]))
        if (rule.scope !== 'org-tenant') expect(rule.reason).toBeTruthy()
      }
    }
  })
})

function schemaFields(schema: unknown): string[] {
  let current = schema as { shape?: Record<string, unknown>; in?: unknown }
  while (current.shape === undefined && current.in !== undefined) current = current.in as typeof current
  if (current.shape === undefined) throw new Error('Expected a Zod object schema')
  return Object.keys(current.shape)
}
