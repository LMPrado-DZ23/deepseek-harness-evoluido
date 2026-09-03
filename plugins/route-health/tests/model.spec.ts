import { describe, expect, it } from 'vitest'
import {
  STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN,
  STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN,
  routeHealthRecordSchema,
  routeStateSchema,
  routeSwitchEventSchema,
  studioRouteHealthDomainSpec,
} from '../src/model.ts'

describe('Studio route-health domain', () => {
  it('pins the domain naming convention and accepted states', () => {
    expect(STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN).toBe('studio_route_health')
    expect(STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN).toBe('studio.route.health')
    expect(studioRouteHealthDomainSpec.name).toBe(STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN)
    expect(routeStateSchema.options).toEqual(['OK', 'DEGRADED', 'DOWN', 'NOT_CONFIGURED'])
  })

  it('rejects incomplete route and audit records', () => {
    expect(routeHealthRecordSchema.safeParse({}).success).toBe(false)
    expect(routeSwitchEventSchema.safeParse({}).success).toBe(false)
  })
})
