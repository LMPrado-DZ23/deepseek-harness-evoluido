import { describe, expect, it, vi } from 'vitest'
import {
  completeMission, declareCandidate, isMissionCompletion, isMissionSpend, isMissionPath, isMissionView,
  listMissions, MISSION_PATH, MissionRequestError, type MissionPort, type MissionView,
} from './missionApi'

function mission(over: Partial<MissionView> = {}): MissionView {
  return {
    mission_id: 'm1', objective: 'Terminar com prova', status: 'RUNNING', max_total_tokens: 1_000,
    run_ids: ['r1'],
    criteria: [{ criterion_id: 'suite', statement: 'A suite passa', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
    created_at: '2026-09-12T00:00:00.000Z', updated_at: '2026-09-12T00:00:00.000Z',
    spend: { kind: 'WITHIN', spent: 300, limit: 1_000 },
    completion: { kind: 'UNPROVEN', criteria: ['suite'] },
    ...over,
  }
}

function port(status: number, body: unknown): { port: MissionPort; fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }))
  return { port: { fetch: fetchMock }, fetch: fetchMock }
}

const csrf = async () => 'csrf-token'

describe('o endereco da tela', () => {
  it('responde pelo proprio caminho e pelo que vem abaixo dele', () => {
    expect(isMissionPath(MISSION_PATH)).toBe(true)
    expect(isMissionPath(`${MISSION_PATH}/m1`)).toBe(true)
    expect(isMissionPath('/studio/')).toBe(false)
    // Um prefixo PARECIDO nao pode casar: `/studio/objetivos-antigos` e outra
    // tela, e casar com ela deixaria a pessoa numa lista que nao e a dela.
    expect(isMissionPath('/studio/objetivosantigos')).toBe(false)
  })
})

describe('uma missao pela metade NAO e desenhada', () => {
  it('a missao inteira passa', () => {
    expect(isMissionView(mission())).toBe(true)
  })

  it('sem nenhum item combinado, nao passa', () => {
    // Um objetivo sem lista do que precisa estar comprovado nao e um objetivo:
    // e uma frase. Desenha-lo daria a impressao de que nao falta nada.
    expect(isMissionView(mission({ criteria: [] }))).toBe(false)
  })

  it('item com estado que a tela nao conhece derruba a missao inteira', () => {
    // Descartar SO o item mostraria a lista com uma linha a menos e diria, em
    // silencio, que aquele item nao faz parte do combinado.
    const quebrada = { ...mission(), criteria: [{ criterion_id: 'x', statement: 'algo', state: 'INVENTADO', evidence: null, blocked_reason: null }] }
    expect(isMissionView(quebrada)).toBe(false)
  })

  it('gasto sem os numeros nao passa, e `UNMEASURED` exige dizer QUAL trabalho', () => {
    expect(isMissionSpend({ kind: 'WITHIN', spent: 1 })).toBe(false)
    expect(isMissionSpend({ kind: 'UNMEASURED', limit: 10 })).toBe(false)
    expect(isMissionSpend({ kind: 'UNMEASURED', runId: 'r7', limit: 10 })).toBe(true)
    expect(isMissionSpend({ kind: 'NO_LIMIT' })).toBe(true)
    // Numero quebrado ou negativo nao e medida.
    expect(isMissionSpend({ kind: 'WITHIN', spent: -1, limit: 10 })).toBe(false)
    expect(isMissionSpend({ kind: 'WITHIN', spent: 1.5, limit: 10 })).toBe(false)
  })

  it('veredito que nao e PROVEN precisa NOMEAR os itens', () => {
    // "Ainda falta" sem dizer o que falta e uma frase que nao ajuda ninguem.
    expect(isMissionCompletion({ kind: 'UNPROVEN', criteria: [] })).toBe(false)
    expect(isMissionCompletion({ kind: 'UNPROVEN', criteria: ['suite'] })).toBe(true)
    expect(isMissionCompletion({ kind: 'BLOCKED_EXTERNAL', criteria: ['x'] })).toBe(false)
    expect(isMissionCompletion({ kind: 'BLOCKED_EXTERNAL', criteria: ['x'], reasons: ['aparelho'] })).toBe(true)
    expect(isMissionCompletion({ kind: 'PROVEN' })).toBe(true)
  })
})

describe('a leitura da lista', () => {
  it('descarta a missao incompleta e mantem as inteiras', async () => {
    const f = port(200, { missions: [mission(), { mission_id: 'quebrada' }] })
    await expect(listMissions(f.port)).resolves.toHaveLength(1)
  })

  it('erro do servidor vira a frase do servidor, e nao uma generica', async () => {
    const f = port(403, { error: 'Seu papel neste espaço de trabalho não permite esta ação.' })
    await expect(listMissions(f.port)).rejects.toThrow('Seu papel')
  })

  it('resposta sem a lista e recusada em vez de virar lista vazia', async () => {
    // Lista vazia e uma AFIRMACAO: "voce nao tem nenhum objetivo". Uma resposta
    // que nao foi entendida nao pode virar essa afirmacao.
    const f = port(200, { inventado: true })
    await expect(listMissions(f.port)).rejects.toBeInstanceOf(MissionRequestError)
  })
})

describe('os dois gestos sao pedidos diferentes', () => {
  it('marcar como terminado chama `/candidate` com o token de CSRF', async () => {
    const f = port(200, { mission: mission({ status: 'CANDIDATE_COMPLETED' }) })
    await declareCandidate('m1', f.port, csrf)
    expect(f.fetch).toHaveBeenCalledWith('/api/studio/missions/missions/m1/candidate', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-dz23-csrf': 'csrf-token' }),
    }))
  })

  it('encerrar chama `/complete`, que e outro endereco', async () => {
    const f = port(200, { mission: mission({ status: 'COMPLETED' }) })
    await completeMission('m1', f.port, csrf)
    expect(f.fetch.mock.calls[0]![0]).toBe('/api/studio/missions/missions/m1/complete')
  })

  it('a recusa do servidor chega inteira, porque e nela que esta o que falta', async () => {
    const f = port(409, { error: 'Ainda falta comprovar os itens suite, leiga.' })
    await expect(completeMission('m1', f.port, csrf)).rejects.toThrow('suite, leiga')
  })

  it('identificador com caractere especial e escapado no endereco', async () => {
    const f = port(200, { mission: mission() })
    await declareCandidate('a/b', f.port, csrf)
    expect(f.fetch.mock.calls[0]![0]).toBe('/api/studio/missions/missions/a%2Fb/candidate')
  })

  it('resposta que nao e uma missao inteira e recusada', async () => {
    const f = port(200, { mission: { mission_id: 'm1' } })
    await expect(declareCandidate('m1', f.port, csrf)).rejects.toBeInstanceOf(MissionRequestError)
  })
})
