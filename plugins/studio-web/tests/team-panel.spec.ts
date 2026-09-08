import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  TEAM_PANEL_PREFIX,
  TeamPanelError,
  handleTeamPanel,
  routeTeamPanel,
  taskCost,
  taskEvidence,
  teamCardsFor,
  teamCost,
  teamPanelStatus,
  teamPanelView,
  type TaskRecordShape,
  type TeamPanelRunsSource,
  type TeamPanelTeamsSource,
  type TeamRecordShape,
} from '../src/team-panel.ts'
import { SESSION_COOKIE, type StudioIdentityService } from '@dz23-studio/identity'

const TEAM = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

function team(overrides: Partial<TeamRecordShape> = {}): TeamRecordShape {
  return {
    team_id: TEAM, org_id: 'org-1', tenant_id: 'tenant-1', workspace_id: 'meu-projeto',
    name: 'Arrumar o cadastro', status: 'RUNNING', required_tier: 'T2', sensitive_operation: null,
    approved_by: 'user-1', approved_at: '2026-09-08T00:00:00.000Z', diagnostic: null,
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:05:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<TaskRecordShape> = {}): TaskRecordShape {
  return {
    task_id: 'implementar', team_id: TEAM, title: 'Implementar o formulário', role: 'implementer',
    status: 'RUNNING', run_id: 'run-1', depends_on: [], intended_paths: ['src/form.tsx'],
    diagnostic: null, created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:04:00.000Z',
    ...overrides,
  }
}

const RUN = {
  run_id: 'run-1', changed_files: ['src/form.tsx'], diff_bytes: 1234,
  diff_sha256: 'a'.repeat(64), base_commit: 'abcdef1', main_changed_during_run: false,
}

function runs(rows: readonly (typeof RUN)[] = [RUN]): TeamPanelRunsSource {
  return { runs: () => rows }
}

function teams(
  rows: readonly TeamRecordShape[] = [team()],
  tasks: readonly TaskRecordShape[] = [task()],
  overrides: Partial<TeamPanelTeamsSource['service']> = {},
): TeamPanelTeamsSource {
  return {
    teams: () => rows,
    service: {
      status: async (teamId: string) => ({ team: rows.find(row => row.team_id === teamId)!, tasks }),
      cancel: async (teamId: string) => ({
        team: { ...rows.find(row => row.team_id === teamId)!, status: 'CANCELLED' }, tasks,
      }),
      ...overrides,
    },
  }
}

function request(method: string, body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  return Object.assign(stream, {
    headers: { cookie: `${SESSION_COOKIE}=token` }, method,
  }) as unknown as IncomingMessage
}

const identity = {
  authenticate: vi.fn(() => Promise.resolve({
    session_id: 'session', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
  })),
  validateCsrfToken: vi.fn(),
} as unknown as StudioIdentityService

describe('roteamento do painel de equipe', () => {
  it('a lista lê, e nada mais', () => {
    expect(routeTeamPanel('GET', TEAM_PANEL_PREFIX)).toEqual({ kind: 'list' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(routeTeamPanel(method, TEAM_PANEL_PREFIX)).toEqual({ kind: 'method-not-allowed' })
    }
  })

  it('a equipe lê pelo identificador, e para pelo sufixo', () => {
    expect(routeTeamPanel('GET', `${TEAM_PANEL_PREFIX}/${TEAM}`)).toEqual({ kind: 'detail', teamId: TEAM })
    expect(routeTeamPanel('POST', `${TEAM_PANEL_PREFIX}/${TEAM}/stop`)).toEqual({ kind: 'stop', teamId: TEAM })
    expect(routeTeamPanel('GET', `${TEAM_PANEL_PREFIX}/${TEAM}/stop`)).toEqual({ kind: 'method-not-allowed' })
    expect(routeTeamPanel('POST', `${TEAM_PANEL_PREFIX}/${TEAM}`)).toEqual({ kind: 'method-not-allowed' })
  })

  it('identificador que não é UUID não é deste painel', () => {
    // Não é 404: responder "não encontrei" a um caminho que não é nosso
    // esconderia uma rota vizinha atrás de uma resposta deste módulo.
    for (const path of [
      `${TEAM_PANEL_PREFIX}/../etc`, `${TEAM_PANEL_PREFIX}/nao-uuid`, `${TEAM_PANEL_PREFIX}/${TEAM}/stop/agora`,
      `${TEAM_PANEL_PREFIX}/${TEAM}/tasks`, '/studio/teamsX', '/studio/assistant',
    ]) {
      expect(routeTeamPanel('GET', path), path).toBeUndefined()
    }
  })
})

describe('projeção para a tela', () => {
  it('o custo aparece como NÃO MEDIDO, e nunca como zero', () => {
    // Um `0` aqui seria lido como "esta equipe não custou nada". Ninguém mediu.
    const view = teamPanelView(team(), [task()], runs())
    expect(view.cost.state).toBe('NOT_MEASURED')
    expect(JSON.stringify(view.cost)).not.toContain('0')
    expect(view.cost.reason.length).toBeGreaterThan(20)
  })

  it('nenhum caminho absoluto do computador atravessa', () => {
    const view = teamPanelView(
      { ...team(), name: 'equipe' } as TeamRecordShape & { repository_path?: string },
      [task()],
      runs(),
    )
    const serialized = JSON.stringify(view)
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/home\/|\/var\/lib\/|\/tmp\//u)
    expect(Object.keys(view)).not.toContain('org_id')
    expect(Object.keys(view)).not.toContain('tenant_id')
    expect(serialized).not.toContain('prompt')
  })

  it('a dependência entre etapas atravessa: sem ela não há árvore', () => {
    const view = teamPanelView(team(), [
      task(),
      task({ task_id: 'revisar', depends_on: ['implementar'], status: 'QUEUED', run_id: null }),
    ], runs())
    expect(view.tasks.map(entry => entry.depends_on)).toEqual([[], ['implementar']])
  })

  it('etapa em fila diz NOT_EXECUTED, e não "zero arquivos"', () => {
    const view = teamPanelView(team(), [task({ run_id: null, status: 'QUEUED' })], runs())
    expect(view.tasks[0]!.evidence).toEqual({ state: 'NOT_EXECUTED' })
    // A leitura errada que isto impede: "0 arquivos mudados" ao lado de uma
    // etapa que ainda não começou lê-se como trabalho feito sem efeito.
    expect(JSON.stringify(view.tasks[0]!.evidence)).not.toContain('diff_bytes')
  })

  it('a evidência medida carrega arquivos, tamanho e a base', () => {
    const { run_id: _ignored, ...measured } = RUN
    expect(taskEvidence('run-1', runs())).toEqual({ state: 'MEASURED', ...measured })
  })

  it('execução que sumiu do runtime não vira evidência inventada', () => {
    expect(taskEvidence('run-perdida', runs())).toEqual({ state: 'NOT_EXECUTED' })
    expect(taskEvidence('run-1', undefined)).toEqual({ state: 'NOT_EXECUTED' })
  })

  it('só as etapas que pedem gente aparecem bloqueadas', () => {
    for (const status of ['FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'REJECTED', 'UNKNOWN']) {
      expect(teamPanelView(team(), [task({ status })], runs()).tasks[0]!.blocked, status).toBe(true)
    }
    for (const status of ['QUEUED', 'RUNNING', 'PROPOSED', 'APPLIED']) {
      expect(teamPanelView(team(), [task({ status })], runs()).tasks[0]!.blocked, status).toBe(false)
    }
  })

  it('a lista é do escopo de quem pergunta, da mais recente para a mais antiga', () => {
    const cards = teamCardsFor(teams([
      team({ team_id: OTHER, updated_at: '2026-09-08T00:09:00.000Z' }),
      team(),
      team({ team_id: '77777777-2222-4333-8444-555555555555', tenant_id: 'outro' }),
      team({ team_id: '88888888-2222-4333-8444-555555555555', org_id: 'outra-org' }),
    ]), { org_id: 'org-1', tenant_id: 'tenant-1' })
    expect(cards.map(card => card.team_id)).toEqual([OTHER, TEAM])
  })
})

describe('custo', () => {
  const measured = (id: string, tokens: number | null | undefined) => ({
    ...RUN, run_id: id, ...(tokens === undefined ? {} : { tokens_used: tokens }),
  })

  it('a etapa que trouxe medida mostra o número medido', () => {
    expect(taskCost('run-1', runs([measured('run-1', 1234)]))).toEqual({ state: 'MEASURED', tokens: 1234 })
    // Zero MEDIDO é um número: a etapa rodou e o provedor relatou zero.
    expect(taskCost('run-1', runs([measured('run-1', 0)]))).toEqual({ state: 'MEASURED', tokens: 0 })
  })

  it('sem medida NÃO vira zero', () => {
    // Três coisas diferentes que a tela trata igual porque para quem olha são
    // a mesma: não rodou, provedor externo, ou execução anterior ao campo.
    expect(taskCost('run-1', runs([measured('run-1', undefined)]))).toEqual({ state: 'NOT_MEASURED' })
    expect(taskCost('run-1', runs([measured('run-1', null)]))).toEqual({ state: 'NOT_MEASURED' })
    expect(taskCost(null, runs())).toEqual({ state: 'NOT_MEASURED' })
    expect(taskCost('run-fantasma', runs())).toEqual({ state: 'NOT_MEASURED' })
  })

  it('a equipe inteira medida soma, e diz quantas etapas entraram', () => {
    const view = teamPanelView(team(), [
      task({ task_id: 'a', run_id: 'run-1' }), task({ task_id: 'b', run_id: 'run-2' }),
    ], runs([measured('run-1', 100), measured('run-2', 50)]))
    expect(view.cost).toEqual({ state: 'MEASURED', tokens: 150, measured: 2 })
  })

  it('uma etapa sem medida torna o total PARCIAL, e não um total completo', () => {
    // Somar as que trouxeram e mostrar como total faria a pessoa ler um número
    // completo de uma soma pela metade — e uma equipe com agente externo
    // pareceria mais barata do que foi.
    const view = teamPanelView(team(), [
      task({ task_id: 'a', run_id: 'run-1' }), task({ task_id: 'b', run_id: 'run-2' }),
    ], runs([measured('run-1', 100), measured('run-2', undefined)]))
    expect(view.cost).toEqual({
      state: 'PARTIAL', tokens: 100, measured: 1, total: 2, reason: expect.stringContaining('externo'),
    })
  })

  it('equipe sem nenhuma medida diz NÃO MEDIDO com o motivo, e nunca zero', () => {
    const view = teamPanelView(team(), [task({ run_id: 'run-1' })], runs([measured('run-1', undefined)]))
    expect(view.cost.state).toBe('NOT_MEASURED')
    expect(JSON.stringify(view.cost)).not.toContain('tokens')
  })

  it('etapa em fila NÃO entra na conta de quantas faltam medir', () => {
    // Contá-la faria o total parecer permanentemente incompleto: ela ainda não
    // tem o que medir.
    const view = teamPanelView(team(), [
      task({ task_id: 'a', run_id: 'run-1' }), task({ task_id: 'b', run_id: null, status: 'QUEUED' }),
    ], runs([measured('run-1', 100)]))
    expect(view.cost).toEqual({ state: 'MEASURED', tokens: 100, measured: 1 })
  })

  it('equipe sem nenhuma etapa executada é NÃO MEDIDO, e não zero medido', () => {
    expect(teamCost([], 'motivo').state).toBe('NOT_MEASURED')
  })
})

describe('atendimento', () => {
  it('sem runtime de equipes a resposta diz o que falta, e não some num 404', () => {
    return expect(handleTeamPanel(request('GET'), { kind: 'list' }, { identity }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('a lista devolve os cartões do escopo autenticado', async () => {
    const outcome = await handleTeamPanel(request('GET'), { kind: 'list' }, { identity, teams: teams() })
    expect(outcome.status).toBe(200)
    expect((outcome.body as { teams: readonly { team_id: string }[] }).teams.map(card => card.team_id)).toEqual([TEAM])
  })

  it('equipe de outro inquilino é NÃO ENCONTRADA, e não PROIBIDA', async () => {
    // 403 confirmaria a existência da equipe a quem não é dono dela.
    const source = teams([team({ tenant_id: 'outro' })])
    await expect(handleTeamPanel(request('GET'), { kind: 'detail', teamId: TEAM }, { identity, teams: source }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('o serviço não é consultado por quem não é dono da equipe', async () => {
    const status = vi.fn(async (_teamId: string) => ({ team: team(), tasks: [task()] }))
    const source = teams([team({ org_id: 'outra' })], [task()], { status })
    await expect(handleTeamPanel(request('GET'), { kind: 'detail', teamId: TEAM }, { identity, teams: source }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(status).not.toHaveBeenCalled()
  })

  it('a leitura devolve o painel completo', async () => {
    const outcome = await handleTeamPanel(
      request('GET'), { kind: 'detail', teamId: TEAM }, { identity, teams: teams(), runs: runs() },
    )
    expect(outcome.status).toBe(200)
    const body = outcome.body as { team: { tasks: unknown[], cost: { state: string } } }
    expect(body.team.tasks).toHaveLength(1)
    expect(body.team.cost.state).toBe('NOT_MEASURED')
  })

  it('a parada usa quem a sessão diz ser, nunca um campo do corpo', async () => {
    const cancel = vi.fn(async (_teamId: string, _approvedBy: string, _reason?: string) => ({
      team: { ...team(), status: 'CANCELLED' }, tasks: [task({ status: 'CANCELLED' })],
    }))
    const outcome = await handleTeamPanel(
      request('POST', JSON.stringify({ reason: 'parei', approved_by: 'invasor' })),
      { kind: 'stop', teamId: TEAM },
      { identity, teams: teams([team()], [task()], { cancel }), runs: runs() },
    )
    expect(cancel).toHaveBeenCalledWith(TEAM, 'user-1', 'parei')
    expect((outcome.body as { team: { status: string } }).team.status).toBe('CANCELLED')
  })

  it('corpo vazio para sem motivo, e corpo quebrado não para nada', async () => {
    const cancel = vi.fn(async (_teamId: string, _approvedBy: string, _reason?: string) => ({
      team: { ...team(), status: 'CANCELLED' }, tasks: [],
    }))
    const source = teams([team()], [task()], { cancel })
    await handleTeamPanel(request('POST'), { kind: 'stop', teamId: TEAM }, { identity, teams: source })
    expect(cancel).toHaveBeenCalledWith(TEAM, 'user-1', undefined)
    for (const body of ['{', '[]', '"texto"', JSON.stringify({ reason: 7 }), JSON.stringify({ reason: 'x'.repeat(501) })]) {
      await expect(
        handleTeamPanel(request('POST', body), { kind: 'stop', teamId: TEAM }, { identity, teams: source }),
        body,
      ).rejects.toBeInstanceOf(TeamPanelError)
    }
    // A equipe NÃO foi interrompida por nenhum dos corpos recusados: o motivo é
    // lido antes da parada justamente para o pedido inteiro falhar junto.
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('corpo grande demais é recusado antes de virar texto', async () => {
    await expect(handleTeamPanel(
      request('POST', JSON.stringify({ reason: 'x'.repeat(5000) })),
      { kind: 'stop', teamId: TEAM },
      { identity, teams: teams() },
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('a recusa do serviço chega com o gesto certo, e não como falha do servidor', async () => {
    const codes = [
      ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['INVALID_STATE', 409],
    ] as const
    for (const [code, status] of codes) {
      const cancel = vi.fn(async () => { throw Object.assign(new Error(`recusa ${code}`), { code }) })
      const outcome = await handleTeamPanel(
        request('POST'), { kind: 'stop', teamId: TEAM },
        { identity, teams: teams([team()], [task()], { cancel }) },
      ).catch((error: unknown) => error)
      expect(teamPanelStatus(outcome), code).toBe(status)
    }
  })

  it('falha desconhecida do serviço NÃO vira 200 nem 400', async () => {
    const cancel = vi.fn(async () => { throw new Error('cano estourado') })
    const failure = await handleTeamPanel(
      request('POST'), { kind: 'stop', teamId: TEAM },
      { identity, teams: teams([team()], [task()], { cancel }) },
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(teamPanelStatus(failure)).toBeUndefined()
  })

  it('método errado responde 405 sem sequer autenticar', async () => {
    const authenticate = vi.fn()
    const outcome = await handleTeamPanel(
      request('PUT'), { kind: 'method-not-allowed' },
      { identity: { authenticate } as unknown as StudioIdentityService },
    )
    expect(outcome.status).toBe(405)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('erro que não é deste painel não recebe status deste painel', () => {
    expect(teamPanelStatus(new Error('outro'))).toBeUndefined()
  })
})
