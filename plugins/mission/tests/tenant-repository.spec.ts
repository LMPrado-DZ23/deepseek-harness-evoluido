import { describe, expect, it, vi } from 'vitest'
import type { MissionRecord } from '../src/model.ts'
import {
  MISSION_TENANT_TABLE,
  MISSION_TENANT_UNIT,
  TenantRecordMissionRepository,
  type MissionTenantRecordStore,
} from '../src/tenant-repository.ts'

function record(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    mission_id: 'm1', org_id: 'org-a', tenant_id: 'ws-a', objective: 'Terminar com prova',
    status: 'RUNNING', max_total_tokens: null, max_total_centavos: null, run_ids: [],
    criteria: [{ criterion_id: 'c1', statement: 'A primeira coisa', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
    created_at: '2026-09-12T00:00:00.000Z', updated_at: '2026-09-12T00:00:00.000Z',
    candidate_at: null, completed_at: null, revision: 0,
    ...overrides,
  }
}

/**
 * A tabela por inquilino do jeito que o BANCO se comporta: a leitura só
 * enxerga o escopo pedido.
 *
 * Imitar um mapa global provaria o `if` do repositório em vez do contrato — e
 * é justamente o `if` que deixa de ser a única tranca quando o isolamento é
 * por linha.
 */
function store(rows: readonly MissionRecord[] = [], options: { readonly conditional?: boolean } = {}) {
  const data = new Map<string, unknown>()
  for (const row of rows) data.set(`${row.org_id}/${row.tenant_id}/${row.mission_id}`, row)
  const escritas: { readonly key: string, readonly expected: unknown }[] = []
  const base: MissionTenantRecordStore = {
    list: async (scope, unit, table) => {
      expect([unit, table]).toEqual([MISSION_TENANT_UNIT, MISSION_TENANT_TABLE])
      return [...data.entries()]
        .filter(([key]) => key.startsWith(`${scope.orgId}/${scope.tenantId}/`))
        .map(([key, value]) => ({ key, value: value as never }))
    },
    get: async (scope, unit, table, key) => {
      expect([unit, table]).toEqual([MISSION_TENANT_UNIT, MISSION_TENANT_TABLE])
      return data.get(`${scope.orgId}/${scope.tenantId}/${key}`) as never
    },
    put: async (scope, unit, table, key, value) => {
      expect([unit, table]).toEqual([MISSION_TENANT_UNIT, MISSION_TENANT_TABLE])
      data.set(`${scope.orgId}/${scope.tenantId}/${key}`, value)
    },
  }
  if (options.conditional !== true) return { store: base, data, escritas }
  const comCondicional: MissionTenantRecordStore = {
    ...base,
    putIf: async (scope, unit, table, key, value, expected) => {
      expect([unit, table]).toEqual([MISSION_TENANT_UNIT, MISSION_TENANT_TABLE])
      escritas.push({ key, expected })
      const full = `${scope.orgId}/${scope.tenantId}/${key}`
      const current = data.get(full) as MissionRecord | undefined
      if (expected === 'absent') {
        if (current !== undefined) return false
      } else if (current === undefined || String(current[expected.field as 'revision']) !== expected.value) {
        return false
      }
      data.set(full, value)
      return true
    },
  }
  return { store: comCondicional, data, escritas }
}

describe('missões na tabela com isolamento por linha', () => {
  it('a leitura carrega o escopo na consulta, e não filtra depois', async () => {
    const f = store([record(), record({ mission_id: 'alheia', org_id: 'org-b', tenant_id: 'ws-b' })])
    const spy = vi.spyOn(f.store, 'list')
    const repository = new TenantRecordMissionRepository(f.store)
    const lidas = await repository.missions({ orgId: 'org-a', tenantId: 'ws-a' })
    expect(lidas.map(row => row.mission_id)).toEqual(['m1'])
    // O ESCOPO tem de chegar ao armazenamento. Ler tudo e filtrar depois passa
    // neste mesmo `toEqual` e deixa a separação no processo, que é exatamente o
    // que esta migração tira de lá.
    expect(spy).toHaveBeenCalledWith({ orgId: 'org-a', tenantId: 'ws-a' }, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE)
  })

  it('linha corrompida some da leitura em vez de chegar como missão', async () => {
    const f = store()
    f.data.set('org-a/ws-a/quebrada', { mission_id: 'quebrada', org_id: 'org-a', tenant_id: 'ws-a' })
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.missions({ orgId: 'org-a', tenantId: 'ws-a' })).resolves.toEqual([])
  })

  it('linha com escopo errado NO CORPO some da leitura, mesmo vindo do banco', async () => {
    // Segunda tranca. Se um dia uma linha for gravada sob a chave certa com o
    // escopo errado dentro, ela não pode aparecer como se fosse de quem
    // perguntou.
    const f = store()
    f.data.set('org-a/ws-a/m1', record({ org_id: 'org-b' }))
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.missions({ orgId: 'org-a', tenantId: 'ws-a' })).resolves.toEqual([])
  })

  it('com gravação condicional, a revisão viaja DENTRO da instrução', async () => {
    const f = store([record({ revision: 3 })], { conditional: true })
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.putMission(record({ revision: 4 }), 3)).resolves.toBe(true)
    expect(f.escritas).toEqual([{ key: 'm1', expected: { field: 'revision', value: '3' } }])
  })

  it('com gravação condicional, perder a corrida devolve false e NÃO escreve', async () => {
    const f = store([record({ revision: 3, objective: 'o que ja estava la' })], { conditional: true })
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.putMission(record({ revision: 3, objective: 'por cima' }), 2)).resolves.toBe(false)
    expect((f.data.get('org-a/ws-a/m1') as MissionRecord).objective).toBe('o que ja estava la')
  })

  it('criar exige ausência, e a segunda criação do mesmo nome não passa', async () => {
    const f = store([], { conditional: true })
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.putMission(record(), 'new')).resolves.toBe(true)
    await expect(repository.putMission(record({ objective: 'outra' }), 'new')).resolves.toBe(false)
    expect(f.escritas.map(item => item.expected)).toEqual(['absent', 'absent'])
  })

  it('sem gravação condicional, ainda confere antes de escrever', async () => {
    // A ausência do `putIf` é visível no tipo de propósito: aqui o repositório
    // volta a ler-conferir-escrever, que basta em instância única sob a fila.
    const f = store([record({ revision: 3 })])
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.putMission(record({ revision: 4 }), 2)).resolves.toBe(false)
    await expect(repository.putMission(record({ revision: 4 }), 3)).resolves.toBe(true)
    expect((f.data.get('org-a/ws-a/m1') as MissionRecord).revision).toBe(4)
  })

  it('sem gravação condicional, criar sobre uma existente também é recusado', async () => {
    const f = store([record()])
    const repository = new TenantRecordMissionRepository(f.store)
    await expect(repository.putMission(record({ objective: 'outra' }), 'new')).resolves.toBe(false)
    expect((f.data.get('org-a/ws-a/m1') as MissionRecord).objective).toBe('Terminar com prova')
  })

  it('a gravação vai para o ESCOPO do próprio registro, e não para o de quem chamou', async () => {
    const f = store([], { conditional: true })
    const repository = new TenantRecordMissionRepository(f.store)
    await repository.putMission(record({ org_id: 'org-b', tenant_id: 'ws-b' }), 'new')
    expect([...f.data.keys()]).toEqual(['org-b/ws-b/m1'])
  })
})
