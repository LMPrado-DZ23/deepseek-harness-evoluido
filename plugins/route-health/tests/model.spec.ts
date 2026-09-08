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

  it('mantem a versao do dominio e aceita registro sem os campos de circuito', () => {
    // `open()` falha com `version-mismatch` em qualquer instalação que já
    // rodou, e não existe passo de migração: os campos do circuito e do custo
    // entraram OPCIONAIS justamente para que a versão pudesse ficar em 1.
    expect(studioRouteHealthDomainSpec.version).toBe(1)
    const legacy = {
      record_id: 'org:tenant:omniroute', org_id: 'org', tenant_id: 'tenant', route: 'omniroute',
      state: 'OK', requests: 2, errors: 0, average_latency_ms: 10,
      input_tokens: 1, output_tokens: 1, estimated_cost_usd: 0,
      last_failure: null, updated_at: '2026-09-03T00:00:00.000Z',
    }
    expect(routeHealthRecordSchema.safeParse(legacy).success).toBe(true)
    expect(routeHealthRecordSchema.safeParse({
      ...legacy, unpriced_requests: 2, consecutive_failures: 3,
      circuit_opened_at: '2026-09-03T00:00:00.000Z',
    }).success).toBe(true)
    expect(routeHealthRecordSchema.safeParse({ ...legacy, circuit_opened_at: null }).success).toBe(true)
    expect(routeHealthRecordSchema.safeParse({ ...legacy, consecutive_failures: -1 }).success).toBe(false)
  })

  it('rejects incomplete route and audit records', () => {
    expect(routeHealthRecordSchema.safeParse({}).success).toBe(false)
    expect(routeSwitchEventSchema.safeParse({}).success).toBe(false)
  })
})
