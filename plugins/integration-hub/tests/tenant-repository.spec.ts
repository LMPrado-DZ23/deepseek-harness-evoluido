import { describe, expect, it, vi } from 'vitest'
import type { HubEvent, IntegrationKillSwitch, StudioExport, StudioIntegration } from '../src/model.ts'
import { securityFingerprint } from '../src/service.ts'
import {
  HUB_EVENTS_TABLE,
  HUB_EXPORTS_TABLE,
  HUB_INTEGRATIONS_TABLE,
  HUB_TENANT_UNIT,
  TenantRecordHubRepository,
  type HubKillSwitchSource,
  type HubTenantRecordStore,
} from '../src/tenant-repository.ts'

const actor = { userId: 'u1', orgId: 'org-1', tenantId: 'ws-1', role: 'owner' as const, sessionId: 's1' }
const stranger = { ...actor, tenantId: 'ws-2' }

function integration(overrides: Partial<StudioIntegration> = {}): StudioIntegration {
  return {
    integration_id: 'agenda', org_id: 'org-1', tenant_id: 'ws-1', kind: 'mcp', name: 'Agenda',
    manifest: null, effective_tier: 'T1', verification: 'unsigned', enabled: false, secret_ref: null,
    created_by: 'u1', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as StudioIntegration
}

function exported(overrides: Partial<StudioExport> = {}): StudioExport {
  return {
    export_id: 'export-1', project_id: 'project-1', run_id: 'run-1', file_name: 'app.zip',
    path: '/tmp/app.zip', sha256: 'a'.repeat(64), size_bytes: 10, entries: 1,
    created_by: 'u1', created_at: '2026-09-01T00:00:00.000Z', org_id: 'org-1', tenant_id: 'ws-1',
    ...overrides,
  } as StudioExport
}

function event(overrides: Partial<HubEvent> = {}): HubEvent {
  return {
    event_id: 'event-1', org_id: 'org-1', tenant_id: 'ws-1', actor_user_id: 'u1',
    action: 'integration.registered', subject_id: 'agenda', outcome: 'success', detail: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as HubEvent
}

/**
 * O armazenamento por inquilino do jeito que o banco se comporta: a leitura só
 * enxerga o escopo pedido.
 *
 * Imitar um mapa global provaria os `filter` do repositório e não o CONTRATO —
 * e é justamente o contrato que muda quando a separação sai do processo e vai
 * para a política de linha do PostgreSQL.
 */
function store(seed: readonly { scope: { orgId: string; tenantId: string }; table: string; key: string; value: unknown }[] = []): HubTenantRecordStore & {
  readonly reads: { scope: unknown; table: string }[]
} {
  const data = new Map<string, unknown>()
  const reads: { scope: unknown; table: string }[] = []
  const at = (scope: { orgId: string; tenantId: string }, table: string, key: string) => `${scope.orgId}/${scope.tenantId}/${table}/${key}`
  for (const row of seed) data.set(at(row.scope, row.table, row.key), row.value)
  return {
    reads,
    list: async (scope, unit, table) => {
      expect(unit).toBe(HUB_TENANT_UNIT)
      reads.push({ scope, table })
      const prefix = `${scope.orgId}/${scope.tenantId}/${table}/`
      return [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => ({ key: key.slice(prefix.length), value: value as never }))
    },
    get: async (scope, unit, table, key) => {
      expect(unit).toBe(HUB_TENANT_UNIT)
      reads.push({ scope, table })
      return data.get(at(scope, table, key)) as never
    },
    put: async (scope, unit, table, key, value) => {
      expect(unit).toBe(HUB_TENANT_UNIT)
      data.set(at(scope, table, key), value)
    },
    delete: async (scope, unit, table, key) => {
      expect(unit).toBe(HUB_TENANT_UNIT)
      return data.delete(at(scope, table, key))
    },
  }
}

const noSwitches: HubKillSwitchSource = {
  killSwitch: () => undefined,
  putKillSwitch: async () => undefined,
  killSwitches: () => [] as readonly IntegrationKillSwitch[],
}

describe('o Hub na tabela por inquilino', () => {
  it('a leitura carrega o escopo, e não filtra depois', async () => {
    const rows = store([{ scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: integration() }])
    const spy = vi.spyOn(rows, 'get')
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    await expect(repository.integration(actor, 'agenda')).resolves.toMatchObject({ integration_id: 'agenda' })
    // O escopo foi para a CONSULTA. Se ele fosse aplicado depois, a chamada
    // teria saído sem organização e sem inquilino — e uma credencial escopada
    // não teria como recusar nada.
    expect(spy).toHaveBeenCalledWith(actor, HUB_TENANT_UNIT, HUB_INTEGRATIONS_TABLE, 'agenda')
  })

  it('o que é de outro inquilino não aparece, nem por chave nem por lista', async () => {
    const rows = store([{ scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: integration() }])
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    await expect(repository.integration(stranger, 'agenda')).resolves.toBeUndefined()
    await expect(repository.integrations(stranger)).resolves.toEqual([])
    await expect(repository.integrations(actor)).resolves.toHaveLength(1)
  })

  it('uma linha gravada com o escopo errado no corpo some da leitura', async () => {
    // A segunda tranca: o banco já recusou pelo escopo da linha, mas o valor
    // guarda org e inquilino DENTRO dele. Divergindo os dois, a linha não pode
    // aparecer como se fosse de quem perguntou.
    const rows = store([{ scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: integration({ tenant_id: 'ws-9' }) }])
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    await expect(repository.integration(actor, 'agenda')).resolves.toBeUndefined()
    await expect(repository.integrations(actor)).resolves.toEqual([])
  })

  it('a segunda tranca vale para exportação e evento, e não só para integração', async () => {
    // Um auditor removeu `#inScope` de `exports()` e de `#events()`, e removeu
    // a conferência do projeto em `export()`: os testes continuaram verdes. Uma
    // tranca sem teste é uma tranca que some no primeiro refatoramento.
    const rows = store([
      { scope: actor, table: HUB_EXPORTS_TABLE, key: 'project-1/export-1', value: exported({ tenant_id: 'ws-9' }) },
      { scope: actor, table: HUB_EXPORTS_TABLE, key: 'project-9/export-2', value: exported({ export_id: 'export-2', project_id: 'project-9' }) },
      { scope: actor, table: HUB_EVENTS_TABLE, key: 'event-1', value: event({ tenant_id: 'ws-9' }) },
    ])
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    // Corpo com o inquilino errado: some da lista e da leitura por chave.
    await expect(repository.exports(actor, 'project-1')).resolves.toEqual([])
    await expect(repository.export(actor, 'project-1', 'export-1')).resolves.toBeUndefined()
    // A chave carrega o projeto, mas o CORPO também é conferido: pedir a
    // exportação por um projeto que não é o dela não a devolve.
    await expect(repository.export(actor, 'project-1', 'export-2')).resolves.toBeUndefined()
    // Evento com o inquilino errado no corpo não entra na contagem nem na página.
    await expect(repository.eventCount(actor)).resolves.toBe(0)
    await expect(repository.eventPage(actor, undefined, 10)).resolves.toEqual([])
  })

  it('a troca condicional só passa com a impressão digital que foi lida', async () => {
    const current = integration()
    const rows = store([{ scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: current }])
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    await expect(repository.compareAndSwapIntegration(actor, 'agenda', 'digital-errada', integration({ enabled: true })))
      .resolves.toBe(false)
    await expect(repository.integration(actor, 'agenda')).resolves.toMatchObject({ enabled: false })

    await expect(repository.compareAndSwapIntegration(actor, 'agenda', securityFingerprint(current), integration({ enabled: true })))
      .resolves.toBe(true)
    await expect(repository.integration(actor, 'agenda')).resolves.toMatchObject({ enabled: true })
  })

  it('duas trocas condicionais concorrentes: só uma passa', async () => {
    const current = integration()
    const rows = store([{ scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: current }])
    const repository = new TenantRecordHubRepository(rows, noSwitches)
    const fingerprint = securityFingerprint(current)

    const [first, second] = await Promise.all([
      repository.compareAndSwapIntegration(actor, 'agenda', fingerprint, integration({ effective_tier: 'T2' })),
      repository.compareAndSwapIntegration(actor, 'agenda', fingerprint, integration({ effective_tier: 'T3' })),
    ])
    // A fila serializa: a segunda lê o que a primeira gravou e a impressão
    // digital já não é a mesma. Sem ela, as duas leriam a MESMA versão.
    // O nível entra na impressão digital; o nome NÃO entra, de propósito -
    // ela cobre o estado relevante para segurança, e trocar o rótulo não
    // invalida uma decisão que a pessoa já tomou sobre a mesma integração.
    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('remover a integração não apaga o rastro dela', async () => {
    const rows = store([
      { scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: integration() },
      { scope: actor, table: HUB_EVENTS_TABLE, key: 'event-1', value: event() },
    ])
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    await repository.deleteIntegration(actor, 'agenda')
    await expect(repository.integration(actor, 'agenda')).resolves.toBeUndefined()
    await expect(repository.eventCount(actor)).resolves.toBe(1)
  })

  it('remover a integração de outro inquilino não remove nada', async () => {
    const rows = store([{ scope: actor, table: HUB_INTEGRATIONS_TABLE, key: 'agenda', value: integration() }])
    const repository = new TenantRecordHubRepository(rows, noSwitches)

    await repository.deleteIntegration(stranger, 'agenda')
    await expect(repository.integration(actor, 'agenda')).resolves.toMatchObject({ integration_id: 'agenda' })
  })

  it('a exportação é achada pelo projeto, e não por outro projeto com o mesmo identificador', async () => {
    const rows = store()
    const repository = new TenantRecordHubRepository(rows, noSwitches)
    await repository.putExport(exported())
    await repository.putExport(exported({ project_id: 'project-2' }))

    await expect(repository.export(actor, 'project-1', 'export-1')).resolves.toMatchObject({ project_id: 'project-1' })
    await expect(repository.export(actor, 'project-2', 'export-1')).resolves.toMatchObject({ project_id: 'project-2' })
    await expect(repository.exports(actor, 'project-1')).resolves.toHaveLength(1)
    await expect(repository.export(stranger, 'project-1', 'export-1')).resolves.toBeUndefined()
  })

  it('uma barra no identificador é RECUSADA, e não vira chave ambígua', async () => {
    // `a/b` + `c` e `a` + `b/c` dariam a MESMA chave, e uma exportação seria
    // lida como se fosse de outro projeto. `project_id` chega da URL depois de
    // `decodeURIComponent`: confiar que ninguém põe barra é confiar em quem
    // manda o pedido.
    const repository = new TenantRecordHubRepository(store(), noSwitches)
    await expect(repository.putExport(exported({ project_id: 'project/1' }))).rejects.toThrow('HUB_EXPORT_KEY_INVALID')
    await expect(repository.export(actor, 'project/1', 'export-1')).rejects.toThrow('HUB_EXPORT_KEY_INVALID')
  })

  it('a página de eventos vem do mais novo para o mais velho, e o cursor continua de onde parou', async () => {
    const rows = store()
    const repository = new TenantRecordHubRepository(rows, noSwitches)
    await repository.putEvent(event({ event_id: 'e1', created_at: '2026-09-01T00:00:01.000Z' }))
    await repository.putEvent(event({ event_id: 'e2', created_at: '2026-09-01T00:00:02.000Z' }))
    await repository.putEvent(event({ event_id: 'e3', created_at: '2026-09-01T00:00:03.000Z' }))
    await repository.putEvent(event({ event_id: 'x1', tenant_id: 'ws-2' }))

    const first = await repository.eventPage(actor, undefined, 2)
    expect(first.map(row => row.event_id)).toEqual(['e3', 'e2'])
    const next = await repository.eventPage(actor, { created_at: first.at(-1)!.created_at, event_id: first.at(-1)!.event_id }, 2)
    expect(next.map(row => row.event_id)).toEqual(['e1'])
    // O evento do outro inquilino nunca entrou nesta contagem.
    await expect(repository.eventCount(actor)).resolves.toBe(3)
  })

  it('a retenção corta a CAUDA, e nunca o que acabou de acontecer', async () => {
    const rows = store()
    const repository = new TenantRecordHubRepository(rows, noSwitches)
    for (const [index, id] of ['e1', 'e2', 'e3'].entries()) {
      await repository.putEvent(event({ event_id: id, created_at: `2026-09-01T00:00:0${String(index + 1)}.000Z` }))
    }

    await expect(repository.pruneEvents(actor, 1)).resolves.toBe(2)
    expect((await repository.eventPage(actor, undefined, 10)).map(row => row.event_id)).toEqual(['e3'])
  })

  it('os desligamentos por alcance continuam vindo de quem já os servia', async () => {
    const record = { switch_id: 'sw-1', org_id: 'org-1' } as IntegrationKillSwitch
    const source: HubKillSwitchSource = {
      killSwitch: id => id === 'sw-1' ? record : undefined,
      putKillSwitch: async () => undefined,
      killSwitches: orgId => orgId === 'org-1' ? [record] : [],
    }
    const repository = new TenantRecordHubRepository(store(), source)

    expect(repository.killSwitch('sw-1')).toBe(record)
    expect(repository.killSwitches('org-1')).toEqual([record])
    expect(repository.killSwitches('org-2')).toEqual([])
  })
})
