import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { emergencyStopSurfaces } from '../src/index.js'

/**
 * PEDIR que pare e PROVAR que parou são coisas diferentes.
 *
 * A superfície das criações anunciava `cancelled: outcome.requested` com
 * `unproven: []`. O registro de trabalhos responde, literalmente,
 * `'requested' | 'already-finished'`: ele diz que o pedido saiu, não que a
 * criação terminou. Quem apertou o botão lia "2 canceladas" quando o fato era
 * "2 pedidos enviados, nenhum término confirmado" — e a superfície de
 * integrações, no mesmo arquivo, já se recusava a contar assim.
 *
 * Este arquivo é a regressão que a revisão independente pediu, escrita contra
 * as superfícies do produto e não contra um dublê do serviço.
 */
function contexto(runtimes: Record<string, unknown>): Context {
  return { get: (chave: string) => runtimes[chave] } as unknown as Context
}
const ESCOPO = { orgId: 'org-a', tenantId: 'tenant-a' }

describe('as superfícies da parada de emergência', () => {
  it('a criação em voo vira PENDÊNCIA NOMEADA, nunca cancelamento confirmado', async () => {
    const superficies = emergencyStopSurfaces(contexto({
      studioPromptToApp: { jobs: { cancelScope: () => ({ requested: 2, alreadyFinished: 1, requestedProjects: ['projeto-1', 'projeto-2'] }) } },
    }))
    const resultado = await superficies[0]!.cancel(ESCOPO)
    expect(resultado.cancelled).toBe(0)
    expect(resultado.unproven.map(item => item.what)).toEqual(['projeto-1', 'projeto-2'])
    // A já terminada não entra: ela não parou por causa do botão.
    expect(resultado.unproven).toHaveLength(2)
    for (const item of resultado.unproven) expect(item.why).toContain('não foi confirmado')
  })

  it('sem nada em voo, não inventa pendência nem cancelamento', async () => {
    const superficies = emergencyStopSurfaces(contexto({
      studioPromptToApp: { jobs: { cancelScope: () => ({ requested: 0, alreadyFinished: 3, requestedProjects: [] }) } },
    }))
    expect(await superficies[0]!.cancel(ESCOPO)).toMatchObject({ cancelled: 0, unproven: [] })
  })

  it('a superfície ausente devolve zero e zero, sem quebrar a parada', async () => {
    const superficies = emergencyStopSurfaces(contexto({}))
    for (const superficie of superficies) {
      expect(await superficie.cancel(ESCOPO)).toMatchObject({ cancelled: 0, unproven: [] })
    }
  })

  it('o assistente externo continua separando confirmado de não provado', async () => {
    const superficies = emergencyStopSurfaces(contexto({
      studioAgents: { service: { cancelScope: () => ({ cancelled: 1, unproven: [{ runId: 'run-9', provider: 'codex' }] }) } },
    }))
    const resultado = await superficies[1]!.cancel(ESCOPO)
    expect(resultado.cancelled).toBe(1)
    expect(resultado.unproven[0]!.what).toBe('run-9')
  })

  it('a integração que já saiu para a rede nunca conta como cancelada', async () => {
    const superficies = emergencyStopSurfaces(contexto({
      studioIntegrationHub: { service: { cancelScope: () => ['integracao-1'] } },
    }))
    const resultado = await superficies[2]!.cancel(ESCOPO)
    expect(resultado.cancelled).toBe(0)
    expect(resultado.unproven.map(item => item.what)).toEqual(['integracao-1'])
  })
})
