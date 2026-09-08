import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { latestGreenCheckpoint, noGreenReason, runCheckpoints } from '../src/checkpoint.js'
import type { ProjectState, StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../src/model.js'
import { studioProjectSchema, studioRunSchema } from '../src/model.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'
import { UNDO_TRANSITIONS, UndoNotAvailableError } from '../src/state.js'

class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []; specRows: StudioAppSpecRecord[] = []; designRows: StudioDesignSpecRecord[] = []; turnRows: StudioIntakeTurn[] = []
  planRows: StudioPlan[] = []; runRows: StudioRun[] = []; evidenceRows: StudioEvidence[] = []; approvalRows: StudioApproval[] = []
  projects = () => this.projectRows; specs = () => this.specRows; designs = () => this.designRows; turns = () => this.turnRows; plans = () => this.planRows
  runs = () => this.runRows; evidence = () => this.evidenceRows; approvals = () => this.approvalRows
  putProject = async (v: StudioProject) => { this.projectRows = upsert(this.projectRows, v, 'project_id') }
  putSpec = async (v: StudioAppSpecRecord) => { this.specRows = upsert(this.specRows, v, 'spec_id') }
  putDesign = async (v: StudioDesignSpecRecord) => { this.designRows = upsert(this.designRows, v, 'design_id') }
  putTurn = async (v: StudioIntakeTurn) => { this.turnRows = upsert(this.turnRows, v, 'turn_id') }
  putPlan = async (v: StudioPlan) => { this.planRows = upsert(this.planRows, v, 'plan_id') }
  putRun = async (v: StudioRun) => { this.runRows = upsert(this.runRows, v, 'run_id') }
  putEvidence = async (v: StudioEvidence) => { this.evidenceRows = upsert(this.evidenceRows, v, 'evidence_id') }
  putApproval = async (v: StudioApproval) => { this.approvalRows = upsert(this.approvalRows, v, 'approval_id') }
}
function upsert<T, K extends keyof T>(rows: T[], value: T, key: K): T[] { return [...rows.filter(row => row[key] !== value[key]), value] }

const actor: PromptToAppActor = { userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const intruder: PromptToAppActor = { userId: 'owner', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function project(state: ProjectState, overrides: Partial<StudioProject> = {}): StudioProject {
  return studioProjectSchema.parse({
    project_id: 'project', org_id: actor.orgId, tenant_id: actor.tenantId, name: 'Meu site', state,
    original_brief: 'Quero apresentar meu trabalho.', category: 'landing-page', created_by: actor.userId,
    privacy: 'privado-local', created_at: '2026-09-03T12:00:00.000Z', updated_at: '2026-09-03T12:00:00.000Z', archived_at: null,
    ...overrides,
  })
}

function run(overrides: Partial<StudioRun> & { readonly run_id: string }): StudioRun {
  return studioRunSchema.parse({
    operation_id: overrides.run_id, owner_session_id: 'session', plan_id: 'plan', project_id: 'project',
    org_id: actor.orgId, tenant_id: actor.tenantId, stage: 'verify', attempt: 1, state: 'FAILED',
    started_at: '2026-09-03T12:00:00.000Z', finished_at: '2026-09-03T12:01:00.000Z', sandbox: 'full',
    route: 'ollama', model: 'qwen', input_tokens: null, output_tokens: null, estimated_cost_usd: null,
    run_directory: '/runs/attempt', artifact_sha256: null, failure_code: null, acceptance_checks: [],
    ...overrides,
  })
}

/** Uma tentativa que QUALIFICA: passos aprovados e integridade conferida. */
const greenRun = (overrides: Partial<StudioRun> = {}) => run({
  run_id: 'attempt-green', state: 'PASSED', failure_code: null, template_integrity: 'VERIFIED',
  artifact_sha256: 'a'.repeat(64), run_directory: '/runs/attempt-green',
  acceptance_checks: [{ id: 'title', label: 'A página tem um título.', kind: 'title', status: 'PASSED' }],
  ...overrides,
})

describe('E-08: um GREEN é uma tentativa cujos passos passaram e cuja integridade foi conferida', () => {
  it('sem tentativa qualificada NÃO existe GREEN, e o motivo é dito', () => {
    // Hoje o pipeline lança ACCEPTANCE_ATTESTATION_UNAVAILABLE no caminho de
    // sucesso (E-05): nenhuma execução chega a PASSED. Inventar um ponto seguro
    // aqui seria oferecer à pessoa uma volta para um lugar que ninguém provou.
    const checkpoints = runCheckpoints([run({
      run_id: 'attempt-1', state: 'BLOCKED_EXTERNAL', failure_code: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE',
      template_integrity: 'VERIFIED',
    })])
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ green: false, blocker: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE' })
    expect(latestGreenCheckpoint(checkpoints)).toBe(null)
    expect(noGreenReason(checkpoints)).toBe('ACCEPTANCE_ATTESTATION_UNAVAILABLE')
  })

  it('o GREEN aparece quando a tentativa qualifica, e só então', () => {
    const checkpoints = runCheckpoints([greenRun()])
    expect(checkpoints[0]).toMatchObject({ green: true, blocker: null, integrity: 'VERIFIED', tree_sha256: 'a'.repeat(64) })
    expect(checkpoints[0]?.acceptance_checks).toHaveLength(1)
    expect(latestGreenCheckpoint(checkpoints)?.run_id).toBe('attempt-green')
    expect(noGreenReason(checkpoints)).toBe(null)
  })

  it('passar não basta: sem integridade conferida a tentativa NÃO é ponto seguro', () => {
    // O campo é opcional para que execuções antigas continuem válidas. Tratar a
    // ausência como prova seria exatamente o verde artificial que E-08 proíbe.
    const semRegistro = runCheckpoints([greenRun({ template_integrity: undefined })])
    expect(semRegistro[0]).toMatchObject({ green: false, integrity: 'UNKNOWN', blocker: 'INTEGRITY_NOT_RECORDED' })
    const recusada = runCheckpoints([greenRun({ template_integrity: 'FAILED' })])
    expect(recusada[0]).toMatchObject({ green: false, blocker: 'TEMPLATE_INTEGRITY_FAILED' })
    expect(noGreenReason(recusada)).toBe('TEMPLATE_INTEGRITY_FAILED')
  })

  it('tentativa sem diretório conservado ou ainda em andamento não vira ponto de retorno', () => {
    // Não há nada conservado: oferecer a volta seria convidar a pessoa a voltar
    // para lugar nenhum.
    expect(runCheckpoints([run({ run_id: 'a', run_directory: 'not-created' })])).toEqual([])
    expect(runCheckpoints([run({ run_id: 'b', state: 'RUNNING', finished_at: null })])).toEqual([])
    expect(noGreenReason([])).toBe('NO_ATTEMPT')
  })

  it('o último ponto seguro é o mais recente, e os pontos saem em ordem de execução', () => {
    const checkpoints = runCheckpoints([
      greenRun({ run_id: 'novo', attempt: 2, finished_at: '2026-09-03T13:00:00.000Z' }),
      greenRun({ run_id: 'antigo', attempt: 1, finished_at: '2026-09-03T12:01:00.000Z' }),
    ])
    expect(checkpoints.map(entry => entry.run_id)).toEqual(['antigo', 'novo'])
    expect(latestGreenCheckpoint(checkpoints)?.run_id).toBe('novo')
  })
})

describe('E-08: desfazer é navegação, nunca destruição', () => {
  async function fixture(state: ProjectState, runs: readonly StudioRun[]) {
    const repository = new MemoryRepository()
    repository.projectRows = [project(state)]
    repository.runRows = [...runs]
    repository.evidenceRows = [{
      evidence_id: 'ev-1', run_id: 'attempt-green', project_id: 'project', org_id: actor.orgId, tenant_id: actor.tenantId,
      kind: 'diff', sha256: 'b'.repeat(64), size_bytes: 10, relative_path: 'attempt-green/run-report.json',
      created_at: '2026-09-03T12:01:00.000Z',
    }]
    const service = new PromptToAppService({ repository, now: () => new Date('2026-09-04T12:00:00.000Z'), createId: () => 'approval-1' })
    return { repository, service }
  }

  it('desfazer NÃO apaga diretório de execução, evidência nem histórico', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-checkpoint-')); roots.push(root)
    await writeFile(resolve(root, 'pipeline.log'), '[build]\nok\n', 'utf8')
    await writeFile(resolve(root, 'run-report.json'), '{}', 'utf8')
    const green = greenRun({ run_directory: root })
    const failed = run({ run_id: 'attempt-2', attempt: 2, state: 'FAILED', failure_code: 'build: exit 1', finished_at: '2026-09-03T13:00:00.000Z' })
    const f = await fixture('BUILD_FAILED', [green, failed])

    const undone = await f.service.undoToCheckpoint(actor, 'project', green.run_id)

    expect(undone.project.state).toBe('VERIFIED_PROTOTYPE')
    expect(undone.project.current_run_id).toBe(green.run_id)
    // O disco é o teste: um reset destrutivo é proibição explícita do produto.
    expect((await readdir(root)).sort()).toEqual(['pipeline.log', 'run-report.json'])
    // E o histórico inteiro continua INTACTO: as DUAS tentativas exatamente
    // como estavam - inclusive o diretório de cada uma - e a evidência.
    expect(f.repository.runRows.map(entry => entry.run_id).sort()).toEqual(['attempt-2', 'attempt-green'])
    expect([...f.repository.runRows].sort((left, right) => left.run_id.localeCompare(right.run_id)))
      .toEqual([failed, green].sort((left, right) => left.run_id.localeCompare(right.run_id)))
    expect(f.repository.evidenceRows).toHaveLength(1)
    // A volta fica registrada como aprovação, e não some do histórico.
    expect(f.repository.approvalRows.at(-1)).toMatchObject({ subject: 'transition', subject_id: 'undo:attempt-green', from_state: 'BUILD_FAILED', to_state: 'VERIFIED_PROTOTYPE' })
  })

  it('desfazer de OUTRO escopo é recusado, e nada muda', async () => {
    const green = greenRun()
    const f = await fixture('BUILD_FAILED', [green])
    await expect(f.service.undoToCheckpoint(intruder, 'project', green.run_id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(() => f.service.checkpoints(intruder, 'project')).toThrow(PromptToAppError)

    // E o caso que dói: o invasor tem um projeto com o MESMO identificador no
    // espaço dele. A recusa não pode vir só de "projeto não encontrado" - a
    // busca da tentativa também precisa ser por escopo, senão um ponto seguro
    // de outra empresa viraria o ponto de retorno deste projeto.
    f.repository.projectRows = [
      ...f.repository.projectRows,
      { ...project('BUILD_FAILED'), org_id: intruder.orgId, tenant_id: intruder.tenantId },
    ]
    await expect(f.service.undoToCheckpoint(intruder, 'project', green.run_id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(f.service.checkpoints(intruder, 'project')).toMatchObject({ checkpoints: [], green_run_id: null, reason: 'NO_ATTEMPT' })

    expect(f.repository.projectRows.every(entry => entry.state === 'BUILD_FAILED')).toBe(true)
    expect(f.repository.projectRows.every(entry => entry.current_run_id === undefined)).toBe(true)
    expect(f.repository.approvalRows).toEqual([])
  })

  it('desfazer para uma tentativa que não é ponto seguro é recusado', async () => {
    const blocked = run({ run_id: 'attempt-1', state: 'BLOCKED_EXTERNAL', failure_code: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', template_integrity: 'VERIFIED' })
    const f = await fixture('BUILD_FAILED', [blocked])
    await expect(f.service.undoToCheckpoint(actor, 'project', 'attempt-1')).rejects.toBeInstanceOf(PromptToAppError)
    await expect(f.service.undoToCheckpoint(actor, 'project', 'attempt-1')).rejects.toMatchObject({ code: 'INVALID' })
    // E uma tentativa que sequer existe não vira um ponto inventado.
    await expect(f.service.undoToCheckpoint(actor, 'project', 'não-existe')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(f.repository.projectRows[0]?.state).toBe('BUILD_FAILED')
  })

  it('desfazer no meio de uma criação em andamento é recusado', async () => {
    // Disputar o estado com o pipeline que ainda está escrevendo nele deixaria
    // o projeto em um estado que ninguém pediu.
    const f = await fixture('GENERATING', [greenRun()])
    await expect(f.service.undoToCheckpoint(actor, 'project', 'attempt-green')).rejects.toBeInstanceOf(UndoNotAvailableError)
    expect(f.repository.projectRows[0]?.state).toBe('GENERATING')
    expect(UNDO_TRANSITIONS.GENERATING).toEqual([])
  })

  it('a leitura devolve os pontos, o motivo e para onde a pessoa está olhando', async () => {
    const f = await fixture('BUILD_FAILED', [run({
      run_id: 'attempt-1', state: 'BLOCKED_EXTERNAL', failure_code: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', template_integrity: 'VERIFIED',
    })])
    expect(f.service.checkpoints(actor, 'project')).toMatchObject({
      green_run_id: null, reason: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', current_run_id: null,
    })
  })
})
