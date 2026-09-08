import { describe, expect, it } from 'vitest'
import {
  STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN,
  STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN,
  routeHealthRecordSchema,
  routePrivacySchema,
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
    // O liga/desliga entrou pelo mesmo motivo e com a mesma regra: ausente e
    // LIGADA, e o registro antigo continua valendo sem tocar na versao.
    expect(studioRouteHealthDomainSpec.version).toBe(1)
    expect(routeHealthRecordSchema.safeParse({ ...legacy, enabled: false }).success).toBe(true)
    expect(routeHealthRecordSchema.safeParse({ ...legacy, enabled: 'nao' }).success).toBe(false)
  })

  it('aceita o perfil novo e o valor binario antigo na mesma enumeracao', () => {
    // Subir a versao do dominio para trocar o binario pelos nomes faria
    // `open()` falhar com `version-mismatch` em toda instalacao existente: por
    // isso os cinco valores convivem, e a traducao acontece no codigo.
    for (const value of ['privado-local', 'equilibrado', 'melhor-qualidade', 'local-only', 'any']) {
      expect(routePrivacySchema.safeParse(value).success, value).toBe(true)
    }
    expect(routePrivacySchema.safeParse('qualquer-um').success).toBe(false)
  })

  it('rejects incomplete route and audit records', () => {
    expect(routeHealthRecordSchema.safeParse({}).success).toBe(false)
    expect(routeSwitchEventSchema.safeParse({}).success).toBe(false)
  })
})

describe('M-03 — o esquema recusa o que não é uma resposta', () => {
  it('janela de contexto tem de ser um inteiro POSITIVO: `0` seria lido como "não cabe nada"', () => {
    const base = routeHealthRecordSchema.parse({
      record_id: 'r', org_id: 'o', tenant_id: 't', route: 'x', state: 'OK',
      requests: 0, errors: 0, average_latency_ms: 0, input_tokens: 0, output_tokens: 0,
      estimated_cost_usd: 0, last_failure: null, updated_at: '2026-09-08T00:00:00.000Z',
    })
    for (const value of [0, -1, 1.5, '128000']) {
      expect(routeHealthRecordSchema.safeParse({ ...base, context_window_tokens: value }).success).toBe(false)
    }
    expect(routeHealthRecordSchema.safeParse({ ...base, context_window_tokens: 128_000 }).success).toBe(true)
    // Ausente continua valendo: é o estado DESCONHECIDO.
    expect(routeHealthRecordSchema.safeParse(base).success).toBe(true)
  })

  it('a privacidade só aceita `local` ou `externa`: texto livre viraria uma promessa qualquer', () => {
    const base = routeHealthRecordSchema.parse({
      record_id: 'r', org_id: 'o', tenant_id: 't', route: 'x', state: 'OK',
      requests: 0, errors: 0, average_latency_ms: 0, input_tokens: 0, output_tokens: 0,
      estimated_cost_usd: 0, last_failure: null, updated_at: '2026-09-08T00:00:00.000Z',
    })
    for (const value of ['LOCAL', 'privado-local', 'externo', '', 'sim']) {
      expect(routeHealthRecordSchema.safeParse({ ...base, privacy: value }).success).toBe(false)
    }
    for (const value of ['local', 'externa']) {
      expect(routeHealthRecordSchema.safeParse({ ...base, privacy: value }).success).toBe(true)
    }
  })

  it('suporte a ferramentas é booleano, e ausente NÃO é `false`', () => {
    const base = routeHealthRecordSchema.parse({
      record_id: 'r', org_id: 'o', tenant_id: 't', route: 'x', state: 'OK',
      requests: 0, errors: 0, average_latency_ms: 0, input_tokens: 0, output_tokens: 0,
      estimated_cost_usd: 0, last_failure: null, updated_at: '2026-09-08T00:00:00.000Z',
    })
    expect(routeHealthRecordSchema.safeParse({ ...base, supports_tools: 'sim' }).success).toBe(false)
    expect(routeHealthRecordSchema.parse(base).supports_tools).toBeUndefined()
  })
})
