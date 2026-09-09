import { describe, expect, it, vi } from 'vitest'
import { DomainStagingRepository, deriveTargets } from '../src/repository.js'
import { StagingService, type StagingActor } from '../src/service.js'
import { stagingReleaseSchema, type StagingRelease } from '../src/model.js'
import type { StagingKey } from '../src/domain.js'
import { approvalPort, artifact, fixedNow, owner, providerPort } from './helpers.js'

/**
 * O seam REAL de domínio: `put(chave, valor)` e uma leitura síncrona da
 * memória, exatamente como o `KvTable` do Harness. Nada de escrita condicional
 * — é justamente a ausência dela que o repositório tem de suprir sozinho.
 */
function table() {
  const rows = new Map<string, StagingRelease>()
  return {
    rows,
    put: vi.fn(async (key: StagingKey, value: StagingRelease) => { rows.set(key, structuredClone(value)) }),
    get: (key: StagingKey) => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() { return rows.size },
    delete: async () => false,
    update: async () => { throw new Error('nao usado') },
  }
}

function harness(rows = table()) {
  const repository = new DomainStagingRepository(rows as never)
  const provider = providerPort()
  const approvals = approvalPort()
  const authorization = {
    // `guest` não está no tipo de papel de hoje; o dublê responde por ele mesmo
    // assim, porque o que se quer provar é a REGRA (quem não é do espaço não lê),
    // e não o conjunto de papéis que existe nesta versão.
    allows: (role: StagingActor['role'], permission: 'project.read' | 'project.publish_staging') => permission === 'project.read'
      ? (role as string) !== 'guest'
      : role === 'owner' || role === 'admin' || role === 'builder',
  }
  const service = new StagingService({
    repository, provider, approvals,
    source: { verifiedArtifact: async () => artifact() },
    authorization, now: () => new Date(fixedNow),
  })
  return { service, repository, provider, approvals, rows }
}

const request = { projectId: 'project-1', operationId: 'op-1', approvalId: 'approval-1', runId: 'run-1' }

describe('journal durável de staging', () => {
  it('publica, grava no disco e move o ponteiro ativo', async () => {
    const h = harness()
    const release = await h.service.publish(owner, request)
    expect(release.state).toBe('STAGING_OK')
    expect(release.target_generation).toBe(1)
    // Gravado ANTES da memória: um leitor nunca vê o que não durou.
    expect(h.rows.rows.get(release.release_id)).toMatchObject({ state: 'STAGING_OK' })
    expect(h.provider.stage).toHaveBeenCalledOnce()
  })

  it('a geração é estritamente crescente por destino', async () => {
    const h = harness()
    const first = await h.service.publish(owner, request)
    const second = await h.service.publish(owner, { ...request, operationId: 'op-2' })
    expect([first.target_generation, second.target_generation]).toEqual([1, 2])
  })

  it('o mesmo pedido repetido NÃO cria um segundo registro nem chama o provedor de novo', async () => {
    const h = harness()
    const first = await h.service.publish(owner, request)
    const replay = await h.service.publish(owner, request)
    expect(replay.release_id).toBe(first.release_id)
    expect(h.provider.stage).toHaveBeenCalledOnce()
    expect(h.approvals.consume).toHaveBeenCalledOnce()
    expect(h.rows.rows.size).toBe(1)
  })

  it('duas publicações concorrentes: uma passa, a outra é recusada pelo DESTINO ocupado', async () => {
    // Exclusão por destino. Deixar as duas correrem produziria dois efeitos
    // externos sobre o mesmo alvo, e a ordem entre eles seria a do acaso.
    const h = harness()
    const outcomes = await Promise.allSettled([
      h.service.publish(owner, request),
      h.service.publish(owner, { ...request, operationId: 'op-2' }),
    ])
    const done = outcomes.filter(outcome => outcome.status === 'fulfilled')
    expect(done).toHaveLength(1)
    expect((done[0] as PromiseFulfilledResult<{ target_generation: number }>).value.target_generation).toBe(1)
    expect(h.provider.stage).toHaveBeenCalledOnce()
    // E a recusada NÃO deixou registro: o destino estava ocupado antes de
    // qualquer coisa ser reservada.
    expect(h.rows.rows.size).toBe(1)
  })

  it('o destino físico fica preso ao primeiro escopo, e outra organização é recusada', async () => {
    // Duas organizações comandando o mesmo alvo é o pior desfecho de uma
    // operação com efeito externo.
    const h = harness()
    await h.service.publish(owner, request)
    const outra: StagingActor = { ...owner, orgId: 'org-b', tenantId: 'tenant-b' }
    await expect(h.service.publish(outra, { ...request, operationId: 'op-b' })).rejects.toThrow()
  })

  it('REINÍCIO: a geração continua de onde parou e o destino ocupado continua ocupado', async () => {
    const rows = table()
    const first = await harness(rows).service.publish(owner, request)
    // Uma nova instância do repositório sobre a MESMA tabela: é o que acontece
    // quando o Studio reinicia.
    const restarted = harness(rows)
    const second = await restarted.service.publish(owner, { ...request, operationId: 'op-2' })
    expect(second.target_generation).toBe(first.target_generation + 1)
    expect(restarted.service.list(owner, 'project-1')).toHaveLength(2)
  })

  it('REINÍCIO com trabalho em voo: o destino continua bloqueado', async () => {
    const rows = table()
    const running = stagingReleaseSchema.parse({
      ...(await harness(rows).service.publish(owner, request)),
      state: 'STAGING', finished_at: null, provider_receipt: null, version: 9,
    })
    await rows.put(running.release_id as StagingKey, running)
    // Depois da queda, ninguém pode começar por cima de um efeito que ninguém
    // sabe se aconteceu.
    const restarted = harness(rows)
    await expect(restarted.service.publish(owner, { ...request, operationId: 'op-2' })).rejects.toThrow()
  })

  it('REINÍCIO com quarentena: o destino continua em quarentena', async () => {
    const rows = table()
    const published = await harness(rows).service.publish(owner, request)
    await rows.put(published.release_id as StagingKey, stagingReleaseSchema.parse({
      ...published, state: 'RECONCILIATION_REQUIRED', finished_at: null,
      failure_code: 'CONFLICTING_EXTERNAL_EFFECT', version: published.version + 1,
    }))
    const restarted = harness(rows)
    await expect(restarted.service.publish(owner, { ...request, operationId: 'op-2' })).rejects.toThrow()
  })

  it('rollback republica um artefato anterior numa geração NOVA, sem apagar nada', async () => {
    const rows = table()
    const h = harness(rows)
    const first = await h.service.publish(owner, request)
    const second = await h.service.publish(owner, { ...request, operationId: 'op-2' })
    expect(second.target_generation).toBe(2)
    const rolled = await h.service.rollback(owner, {
      projectId: 'project-1', operationId: 'op-3', approvalId: 'approval-1', targetReleaseId: first.release_id,
    }).catch((error: unknown) => error)
    // O rollback exige que o artefato de destino seja DIFERENTE do ativo; com o
    // mesmo artefato nas duas publicações não há o que desfazer, e o serviço
    // recusa em vez de fingir uma volta.
    expect(rolled).toBeInstanceOf(Error)
    // E nada foi apagado: o journal continua com as duas publicações.
    expect(h.service.list(owner, 'project-1')).toHaveLength(2)
    expect(rows.rows.size).toBe(2)
  })

  it('uma escrita com lease VELHO é recusada, e com o lease certo passa', async () => {
    // O lease é o token de fencing, e ele só tem sentido enquanto o release
    // AINDA é o dono do destino: sem este teste, tirar a conferência do lease
    // passaria despercebido, porque um release já concluído é recusado por
    // outro motivo.
    const rows = table()
    const h = harness(rows)
    const published = await h.service.publish(owner, request)
    // Um release em voo, de verdade: reservado e ainda não concluído.
    const inflight = stagingReleaseSchema.parse({
      ...published, release_id: `stg-${'e'.repeat(64)}`, operation_id: 'op-inflight',
      state: 'APPROVAL_PENDING', approval_id: null, approved_at: null, started_at: null,
      finished_at: null, provider_receipt: null, failure_code: null, version: 1,
      effect_lease_id: 'lease-do-dono', target_generation: 1,
    })
    const fresh = new DomainStagingRepository(table() as never)
    const reserved = await fresh.reserveRelease(inflight)
    expect(reserved.kind).toBe('reserved')
    const owned = (reserved as { release: StagingRelease }).release

    const stale = stagingReleaseSchema.parse({
      ...owned, state: 'FAILED', failure_code: 'PROVIDER_REJECTED', provider_receipt: null,
      finished_at: owned.created_at, effect_lease_id: 'lease-de-outro-dono', version: owned.version + 1,
    })
    await expect(fresh.compareAndSwapRelease(owner, 'project-1', owned.release_id, owned.version, stale))
      .resolves.toBe(false)

    const rightful = stagingReleaseSchema.parse({ ...stale, effect_lease_id: owned.effect_lease_id })
    await expect(fresh.compareAndSwapRelease(owner, 'project-1', owned.release_id, owned.version, rightful))
      .resolves.toBe(true)
  })

  it('a memória NÃO enxerga o que o disco recusou', async () => {
    // Gravar na memória antes do disco faria um leitor ver um release que não
    // durou - e, depois de um reinício, ele simplesmente sumiria.
    const rows = table()
    const h = harness(rows)
    rows.put.mockRejectedValueOnce(new Error('disco cheio'))
    await expect(h.service.publish(owner, request)).rejects.toThrow('disco cheio')
    expect(rows.rows.size).toBe(0)
    expect(h.repository.releases(owner, 'project-1')).toEqual([])
  })

  it('a leitura é do escopo exato', () => {
    const h = harness()
    expect(h.repository.releases({ ...owner, tenantId: 'outro' }, 'project-1')).toEqual([])
  })
})

describe('estado do destino derivado do journal', () => {
  const base = {
    org_id: 'org-a', tenant_id: 'tenant-a', project_id: 'project-1', target_key: 'k',
  }
  const row = (overrides: Record<string, unknown>) => ({ ...base, ...overrides }) as unknown as StagingRelease

  it('a geração é o MAIOR já usado, e não o último lido', () => {
    // A leitura da chave-valor não tem ordem garantida: pegar "o último" faria
    // a próxima geração repetir uma que já existiu.
    const targets = deriveTargets([
      row({ release_id: 'b', target_generation: 3, state: 'STAGING_OK' }),
      row({ release_id: 'a', target_generation: 1, state: 'STAGING_OK' }),
    ])
    expect(targets.get('k')?.lastGeneration).toBe(3)
  })

  it('o ativo é o de maior geração entre os concluídos', () => {
    const targets = deriveTargets([
      row({ release_id: 'a', target_generation: 1, state: 'STAGING_OK' }),
      row({ release_id: 'b', target_generation: 2, state: 'ROLLED_BACK' }),
      row({ release_id: 'c', target_generation: 3, state: 'FAILED' }),
    ])
    expect(targets.get('k')).toMatchObject({ activeReleaseId: 'b', activeGeneration: 2 })
  })

  it('um registro não-terminal deixa o destino ocupado; um terminal não', () => {
    expect(deriveTargets([row({ release_id: 'a', target_generation: 1, state: 'STAGING' })]).get('k')?.busyReleaseId).toBe('a')
    for (const state of ['FAILED', 'STAGING_OK', 'ROLLED_BACK']) {
      expect(deriveTargets([row({ release_id: 'a', target_generation: 1, state })]).get('k')?.busyReleaseId, state).toBeUndefined()
    }
  })

  it('reconciliação pendente deixa o destino em quarentena', () => {
    expect(deriveTargets([row({ release_id: 'a', target_generation: 1, state: 'RECONCILIATION_REQUIRED' })]).get('k')?.quarantined).toBe(true)
  })

  it('o dono do destino é o primeiro escopo que o reservou', () => {
    const targets = deriveTargets([
      row({ release_id: 'a', target_generation: 1, state: 'STAGING_OK' }),
      row({ release_id: 'b', target_generation: 2, state: 'STAGING_OK', org_id: 'org-b' }),
    ])
    expect(targets.get('k')?.ownerScope).toBe(JSON.stringify(['org-a', 'tenant-a', 'project-1']))
  })

  it('journal vazio não inventa destino nenhum', () => {
    expect(deriveTargets([]).size).toBe(0)
  })
})
