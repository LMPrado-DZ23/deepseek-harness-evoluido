import { describe, expect, it, vi } from 'vitest'
import { missionBudgetPort, missionNoteRun } from '../src/budget-port.ts'
import type { MissionRecord, MissionRunUsage } from '../src/model.ts'
import type { MissionRepository } from '../src/service.ts'

function mission(over: Partial<MissionRecord> = {}): MissionRecord {
  return {
    mission_id: 'missao-1', org_id: 'org-a', tenant_id: 'ws-a',
    objective: 'terminar com prova', status: 'RUNNING', max_total_tokens: 1_000, max_total_centavos: null,
    run_ids: ['r1'], criteria: [{ criterion_id: 'c1', statement: 'algo', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
    created_at: 'x', updated_at: 'x', candidate_at: null, completed_at: null, revision: 0, ...over,
  }
}

function repositorio(...rows: MissionRecord[]): MissionRepository {
  return {
    missions: async scope => rows.filter(row => row.org_id === scope.orgId && row.tenant_id === scope.tenantId),
    putMission: async () => true,
  }
}

const run = (run_id: string, tokens_used: number | null): MissionRunUsage => ({ run_id, status: 'COMPLETED', tokens_used })

describe('ACHADO: `mission_id` e escolhido por quem cria, entao a busca PRECISA levar o escopo', () => {
  it('a equipe de uma organizacao nao e medida contra a missao de outra', async () => {
    // Sem o escopo, `find(record => record.mission_id === missionId)` acha a
    // PRIMEIRA missao com aquele identificador, e nada impede duas organizacoes
    // de escolherem o mesmo nome. O estrago tem duas metades: a equipe da
    // organizacao A descobre, pelo veredito, se a missao da B estourou; e a
    // execucao dela entra na missao da B.
    const noteRun = vi.fn(async () => undefined)
    const alheia = mission({ org_id: 'org-b', tenant_id: 'ws-b', max_total_tokens: 10, run_ids: ['r9'] })
    const port = missionBudgetPort(repositorio(alheia), () => [run('r9', 999)], noteRun)

    await expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1'))
      .resolves.toEqual({ kind: 'MISSION_MISSING', missionId: 'missao-1' })
    // E a dona continua sendo medida normalmente.
    await expect(port.verdictFor({ orgId: 'org-b', tenantId: 'ws-b' }, 'missao-1'))
      .resolves.toMatchObject({ kind: 'EXCEEDED', limit: 10 })
  })

  it('o inquilino tambem separa, e nao so a organizacao', async () => {
    const port = missionBudgetPort(repositorio(mission()), () => [run('r1', 10)], async () => undefined)
    await expect(port.verdictFor({ orgId: 'org-a', tenantId: 'OUTRO' }, 'missao-1'))
      .resolves.toEqual({ kind: 'MISSION_MISSING', missionId: 'missao-1' })
  })
})

describe('o adaptador acrescenta o veredito que o motor de missao nao tem', () => {
  it('missao inexistente vira MISSION_MISSING, e nunca "sem teto"', async () => {
    const port = missionBudgetPort(repositorio(), () => [], async () => undefined)
    await expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'sumiu'))
      .resolves.toEqual({ kind: 'MISSION_MISSING', missionId: 'sumiu' })
  })

  it('missao existente devolve o veredito do motor, sem reinterpretar', async () => {
    const port = missionBudgetPort(repositorio(mission()), () => [run('r1', 300)], async () => undefined)
    await expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1'))
      .resolves.toEqual({ kind: 'WITHIN', spent: 300, limit: 1_000 })
  })

  it('missao sem teto declarado continua NO_LIMIT, e nao vira "cabe"', async () => {
    const port = missionBudgetPort(repositorio(mission({ max_total_tokens: null })), () => [], async () => undefined)
    await expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1')).resolves.toEqual({ kind: 'NO_LIMIT' })
  })

  it('registrar a execucao passa escopo, missao e execucao adiante sem mexer', async () => {
    const noteRun = vi.fn(async () => undefined)
    const port = missionBudgetPort(repositorio(mission()), () => [], noteRun)
    await port.noteRun({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1', 'r7')
    expect(noteRun).toHaveBeenCalledWith({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1', 'r7')
  })
})

describe('registrar a execucao de uma equipe aprovada', () => {
  it('missao ausente no escopo RECUSA, e nao deixa a execucao correr sem teto', async () => {
    // A conferencia chegou a comparar a PROMESSA de `inScope` com `undefined`,
    // que nunca e igual: a guarda existia no texto e nao recusava nada.
    const attachRunForApprovedTeam = vi.fn(async () => mission())
    const note = missionNoteRun(repositorio(mission()), { attachRunForApprovedTeam }, () => [])
    await expect(note({ orgId: 'org-a', tenantId: 'ws-a' }, 'nao-existe', 'r7'))
      .rejects.toThrow('MISSION_MISSING:nao-existe')
    expect(attachRunForApprovedTeam).not.toHaveBeenCalled()
  })

  it('missao de OUTRO escopo tambem recusa, mesmo com o identificador certo', async () => {
    const attachRunForApprovedTeam = vi.fn(async () => mission())
    const note = missionNoteRun(repositorio(mission()), { attachRunForApprovedTeam }, () => [])
    await expect(note({ orgId: 'org-b', tenantId: 'ws-b' }, 'missao-1', 'r7'))
      .rejects.toThrow('MISSION_MISSING:missao-1')
    expect(attachRunForApprovedTeam).not.toHaveBeenCalled()
  })

  it('a segunda tranca vale mesmo quando o armazenamento devolve linha fora do escopo', async () => {
    // O duble acima filtra por escopo, como os dois repositorios de producao
    // fazem hoje — e por isso ele NAO exercita a conferencia do corpo. Sem um
    // armazenamento plano aqui, apagar essa conferencia passava despercebido.
    const plano: MissionRepository = { missions: async () => [mission()], putMission: async () => true }
    const attachRunForApprovedTeam = vi.fn(async () => mission())
    const note = missionNoteRun(plano, { attachRunForApprovedTeam }, () => [])
    await expect(note({ orgId: 'org-b', tenantId: 'ws-b' }, 'missao-1', 'r7'))
      .rejects.toThrow('MISSION_MISSING:missao-1')
    expect(attachRunForApprovedTeam).not.toHaveBeenCalled()
  })

  it('missao presente liga a execucao, com as execucoes conhecidas do momento', async () => {
    const attachRunForApprovedTeam = vi.fn(async () => mission())
    const conhecidas = [run('r1', 10)]
    const note = missionNoteRun(repositorio(mission()), { attachRunForApprovedTeam }, () => conhecidas)
    await note({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1', 'r7')
    expect(attachRunForApprovedTeam)
      .toHaveBeenCalledWith({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1', 'r7', conhecidas)
  })
})
