import { describe, expect, it, vi } from 'vitest'
import { DomainEmergencyStopRepository, apply, emergencyStopSurfaces, inject, type StudioEmergencyStopRuntime } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

function table() {
  const records = new Map<string, unknown>()
  return {
    get: (key: string) => records.get(key),
    entries: () => records.entries(),
    put: (key: string, value: unknown) => { records.set(key, value); return Promise.resolve() },
  }
}

const scope = { orgId: 'org-a', tenantId: 'tenant-a' }

describe('@dz23-studio/emergency-stop composition', () => {
  it('monta domínio, extensão HTTP e serviço, e NÃO exige os consumidores no `inject`', async () => {
    // Um plugin opcional listado em `inject` faria o Studio inteiro deixar de
    // subir em qualquer perfil que não o tivesse. Este erro já matou o portão
    // T3 uma vez neste repositório.
    expect(inject).toEqual(['storageDomain', 'studioIdentity'])
    expect(inject).not.toContain('studioPromptToApp')
    expect(inject).not.toContain('studioAgents')
    expect(inject).not.toContain('studioIntegrationHub')

    const stops = table()
    const close = vi.fn(() => Promise.resolve())
    let runtime!: StudioEmergencyStopRuntime
    const ctx = {
      storageDomain: { open: vi.fn(() => Promise.resolve({ table: () => stops, close })) },
      effect: vi.fn((factory: () => unknown) => factory()),
      provide: vi.fn((_name: string, value: StudioEmergencyStopRuntime) => { runtime = value }),
      studioIdentity: { service: { strongIdentityForSession: vi.fn(() => true) } },
      get: vi.fn(() => undefined),
    }
    await apply(ctx as never)
    expect(runtime.service.state(scope).stopped).toBe(false)
    await runtime.service.engage({ userId: 'u-1', ...scope, role: 'owner', sessionId: 's-1' }, 'Teste.')
    expect(runtime.service.state(scope).stopped).toBe(true)
    // O botão perguntou por cada consumidor, e nenhum estava montado.
    expect(ctx.get).toHaveBeenCalledWith('studioPromptToApp')
    expect(ctx.get).toHaveBeenCalledWith('studioAgents')
    expect(ctx.get).toHaveBeenCalledWith('studioIntegrationHub')
    await close()
  })
})

describe('as partes interrompidas pelo botão', () => {
  it('plugin ausente do perfil não vira pendência: não há nada rodando ali', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const outcomes = await Promise.all(emergencyStopSurfaces(ctx).map(surface => surface.cancel(scope)))
    expect(outcomes.map(outcome => [outcome.cancelled, outcome.unproven.length])).toEqual([[0, 0], [0, 0], [0, 0]])
  })

  it('conta o que parou e nomeia o que não pôde ser provado morto', async () => {
    const cancelScope = {
      promptToApp: vi.fn(() => ({ requested: 2, alreadyFinished: 1 })),
      agents: vi.fn(() => ({ cancelled: 1, unproven: [{ runId: 'run-7', provider: 'codex' }] })),
      hub: vi.fn(() => ['int-1', 'int-2']),
    }
    const ctx = {
      get: (name: string) => name === 'studioPromptToApp' ? { jobs: { cancelScope: cancelScope.promptToApp } }
        : name === 'studioAgents' ? { service: { cancelScope: cancelScope.agents } }
          : { service: { cancelScope: cancelScope.hub } },
    } as unknown as Context
    const [creations, agents, integrations] = await Promise.all(emergencyStopSurfaces(ctx).map(surface => surface.cancel(scope)))
    expect(creations?.cancelled).toBe(2)
    expect(cancelScope.promptToApp).toHaveBeenCalledWith(scope)
    // Um assistente externo recebeu o pedido; o Studio não consegue provar que
    // o processo dele terminou, e a tela precisa saber disso.
    expect(agents?.cancelled).toBe(1)
    expect(agents?.unproven).toEqual([{ what: 'run-7', why: expect.stringContaining('codex') }])
    // Uma chamada que já saiu para o provedor NUNCA é contada como cancelada.
    expect(integrations?.cancelled).toBe(0)
    expect(integrations?.unproven.map(item => item.what)).toEqual(['int-1', 'int-2'])
  })
})

describe('ACHADO: o armazenamento REAL recusa escrita pinada em versão velha', () => {
  it('o repositório de produção confere a versão, e não só o dublê do teste', async () => {
    // Esta prova existe porque a falsificação anterior NÃO reprovou: os testes
    // do serviço usam um repositório de memória PRÓPRIO, então remover a
    // condição do repositório de VERDADE não quebrava nada. Um teste que cobre
    // o dublê e deixa a produção descoberta é pior que nenhum, porque ocupa o
    // lugar do que faria falta.
    const stops = table()
    const repository = new DomainEmergencyStopRepository(stops as never)
    const registro = {
      scope_id: 'org-a:tenant-a', org_id: 'org-a', tenant_id: 'tenant-a', stopped: true,
      engaged_by: 'u-1', engaged_at: '2026-09-08T12:00:00.000Z', reason: 'incidente A',
      released_by: null, released_at: null, release_reason: null,
      updated_at: '2026-09-08T12:00:00.000Z',
    }
    // Primeira escrita: não havia registro, e a versão esperada é `null`.
    await repository.putStop(registro, null)
    expect(repository.stops()).toHaveLength(1)

    // Outro processo apertou o botão: a versão gravada mudou.
    await repository.putStop({ ...registro, reason: 'incidente B', updated_at: '2026-09-08T13:00:00.000Z' }, registro.updated_at)

    // A escrita que ainda carrega a versão VELHA é recusada.
    await expect(repository.putStop({ ...registro, stopped: false }, registro.updated_at))
      .rejects.toMatchObject({ code: 'STOP_CHANGED' })
    expect(repository.stops()[0]).toMatchObject({ stopped: true, reason: 'incidente B' })

    // E a escrita com a versão CERTA passa: a condição não pode travar tudo.
    await expect(repository.putStop(
      { ...registro, stopped: false, updated_at: '2026-09-08T14:00:00.000Z' },
      '2026-09-08T13:00:00.000Z',
    )).resolves.toBeUndefined()
  })
})
