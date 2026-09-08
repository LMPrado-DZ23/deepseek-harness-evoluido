import { describe, expect, it, vi } from 'vitest'
import copy from '../i18n/team.pt-BR.json'
import { ConversationRequestError } from '../assistant/conversationApi'
import {
  TEAMS_ENDPOINT, isTeamCard, isTeamPanel, isTeamPath, isTeamTask,
  listTeams, readTeam, stopTeam, teamIdFromPath,
} from './teamApi'

const TEAM = '11111111-2222-4333-8444-555555555555'

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'implementar', title: 'Implementar', role: 'implementer', status: 'RUNNING',
    depends_on: [], intended_paths: ['src/a.ts'], blocked: false, diagnostic: null,
    evidence: { state: 'NOT_EXECUTED' }, updated_at: '2026-09-08T00:00:00.000Z', ...overrides,
  }
}

function panel(overrides: Record<string, unknown> = {}) {
  return {
    team_id: TEAM, name: 'Equipe', status: 'RUNNING', updated_at: '2026-09-08T00:00:00.000Z',
    workspace_id: 'meu-projeto', required_tier: 'T2', sensitive_operation: null,
    approved_by: 'user-1', approved_at: '2026-09-08T00:00:00.000Z', diagnostic: null,
    created_at: '2026-09-08T00:00:00.000Z', tasks: [task()],
    cost: { state: 'NOT_MEASURED', reason: 'O Studio ainda não mede o custo.' },
    ...overrides,
  }
}

const csrf = async () => 'csrf-1'

describe('endereços da tela de progresso', () => {
  it('a lista e um trabalho, e nada além disso', () => {
    expect(isTeamPath('/studio/progresso')).toBe(true)
    expect(isTeamPath(`/studio/progresso/${TEAM}`)).toBe(true)
    expect(isTeamPath('/studio/progressos')).toBe(false)
    expect(isTeamPath('/studio/assistente')).toBe(false)
    expect(teamIdFromPath('/studio/progresso')).toBeNull()
    expect(teamIdFromPath(`/studio/progresso/${TEAM}`)).toBe(TEAM)
    expect(teamIdFromPath(`/studio/progresso/${TEAM}/`)).toBe(TEAM)
    // Um identificador inventado não vira leitura: seria um pedido ao servidor
    // com texto que o navegador escolheu.
    expect(teamIdFromPath('/studio/progresso/nao-uuid')).toBeNull()
    expect(teamIdFromPath('/studio/progresso/../../etc')).toBeNull()
  })
})

describe('o que a tela aceita desenhar', () => {
  it('meio cartão não vira trabalho na lista', () => {
    expect(isTeamCard({ team_id: TEAM, name: 'x', status: 'RUNNING', updated_at: 'agora' })).toBe(true)
    for (const broken of [
      null, [], 'texto', { team_id: 'x', name: 'x', status: 'RUNNING', updated_at: 'agora' },
      { team_id: TEAM, name: '', status: 'RUNNING', updated_at: 'agora' },
      { team_id: TEAM, name: 'x', status: '', updated_at: 'agora' },
      { team_id: TEAM, name: 'x', status: 'RUNNING' },
    ]) expect(isTeamCard(broken), JSON.stringify(broken)).toBe(false)
  })

  it('meia etapa não vira galho da árvore', () => {
    expect(isTeamTask(task())).toBe(true)
    for (const broken of [
      task({ task_id: 'MAIÚSCULA' }), task({ title: '' }), task({ depends_on: 'implementar' }),
      task({ depends_on: [1] }), task({ blocked: 'sim' }), task({ intended_paths: null }),
      task({ evidence: { state: 'OUTRA' } }),
      task({ evidence: { state: 'MEASURED', changed_files: ['a'], diff_bytes: -1, diff_sha256: 'x', base_commit: 'abc', main_changed_during_run: false } }),
      task({ evidence: { state: 'MEASURED', changed_files: ['a'], diff_bytes: 1, diff_sha256: 'x', base_commit: '', main_changed_during_run: false } }),
    ]) expect(isTeamTask(broken), JSON.stringify(broken)).toBe(false)
  })

  it('painel sem custo declarado é recusado', () => {
    expect(isTeamPanel(panel())).toBe(true)
    // Sem esta recusa, um servidor antigo que não manda `cost` faria a tela
    // desenhar o painel SEM a frase que diz que ninguém mediu — e o silêncio
    // seria lido como "não custou".
    expect(isTeamPanel(panel({ cost: undefined }))).toBe(false)
    expect(isTeamPanel(panel({ cost: { state: 'MEASURED', reason: 'x' } }))).toBe(false)
    expect(isTeamPanel(panel({ cost: { state: 'NOT_MEASURED', reason: '' } }))).toBe(false)
  })

  it('painel com uma etapa quebrada é recusado INTEIRO', () => {
    // Descartar a etapa mostraria uma árvore com um galho a menos, e ninguém
    // saberia que ele existia.
    expect(isTeamPanel(panel({ tasks: [task(), task({ title: '' })] }))).toBe(false)
  })
})

describe('leitura', () => {
  it('a lista pede sem corpo e descarta cartão pela metade', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({
      teams: [{ team_id: TEAM, name: 'Equipe', status: 'RUNNING', updated_at: 'agora' }, { team_id: 'x' }],
    }))
    expect(await listTeams({ fetch: fetchMock })).toHaveLength(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(TEAMS_ENDPOINT)
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined()
  })

  it('envelope estranho não vira lista vazia', async () => {
    // "Nenhum trabalho" e "não entendi a resposta" são coisas diferentes, e a
    // primeira tranquiliza a pessoa sobre algo que ninguém verificou.
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ items: [] }))
    await expect(listTeams({ fetch: fetchMock })).rejects.toThrow(copy.invalidServerResponse)
  })

  it('a falha do servidor chega em português e não vira sucesso', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ error: 'caiu' }, { status: 500 }))
    const erro = await listTeams({ fetch: fetchMock }).catch((reason: unknown) => reason)
    expect(erro).toBeInstanceOf(ConversationRequestError)
    expect((erro as ConversationRequestError).message).toBe('caiu')
    expect((erro as ConversationRequestError).retryable).toBe(true)
  })

  it('o painel é lido pelo identificador', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ team: panel() }))
    const read = await readTeam(TEAM, { fetch: fetchMock })
    expect(read.team_id).toBe(TEAM)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${TEAMS_ENDPOINT}/${TEAM}`)
  })
})

describe('parada', () => {
  it('manda só o motivo, com CSRF, e nunca quem está parando', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ team: panel({ status: 'CANCELLED' }) }))
    await stopTeam(TEAM, '  errei o pedido  ', { fetch: fetchMock }, csrf)
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe(`${TEAMS_ENDPOINT}/${TEAM}/stop`)
    expect((init.headers as Record<string, string>)['x-dz23-csrf']).toBe('csrf-1')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    // Exatamente uma chave. `approved_by` deixaria o navegador escolher a
    // autoria da parada, que é a única coisa que ele não pode escolher.
    expect(Object.keys(body)).toEqual(['reason'])
    expect(body.reason).toBe('errei o pedido')
  })

  it('motivo em branco vira corpo vazio, e não a string vazia', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ team: panel() }))
    await stopTeam(TEAM, '   ', { fetch: fetchMock }, csrf)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({})
  })

  it('cada recusa vira a frase que diz o que fazer', async () => {
    for (const [code, expected] of [
      ['FORBIDDEN', copy.stopForbidden], ['CONFLICT', copy.stopAlreadyOver], ['OUTRO', copy.stopError],
    ] as const) {
      const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ code }, { status: 403 }))
      await expect(stopTeam(TEAM, '', { fetch: fetchMock }, csrf), code).rejects.toThrow(expected)
    }
  })

  it('a mensagem do servidor tem precedência sobre a frase local', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ error: 'motivo exato', code: 'FORBIDDEN' }, { status: 403 }))
    await expect(stopTeam(TEAM, '', { fetch: fetchMock }, csrf)).rejects.toThrow('motivo exato')
  })

  it('resposta sem painel não conta como parada feita', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ team: { team_id: TEAM } }))
    await expect(stopTeam(TEAM, '', { fetch: fetchMock }, csrf)).rejects.toThrow(copy.invalidServerResponse)
  })
})
