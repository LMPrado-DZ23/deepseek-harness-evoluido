import { describe, expect, it, vi } from 'vitest'
import { missionBudgetPort } from '../src/budget-port.ts'
import type { MissionRecord, MissionRunUsage } from '../src/model.ts'
import type { MissionRepository } from '../src/service.ts'

function mission(over: Partial<MissionRecord> = {}): MissionRecord {
  return {
    mission_id: 'missao-1', org_id: 'org-a', tenant_id: 'ws-a',
    objective: 'terminar com prova', status: 'RUNNING', max_total_tokens: 1_000,
    run_ids: ['r1'], criteria: [{ criterion_id: 'c1', statement: 'algo', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
    created_at: 'x', updated_at: 'x', candidate_at: null, completed_at: null, ...over,
  }
}

function repositorio(...rows: MissionRecord[]): MissionRepository {
  return { missions: () => rows, putMission: async () => undefined }
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

    expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1'))
      .toEqual({ kind: 'MISSION_MISSING', missionId: 'missao-1' })
    // E a dona continua sendo medida normalmente.
    expect(port.verdictFor({ orgId: 'org-b', tenantId: 'ws-b' }, 'missao-1'))
      .toMatchObject({ kind: 'EXCEEDED', limit: 10 })
  })

  it('o inquilino tambem separa, e nao so a organizacao', () => {
    const port = missionBudgetPort(repositorio(mission()), () => [run('r1', 10)], async () => undefined)
    expect(port.verdictFor({ orgId: 'org-a', tenantId: 'OUTRO' }, 'missao-1'))
      .toEqual({ kind: 'MISSION_MISSING', missionId: 'missao-1' })
  })
})

describe('o adaptador acrescenta o veredito que o motor de missao nao tem', () => {
  it('missao inexistente vira MISSION_MISSING, e nunca "sem teto"', () => {
    const port = missionBudgetPort(repositorio(), () => [], async () => undefined)
    expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'sumiu'))
      .toEqual({ kind: 'MISSION_MISSING', missionId: 'sumiu' })
  })

  it('missao existente devolve o veredito do motor, sem reinterpretar', () => {
    const port = missionBudgetPort(repositorio(mission()), () => [run('r1', 300)], async () => undefined)
    expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1'))
      .toEqual({ kind: 'WITHIN', spent: 300, limit: 1_000 })
  })

  it('missao sem teto declarado continua NO_LIMIT, e nao vira "cabe"', () => {
    const port = missionBudgetPort(repositorio(mission({ max_total_tokens: null })), () => [], async () => undefined)
    expect(port.verdictFor({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1')).toEqual({ kind: 'NO_LIMIT' })
  })

  it('registrar a execucao passa escopo, missao e execucao adiante sem mexer', async () => {
    const noteRun = vi.fn(async () => undefined)
    const port = missionBudgetPort(repositorio(mission()), () => [], noteRun)
    await port.noteRun({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1', 'r7')
    expect(noteRun).toHaveBeenCalledWith({ orgId: 'org-a', tenantId: 'ws-a' }, 'missao-1', 'r7')
  })
})
