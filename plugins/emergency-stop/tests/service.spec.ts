import { describe, expect, it, vi } from 'vitest'
import type { EmergencyStopRecord } from '../src/model.ts'
import {
  EmergencyStopError,
  MIN_RELEASE_REASON_LENGTH,
  StudioEmergencyStopService,
  type EmergencyActor,
  type EmergencyStopRepository,
  type StopSurface,
} from '../src/service.ts'

/**
 * O disco. É uma classe e não um objeto literal porque a prova de que o estado
 * SOBREVIVE a um reinício depende de dois serviços diferentes lendo o mesmo
 * armazenamento - que é exatamente o que um reinício é.
 */
class MemoryRepository implements EmergencyStopRepository {
  readonly rows = new Map<string, EmergencyStopRecord>()
  stops() { return [...this.rows.values()] }
  putStop(record: EmergencyStopRecord) { this.rows.set(record.scope_id, record); return Promise.resolve() }
}

const owner: EmergencyActor = { userId: 'u-1', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner', sessionId: 's-1' }
const otherScope: EmergencyActor = { ...owner, userId: 'u-2', orgId: 'org-b', tenantId: 'tenant-b', sessionId: 's-2' }
const viewer: EmergencyActor = { ...owner, role: 'viewer' }

function service(options: {
  repository?: MemoryRepository
  strong?: boolean
  surfaces?: () => readonly StopSurface[]
} = {}) {
  const repository = options.repository ?? new MemoryRepository()
  return {
    repository,
    service: new StudioEmergencyStopService({
      repository,
      identity: { strongIdentityVerified: () => options.strong ?? true },
      ...(options.surfaces === undefined ? {} : { surfaces: options.surfaces }),
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    }),
  }
}

describe('E-11: parar é fácil, retomar é difícil', () => {
  it('parar não pede identidade forte nem motivo: em uma emergência ninguém procura a senha', async () => {
    // O contrário disto é o cenário que o requisito existe para impedir: alguém
    // vendo o incêndio, com permissão de escrever, obrigado a achar a chave de
    // acesso antes de apertar o botão.
    const h = service({ strong: false })
    const engaged = await h.service.engage(owner)
    expect(engaged.state.stopped).toBe(true)
    expect(engaged.state.engaged_by).toBe('u-1')
    expect(engaged.state.engaged_at).toBe('2026-09-08T12:00:00.000Z')
    expect(engaged.state.reason).toBeNull()
  })

  it('retomar sem identidade forte é recusado, mesmo com motivo escrito', async () => {
    const h = service({ strong: false })
    await h.service.engage(owner, 'Cliente ligou pedindo parada.')
    await expect(h.service.release(owner, 'O incidente terminou e conferimos os registros.'))
      .rejects.toMatchObject({ code: 'STRONG_IDENTITY_REQUIRED' })
    // E continua parado: uma recusa de retomada não pode religar nada.
    expect(h.service.state(owner).stopped).toBe(true)
  })

  it('retomar sem sessão é recusado: não conseguir verificar nunca vale por ter verificado', async () => {
    const h = service({ strong: true })
    await h.service.engage(owner)
    const { sessionId: _sessionId, ...sessionless } = owner
    await expect(h.service.release(sessionless, 'Conferi tudo e podemos voltar.'))
      .rejects.toMatchObject({ code: 'STRONG_IDENTITY_REQUIRED' })
    expect(h.service.state(owner).stopped).toBe(true)
  })

  it('retomar sem motivo escrito é recusado, e um motivo curto demais não conta como motivo', async () => {
    const h = service({ strong: true })
    await h.service.engage(owner)
    await expect(h.service.release(owner, '   ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expect(h.service.release(owner, 'ok')).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    expect('ok'.length).toBeLessThan(MIN_RELEASE_REASON_LENGTH)
    expect(h.service.state(owner).stopped).toBe(true)
  })

  it('com identidade forte e motivo escrito, retoma e registra quem assumiu a volta', async () => {
    const h = service({ strong: true })
    await h.service.engage(owner, 'Integração disparando cobrança em loop.')
    const released = await h.service.release(owner, 'Provedor confirmou a correção e conferimos a fatura.')
    expect(released.stopped).toBe(false)
    expect(released.released_by).toBe('u-1')
    expect(released.release_reason).toBe('Provedor confirmou a correção e conferimos a fatura.')
    // A história de quem parou NÃO é apagada pela retomada.
    expect(released.engaged_by).toBe('u-1')
    expect(released.reason).toBe('Integração disparando cobrança em loop.')
  })

  it('quem não pode escrever não para nem retoma', async () => {
    const h = service()
    await expect(h.service.engage(viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.service.release(viewer, 'Um motivo suficientemente longo.')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('retomar o que não está parado é recusado em vez de gravar uma retomada inventada', async () => {
    const h = service()
    await expect(h.service.release(owner, 'Um motivo suficientemente longo.')).rejects.toMatchObject({ code: 'INVALID' })
    expect(h.repository.rows.size).toBe(0)
  })

  it('um motivo absurdamente longo é recusado antes de virar registro', async () => {
    const h = service()
    await expect(h.service.engage(owner, 'x'.repeat(501))).rejects.toBeInstanceOf(EmergencyStopError)
  })
})

describe('E-11: parar barra trabalho novo', () => {
  it('assertRunning passa antes e lança depois', async () => {
    const h = service()
    expect(() => { h.service.assertRunning(owner) }).not.toThrow()
    await h.service.engage(owner)
    expect(() => { h.service.assertRunning(owner) }).toThrow(EmergencyStopError)
    try { h.service.assertRunning(owner) } catch (error) { expect((error as EmergencyStopError).code).toBe('STOPPED') }
  })

  it('um escopo parado NÃO afeta outro escopo', async () => {
    // A parada de uma organização segurando a de outra seria um incidente novo
    // criado pelo botão que existe para conter incidentes.
    const h = service()
    await h.service.engage(owner)
    expect(() => { h.service.assertRunning(otherScope) }).not.toThrow()
    expect(h.service.state(otherScope).stopped).toBe(false)
    await h.service.engage(otherScope)
    await h.service.release({ ...otherScope }, 'Conferimos o escopo B e liberamos.')
    // Retomar B não retoma A.
    expect(h.service.state(owner).stopped).toBe(true)
    expect(h.service.state(otherScope).stopped).toBe(false)
  })
})

describe('E-11: o estado sobrevive a um reinício', () => {
  it('um serviço novo sobre o mesmo armazenamento continua parado', async () => {
    // Reiniciar o Studio no meio de uma emergência não pode religar tudo em
    // silêncio: é isso que separa um botão de verdade de um botão de mentira.
    const repository = new MemoryRepository()
    await service({ repository }).service.engage(owner, 'Vazamento de dados suspeito.')
    const afterRestart = service({ repository }).service
    expect(afterRestart.state(owner).stopped).toBe(true)
    expect(afterRestart.state(owner).reason).toBe('Vazamento de dados suspeito.')
    expect(() => { afterRestart.assertRunning(owner) }).toThrow(EmergencyStopError)
  })
})

describe('E-11: parar cancela o que já está rodando', () => {
  it('varre todas as partes e soma o que parou e o que não pôde ser provado', async () => {
    const jobs = vi.fn(async () => ({ surface: 'criações', cancelled: 2, unproven: [] }))
    const agents = vi.fn(async () => ({
      surface: 'assistentes', cancelled: 1,
      unproven: [{ what: 'run-9', why: 'processo externo' }],
    }))
    const h = service({ surfaces: () => [{ id: 'criações', cancel: jobs }, { id: 'assistentes', cancel: agents }] })
    const engaged = await h.service.engage(owner, 'Parar tudo agora.')
    expect(jobs).toHaveBeenCalledWith({ orgId: 'org-a', tenantId: 'tenant-a' })
    expect(engaged.surfaces).toEqual([
      { surface: 'criações', cancelled: 2, unproven: [] },
      { surface: 'assistentes', cancelled: 1, unproven: [{ what: 'run-9', why: 'processo externo' }] },
    ])
  })

  it('uma parte que explode ao ser interrompida não derruba a parada nem some do relato', async () => {
    const h = service({
      surfaces: () => [
        { id: 'assistentes', cancel: () => Promise.reject(new Error('supervisor fora do ar')) },
        { id: 'integrações', cancel: async () => ({ surface: 'integrações', cancelled: 0, unproven: [] }) },
      ],
    })
    const engaged = await h.service.engage(owner)
    expect(engaged.state.stopped).toBe(true)
    expect(engaged.surfaces[0]?.unproven).toHaveLength(1)
    expect(engaged.surfaces[1]?.surface).toBe('integrações')
  })

  it('as partes são resolvidas A CADA aperto, para alcançar quem montou depois', async () => {
    // Capturar a lista na composição deixaria o botão morto para todo plugin
    // que subisse depois dele - e o botão anunciaria uma parada que não
    // aconteceu.
    let mounted: readonly StopSurface[] = []
    const h = service({ surfaces: () => mounted })
    expect((await h.service.engage(owner)).surfaces).toEqual([])
    mounted = [{ id: 'tardio', cancel: async () => ({ surface: 'tardio', cancelled: 3, unproven: [] }) }]
    expect((await h.service.engage(owner)).surfaces).toEqual([{ surface: 'tardio', cancelled: 3, unproven: [] }])
  })

  it('apertar duas vezes varre de novo, mas não reescreve quem parou', async () => {
    const h = service()
    await h.service.engage(owner, 'Primeiro motivo.')
    const second = await h.service.engage({ ...owner, userId: 'u-outro' }, 'Segundo motivo.')
    expect(second.state.engaged_by).toBe('u-1')
    expect(second.state.reason).toBe('Primeiro motivo.')
  })

  it('grava a parada ANTES de varrer: um processo que morre no meio volta parado', async () => {
    const repository = new MemoryRepository()
    const h = service({
      repository,
      surfaces: () => [{
        id: 'morre-no-meio',
        cancel: () => {
          // No instante em que a varredura roda, o disco já diz "parado".
          expect(repository.rows.get('org-a:tenant-a')?.stopped).toBe(true)
          return Promise.reject(new Error('processo morreu'))
        },
      }],
    })
    await h.service.engage(owner)
    expect(repository.rows.get('org-a:tenant-a')?.stopped).toBe(true)
  })
})
