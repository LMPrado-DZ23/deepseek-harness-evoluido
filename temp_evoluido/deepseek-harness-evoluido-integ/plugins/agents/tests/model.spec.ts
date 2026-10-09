import { describe, expect, it } from 'vitest'
import {
  STUDIO_AGENT_LEASES_LOGICAL_DOMAIN,
  STUDIO_AGENT_LEASES_PHYSICAL_DOMAIN,
  STUDIO_AGENT_RUNS_LOGICAL_DOMAIN,
  STUDIO_AGENT_RUNS_PHYSICAL_DOMAIN,
  agentLeaseSchema,
  agentRunSchema,
  studioAgentLeasesDomainSpec,
  studioAgentRunsDomainSpec,
} from '../src/model.ts'

describe('Studio agent domains', () => {
  it('uses physical snake_case names and logical dotted names', () => {
    expect([STUDIO_AGENT_RUNS_PHYSICAL_DOMAIN, STUDIO_AGENT_LEASES_PHYSICAL_DOMAIN])
      .toEqual(['studio_agent_runs', 'studio_agent_leases'])
    expect([STUDIO_AGENT_RUNS_LOGICAL_DOMAIN, STUDIO_AGENT_LEASES_LOGICAL_DOMAIN])
      .toEqual(['studio.agent.runs', 'studio.agent.leases'])
    expect(studioAgentRunsDomainSpec.name).toBe(STUDIO_AGENT_RUNS_PHYSICAL_DOMAIN)
    expect(studioAgentLeasesDomainSpec.name).toBe(STUDIO_AGENT_LEASES_PHYSICAL_DOMAIN)
  })

  it('rejects incomplete run and lease records', () => {
    expect(agentRunSchema.safeParse({}).success).toBe(false)
    expect(agentLeaseSchema.safeParse({}).success).toBe(false)
  })
})
