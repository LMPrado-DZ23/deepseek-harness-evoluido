import { describe, expect, it } from 'vitest'
import {
  STUDIO_AGENT_TEAMS_LOGICAL_DOMAIN,
  STUDIO_AGENT_TEAMS_PHYSICAL_DOMAIN,
  agentTeamSchema,
  agentTeamTaskSchema,
  studioAgentTeamsDomainSpec,
} from '../src/model.ts'

describe('Studio agent team domain', () => {
  it('uses the documented physical and logical names', () => {
    expect(STUDIO_AGENT_TEAMS_PHYSICAL_DOMAIN).toBe('studio_agent_teams')
    expect(STUDIO_AGENT_TEAMS_LOGICAL_DOMAIN).toBe('studio.agent.teams')
    expect(studioAgentTeamsDomainSpec.name).toBe(STUDIO_AGENT_TEAMS_PHYSICAL_DOMAIN)
    expect(Object.keys(studioAgentTeamsDomainSpec.tables)).toEqual(['teams', 'tasks'])
  })

  it('fails closed for incomplete or extended records', () => {
    expect(agentTeamSchema.safeParse({}).success).toBe(false)
    expect(agentTeamTaskSchema.safeParse({}).success).toBe(false)
    expect(agentTeamSchema.safeParse({ extra: true }).success).toBe(false)
    expect(agentTeamTaskSchema.safeParse({ extra: true }).success).toBe(false)
  })
})
