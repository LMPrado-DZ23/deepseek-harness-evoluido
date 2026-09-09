import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  STUCK_RUNS_PATH,
  StuckRunsError,
  handleStuckRuns,
  routeStuckRuns,
  stuckRunsFor,
  stuckRunsStatus,
  type StuckRunsSource,
} from '../src/stuck-runs.ts'
import { SESSION_COOKIE, type StudioIdentityService } from '@dz23-studio/identity'

function run(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1', org_id: 'org-1', tenant_id: 'tenant-1', workspace_id: 'workspace-1',
    status: 'UNKNOWN', provider: 'spawn-in-process', diagnostic: null,
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:01:00.000Z',
    ...overrides,
  } as StuckRunsSource['runs'] extends () => readonly (infer T)[] ? T : never
}

function request(): IncomingMessage {
  return { headers: { cookie: `${SESSION_COOKIE}=token` }, method: 'GET' } as unknown as IncomingMessage
}

const identity = {
  authenticate: vi.fn(() => Promise.resolve({
    session_id: 'session', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
  })),
  validateCsrfToken: vi.fn(), assertRequestTrust: () => {} } as unknown as StudioIdentityService

describe('execuções paradas', () => {
  it('só existe leitura neste endereço', () => {
    expect(routeStuckRuns('GET', STUCK_RUNS_PATH)).toEqual({ kind: 'list' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(routeStuckRuns(method, STUCK_RUNS_PATH)).toEqual({ kind: 'method-not-allowed' })
    }
    expect(routeStuckRuns('GET', `${STUCK_RUNS_PATH}/run-1`)).toBeUndefined()
    expect(routeStuckRuns('GET', '/studio/outro')).toBeUndefined()
  })

  it('devolve só o que está parado, no escopo exato, da mais antiga para a mais nova', () => {
    const agents: StuckRunsSource = {
      runs: () => [
        run({ run_id: 'nova', updated_at: '2026-09-08T00:05:00.000Z' }),
        run({ run_id: 'antiga', updated_at: '2026-09-08T00:01:00.000Z' }),
        run({ run_id: 'terminada', status: 'PROPOSED' }),
        run({ run_id: 'outra-org', org_id: 'org-2' }),
        run({ run_id: 'outro-inquilino', tenant_id: 'tenant-2' }),
      ],
    }
    expect(stuckRunsFor(agents, { org_id: 'org-1', tenant_id: 'tenant-1' }).map(item => item.run_id))
      .toEqual(['antiga', 'nova'])
  })

  it('nunca deixa um caminho do disco atravessar para o cliente', async () => {
    const agents: StuckRunsSource = {
      runs: () => [run({ worktree_path: 'C:/segredo/copia', repository_path: '/home/pessoa/projeto' } as never)],
    }
    const outcome = await handleStuckRuns(request(), { kind: 'list' }, { identity, agents })
    expect(outcome.status).toBe(200)
    const body = JSON.stringify(outcome.body)
    expect(body).not.toContain('segredo')
    expect(body).not.toContain('/home/pessoa')
    expect(outcome.body).toEqual({
      runs: [{ run_id: 'run-1', workspace_id: 'workspace-1', provider: 'spawn-in-process', since: '2026-09-08T00:01:00.000Z' }],
    })
  })

  it('autentica antes de olhar qualquer execução', async () => {
    const runs = vi.fn(() => [])
    const refusing = {
      authenticate: vi.fn(() => Promise.reject(new Error('sem sessão'))),
      validateCsrfToken: vi.fn(), assertRequestTrust: () => {} } as unknown as StudioIdentityService
    await expect(handleStuckRuns(request(), { kind: 'list' }, { identity: refusing, agents: { runs } }))
      .rejects.toThrow()
    expect(runs).not.toHaveBeenCalled()
  })

  it('sem o serviço de execuções montado, diz NOT_CONFIGURED em vez de dizer que não há nada', async () => {
    const error = await handleStuckRuns(request(), { kind: 'list' }, { identity })
      .then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(StuckRunsError)
    expect(stuckRunsStatus(error)).toBe(503)
    expect(stuckRunsStatus(new Error('outra coisa'))).toBeUndefined()
  })

  it('método trocado responde 405 sem autenticar nem olhar execução', async () => {
    const runs = vi.fn(() => [])
    const outcome = await handleStuckRuns(request(), { kind: 'method-not-allowed' }, { identity, agents: { runs } })
    expect(outcome.status).toBe(405)
    expect(runs).not.toHaveBeenCalled()
  })
})
