import { describe, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { acceptanceChecks } from '../src/acceptance.js'
import type { AppSpecV1 } from '../src/appspec.js'
import { DomainPromptToAppRepository, gravarConferido } from '../src/domain-repository.js'
import { studioProjectCategorySchema, studioRunSchema, type PromptToAppKey, type StudioRun } from '../src/model.js'

/**
 * 19/09/2026: o FRIGG deixou de subir porque um registro de execução que ELE
 * MESMO gravou era recusado na reabertura (`Unrecognized key: "title"`). O
 * armazenamento confere o schema só ao abrir; estes casos garantem as duas
 * metades: o que a criação grava cabe no schema, e o que não cabe é recusado
 * na escrita, e não no próximo reinício.
 */
const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Gerenciar clientes e agenda.', audience: 'Equipe', journeys: ['Cadastrar cliente'],
  pages: [{ name: 'Início', sections: ['Clientes', 'Agenda'] }],
  entities: [{ name: 'Cliente', kind: 'database', sensitive: false, fields: [{ name: 'Nome', type: 'text', required: true }, { name: 'Horário', type: 'date', required: true }] }],
  sensitive_data: { detected: [], confirmed_by_user: false }, accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR', acceptance_criteria: ['Mostrar o texto “Meta cumprida!”.', 'A tela deve ser simples.'],
}

function registro(checks: StudioRun['acceptance_checks'], extra: Record<string, unknown> = {}): StudioRun {
  return {
    run_id: 'run-1', operation_id: 'run-1', owner_session_id: 's', plan_id: 'p', project_id: 'proj', org_id: 'o', tenant_id: 't',
    stage: 'verify', attempt: 1, state: 'FAILED', started_at: '2026-09-19T12:00:00.000Z', finished_at: '2026-09-19T12:01:00.000Z',
    sandbox: 'full', route: 'ollama', model: 'qwen', input_tokens: null, output_tokens: null, estimated_cost_usd: null,
    run_directory: '/runs/x', artifact_sha256: null, failure_code: null, acceptance_checks: checks, ...extra,
  } as StudioRun
}

function tabelaFalsa<T>(): KvTable<PromptToAppKey, T> & { readonly gravados: Map<string, T> } {
  const gravados = new Map<string, T>()
  return {
    gravados,
    get: (key: PromptToAppKey) => gravados.get(key),
    entries: () => gravados.entries() as IterableIterator<[PromptToAppKey, T]>,
    put: vi.fn((key: PromptToAppKey, value: T) => { gravados.set(key, value) }),
  } as unknown as KvTable<PromptToAppKey, T> & { readonly gravados: Map<string, T> }
}

describe('o que a criação grava, o produto consegue reabrir', () => {
  it.each(studioProjectCategorySchema.options)('as conferências da categoria %s cabem no registro de execução', categoria => {
    const checks = acceptanceChecks(spec, categoria)
    expect(checks.some(check => check.title !== undefined)).toBe(true)
    expect(() => studioRunSchema.parse(registro(checks as StudioRun['acceptance_checks']))).not.toThrow()
  })
})

describe('gravarConferido: o registro errado é recusado na escrita', () => {
  it('grava o registro válido', () => {
    const tabela = tabelaFalsa<StudioRun>()
    gravarConferido(tabela, 'run-1' as PromptToAppKey, studioRunSchema, registro([]))
    expect(tabela.gravados.get('run-1')?.run_id).toBe('run-1')
  })

  it('recusa um campo que a reabertura recusaria, e NÃO grava', () => {
    const tabela = tabelaFalsa<StudioRun>()
    expect(() => gravarConferido(tabela, 'run-1' as PromptToAppKey, studioRunSchema, registro([], { campo_novo: 1 }))).toThrow()
    expect(tabela.put).not.toHaveBeenCalled()
  })

  it('o repositório do produto passa pela conferência em toda gravação de execução', () => {
    const t = () => tabelaFalsa<never>()
    const runs = tabelaFalsa<StudioRun>()
    const repo = new DomainPromptToAppRepository(t(), t(), t(), t(), t(), runs, t(), t(), t())
    expect(() => repo.putRun(registro([], { campo_novo: 1 }))).toThrow()
    expect(runs.put).not.toHaveBeenCalled()
    repo.putRun(registro(acceptanceChecks(spec, 'crud-panel') as StudioRun['acceptance_checks']))
    expect(repo.runs()).toHaveLength(1)
  })

  it.each(['putProject', 'putSpec', 'putDesign', 'putTurn', 'putPlan', 'putRun', 'putEvidence', 'putApproval', 'putCreationKey'] as const)('%s confere antes de gravar', metodo => {
    const tabelas = Array.from({ length: 9 }, () => tabelaFalsa<never>())
    const repo = new DomainPromptToAppRepository(...(tabelas as unknown as ConstructorParameters<typeof DomainPromptToAppRepository>))
    const invalido = { project_id: 'x', spec_id: 'x', design_id: 'x', turn_id: 'x', plan_id: 'x', run_id: 'x', evidence_id: 'x', approval_id: 'x', request_key: 'x', org_id: 'o', tenant_id: 't', user_id: 'u', campo_novo: 1 }
    expect(() => (repo[metodo] as (valor: unknown) => unknown)(invalido)).toThrow()
    for (const tabela of tabelas) expect(tabela.put).not.toHaveBeenCalled()
  })
})
