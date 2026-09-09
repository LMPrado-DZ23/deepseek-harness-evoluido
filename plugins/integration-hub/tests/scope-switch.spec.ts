import { describe, expect, it, vi } from 'vitest'
import { HubError, IntegrationHubService, type HubActor, type HubRepository } from '../src/service.ts'
import { killSwitchId, killSwitchIdsFor, type IntegrationKillSwitch } from '../src/model.ts'

const owner: HubActor = { userId: 'u1', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }

function repository() {
  const switches = new Map<string, IntegrationKillSwitch>()
  return {
    switches,
    integrations: async () => [],
    integration: async () => undefined,
    putIntegration: async () => {},
    deleteIntegration: async () => {},
    compareAndSwapIntegration: async () => true,
    exports: async () => [], export: async () => undefined, putExport: async () => {},
    eventPage: async () => [], eventCount: async () => 0, putEvent: async () => {}, pruneEvents: async () => 0,
    killSwitch: (switchId: string) => switches.get(switchId),
    putKillSwitch: async (value: IntegrationKillSwitch) => { switches.set(value.switch_id, value) },
    killSwitches: (orgId: string) => [...switches.values()].filter(record => record.org_id === orgId),
  } satisfies HubRepository & { switches: Map<string, IntegrationKillSwitch> }
}

function service(rows = repository()) {
  const instance = new IntegrationHubService({
    repository: rows,
    secrets: { inspect: async () => ({ present: true, kind: 'opaque' as const }) } as never,
    projects: { project: () => ({ state: 'READY' }) as never, runs: () => [] },
    exportsRoot: '/tmp/x', publisherKeys: {}, channel: 'production', runsRoot: '/tmp/y',
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  } as never)
  return { service: instance, rows }
}

describe('as chaves de alcance', () => {
  it('uma grafia só, porque duas seriam dois botões', () => {
    expect(killSwitchId({ level: 'organization', orgId: 'org-a' })).toBe('org:org-a')
    expect(killSwitchId({ level: 'project', orgId: 'org-a', tenantId: 't', projectId: 'p' })).toBe('project:org-a:t:p')
  })

  it('uma chamada confere do mais amplo ao mais fino', () => {
    expect(killSwitchIdsFor({ orgId: 'org-a', tenantId: 't', projectId: 'p' }))
      .toEqual(['org:org-a', 'project:org-a:t:p'])
    // Sem projeto, só a organização: uma chamada que não sabe de que projeto é
    // não pode ser barrada por um botão de projeto.
    expect(killSwitchIdsFor({ orgId: 'org-a', tenantId: 't' })).toEqual(['org:org-a'])
  })
})

describe('desligar por alcance', () => {
  it('desligar não exige motivo; RELIGAR exige', async () => {
    // A mesma assimetria do botão de emergência: redigir enquanto algo está
    // queimando é o pior momento para pedir texto.
    const f = service()
    await expect(f.service.setScopeDisabled(owner, { level: 'organization' }, true)).resolves.toMatchObject({ disabled: true })
    await expect(f.service.setScopeDisabled(owner, { level: 'organization' }, false)).rejects.toBeInstanceOf(HubError)
    await expect(f.service.setScopeDisabled(owner, { level: 'organization' }, false, 'curto')).rejects.toBeInstanceOf(HubError)
    await expect(f.service.setScopeDisabled(owner, { level: 'organization' }, false, 'o incidente foi resolvido'))
      .resolves.toMatchObject({ disabled: false, enabled_by: 'u1' })
  })

  it('os DOIS lados da história ficam guardados', async () => {
    // A pergunta depois de um incidente nunca é só "está desligado?".
    const f = service()
    await f.service.setScopeDisabled(owner, { level: 'project', projectId: 'p1' }, true, 'fornecedor cobrando errado')
    const back = await f.service.setScopeDisabled(owner, { level: 'project', projectId: 'p1' }, false, 'fornecedor corrigiu a cobranca')
    expect(back).toMatchObject({
      disabled: false, disabled_by: 'u1', reason: 'fornecedor cobrando errado', enabled_by: 'u1',
    })
    expect(back.disabled_at).not.toBeNull()
    expect(back.enabled_at).not.toBeNull()
  })

  it('desligar a ORGANIZAÇÃO desliga também os projetos dela', () => {
    // Um desligamento contornável por um nível mais fino não seria um
    // desligamento.
    const f = service()
    f.rows.switches.set('org:org-a', {
      switch_id: 'org:org-a', level: 'organization', org_id: 'org-a', tenant_id: null, project_id: null,
      disabled: true, disabled_by: 'u1', disabled_at: '2026-09-08T12:00:00.000Z', reason: null,
      enabled_by: null, enabled_at: null, updated_at: '2026-09-08T12:00:00.000Z',
    })
    expect(() => f.service.assertScopeEnabled(owner, 'p1')).toThrow(HubError)
    expect(() => f.service.assertScopeEnabled(owner)).toThrow(HubError)
  })

  it('religar um PROJETO não religa a organização', async () => {
    const f = service()
    await f.service.setScopeDisabled(owner, { level: 'organization' }, true)
    await f.service.setScopeDisabled(owner, { level: 'project', projectId: 'p1' }, true)
    await f.service.setScopeDisabled(owner, { level: 'project', projectId: 'p1' }, false, 'projeto liberado de novo')
    expect(() => f.service.assertScopeEnabled(owner, 'p1')).toThrow(HubError)
  })

  it('o desligamento de um projeto não alcança outro', async () => {
    const f = service()
    await f.service.setScopeDisabled(owner, { level: 'project', projectId: 'p1' }, true)
    expect(() => f.service.assertScopeEnabled(owner, 'p1')).toThrow(HubError)
    expect(() => f.service.assertScopeEnabled(owner, 'p2')).not.toThrow()
  })

  it('sem nenhum botão apertado, nada é barrado', () => {
    const f = service()
    expect(() => f.service.assertScopeEnabled(owner, 'p1')).not.toThrow()
  })

  it('a listagem mostra o alcance da organização e os projetos DESTE inquilino', async () => {
    const f = service()
    await f.service.setScopeDisabled(owner, { level: 'organization' }, true)
    await f.service.setScopeDisabled(owner, { level: 'project', projectId: 'p1' }, true)
    await f.service.setScopeDisabled({ ...owner, tenantId: 'outro' }, { level: 'project', projectId: 'p9' }, true)
    // O botão da organização aparece para os dois inquilinos - ele vale para
    // os dois. O projeto do outro inquilino, não.
    expect(f.service.scopeSwitches(owner).map(record => record.switch_id))
      .toEqual(['org:org-a', 'project:org-a:tenant-a:p1'])
  })

  it('mexer no botão é ESCRITA: quem só acompanha não desliga o trabalho de todos', async () => {
    const f = service()
    const viewer: HubActor = { ...owner, role: 'viewer' }
    await expect(f.service.setScopeDisabled(viewer, { level: 'organization' }, true)).rejects.toBeInstanceOf(HubError)
    expect(() => f.service.scopeSwitches(viewer)).not.toThrow()
  })

  it('motivo grande demais é recusado', async () => {
    const f = service()
    await expect(f.service.setScopeDisabled(owner, { level: 'organization' }, true, 'x'.repeat(501)))
      .rejects.toBeInstanceOf(HubError)
  })
})
