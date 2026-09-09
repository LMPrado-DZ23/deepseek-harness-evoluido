import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../src/manifest.ts'
import { studioIntegrationSchema, studioIntegrationsDomainSpec, type HubEvent, type IntegrationKillSwitch, type IntegrationManifest, type StudioExport, type StudioIntegration } from '../src/model.ts'
import { integrationHealthState } from '../src/runtime.ts'
import {
  HubError, IntegrationHubService, auditOperation, securityFingerprint,
  type HubActor, type HubRepository,
} from '../src/service.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; exportRows: StudioExport[] = []; eventRows: HubEvent[] = []
  integrations = async (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = async (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  deleteIntegration = async (scope: HubActor, integrationId: string) => { this.rows = this.rows.filter(row => !(row.integration_id === integrationId && row.org_id === scope.orgId && row.tenant_id === scope.tenantId)) }
  putIntegration = async (value: StudioIntegration) => {
    this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id || row.org_id !== value.org_id || row.tenant_id !== value.tenant_id), value]
  }
  compareAndSwapIntegration = async (scope: HubActor, integrationId: string, expected: string, value: StudioIntegration) => {
    const current = await this.integration(scope, integrationId)
    if (current === undefined || securityFingerprint(current) !== expected) return false
    await this.putIntegration(value); return true
  }
  exports = async () => []
  export = async () => undefined
  putExport = async () => undefined
  eventPage = async (scope: HubActor, after: Pick<HubEvent, 'created_at' | 'event_id'> | undefined, limit: number) => {
    const rows = this.eventRows.filter(row => sameScope(scope, row)).sort(newestFirst)
    const start = after === undefined ? 0 : rows.findIndex(row => newestFirst(row, after) > 0)
    return start < 0 ? [] : rows.slice(start, start + limit)
  }
  eventCount = async (scope: HubActor) => this.eventRows.filter(row => sameScope(scope, row)).length
  putEvent = async (value: HubEvent) => { this.eventRows = [...this.eventRows, value] }
  pruneEvents = async () => 0
  readonly switches = new Map<string, IntegrationKillSwitch>()
  killSwitch = (switchId: string) => this.switches.get(switchId)
  putKillSwitch = async (value: IntegrationKillSwitch) => { this.switches.set(value.switch_id, value) }
  killSwitches = (orgId: string) => [...this.switches.values()].filter(record => record.org_id === orgId)
}

function sameScope(scope: HubActor, value: { org_id: string; tenant_id: string }): boolean {
  return scope.orgId === value.org_id && scope.tenantId === value.tenant_id
}
function newestFirst(left: Pick<HubEvent, 'created_at' | 'event_id'>, right: Pick<HubEvent, 'created_at' | 'event_id'>): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.event_id < right.event_id ? 1 : left.event_id > right.event_id ? -1 : 0
}

const admin: HubActor = { userId: 'u-admin', orgId: 'org-a', tenantId: 'ws-a', role: 'admin' }
const viewer: HubActor = { ...admin, userId: 'u-viewer', role: 'viewer' }
const otherTenant: HubActor = { ...admin, tenantId: 'ws-b' }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  const value = {
    schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0', ...overrides,
  } as IntegrationManifest
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

async function build(options: {
  callPolicy?: Parameters<typeof buildService>[1]
  emergencyStop?: { assertRunning(scope: { readonly orgId: string; readonly tenantId: string }): void }
} = {}) {
  return buildService(await scratchRoot(), options.callPolicy, options.emergencyStop)
}

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-hub-calls-'))
  scratch.push(root)
  return root
}

function buildService(
  root: string,
  callPolicy?: { timeoutMs?: number; maxCallsPerWindow?: number; windowMs?: number; retryOnce?: boolean },
  emergencyStop?: { assertRunning(scope: { readonly orgId: string; readonly tenantId: string }): void },
) {
  const repository = new MemoryRepository()
  let sequence = 0
  const service = new IntegrationHubService({
    repository, exportsRoot: root, runsRoot: root, publisherKeys, channel: 'stable',
    secrets: { inspect: async () => ({ present: false, shapeOk: false }) },
    projects: { project: () => { throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }) }, runs: () => [] },
    ...(callPolicy === undefined ? {} : { callPolicy }),
    ...(emergencyStop === undefined ? {} : { emergencyStop }),
    now: () => new Date('2026-09-04T00:00:00.000Z'), createId: () => `id-${++sequence}`,
  })
  return { service, repository }
}

/** Uma integração registrada e LIGADA, que é a única condição em que ela pode ser chamada. */
async function enabled(service: IntegrationHubService, overrides: Partial<IntegrationManifest> = {}): Promise<string> {
  const registered = await service.register(admin, manifest(overrides))
  await service.setEnabled(admin, registered.integration.integration_id, true)
  return registered.integration.integration_id
}

describe('chamada de integração', () => {
  it('o desligamento por ALCANCE barra a chamada antes de qualquer efeito', async () => {
    // Este é o ponto onde X-07 vale ou não vale: sem a conferência aqui, o
    // botão existiria na tela e a chamada sairia mesmo assim.
    const { service, repository } = await build()
    const id = await enabled(service)
    let saiu = false
    const invoke = async () => { saiu = true; return 'pronto' }

    await service.setScopeDisabled(admin, { level: 'project', projectId: 'p1' }, true, 'fornecedor cobrando errado')
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true, projectId: 'p1' }, invoke))
      .rejects.toBeInstanceOf(HubError)
    expect(saiu).toBe(false)
    // Barrada ANTES do teto: uma chamada recusada não pode gastar a cota de
    // quem ainda vai voltar a trabalhar.
    expect((await service.health(admin, id)).calls).toBe(0)

    // Outro projeto continua trabalhando.
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true, projectId: 'p2' }, invoke))
      .resolves.toMatchObject({ state: 'OK' })

    // E o botão da ORGANIZAÇÃO alcança todos, inclusive quem não diz o projeto.
    await service.setScopeDisabled(admin, { level: 'organization' }, true)
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true, projectId: 'p2' }, invoke))
      .rejects.toBeInstanceOf(HubError)
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, invoke))
      .rejects.toBeInstanceOf(HubError)
    expect(repository.eventRows.some(row => row.detail.includes('scope organization disabled'))).toBe(true)
  })


  it('uma integração ligada que responde fica OK, e o custo sem preço é UNKNOWN em vez de zero', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    // Antes de qualquer chamada a saúde é NOT_EXECUTED: nunca "OK" sem ter sido chamada.
    expect((await service.health(admin, id)).state).toBe('NOT_EXECUTED')
    const result = await service.callIntegration(admin, id, { operation: 'agenda.listar', idempotent: true }, async () => 'pronto')
    expect(result).toMatchObject({ state: 'OK', value: 'pronto', attempts: 1, retried: false, cost: 'UNKNOWN' })
    const health = await service.health(admin, id)
    expect(health.state).toBe('OK')
    expect(health.calls).toBe(1)
    expect(health.failures).toBe(0)
    // Sem preço informado o custo NÃO soma zero: a chamada entra como não precificada.
    expect(health.cost_state).toBe('UNKNOWN')
    expect(health.cost_usd).toBe(0)
    // Cada chamada deixa uma linha no histórico.
    expect(repository.eventRows.filter(row => row.action === 'integration.called')).toMatchObject([
      { outcome: 'success', subject_id: id, detail: 'agenda.listar OK attempts=1 cost=UNKNOWN' },
    ])
  })

  it('soma o custo medido quando há preço, e vira PARTIAL quando só parte das chamadas tinha', async () => {
    const { service } = await build()
    const id = await enabled(service)
    await service.callIntegration(admin, id, { operation: 'c', idempotent: true, priceUsd: 0.25 }, async () => 1)
    expect(await service.health(admin, id)).toMatchObject({ cost_state: 'MEASURED', cost_usd: 0.25 })
    await service.callIntegration(admin, id, { operation: 'c', idempotent: true }, async () => 1)
    // O valor continua sendo um piso, e o estado diz isso em vez de anunciar um total.
    expect(await service.health(admin, id)).toMatchObject({ cost_state: 'PARTIAL', cost_usd: 0.25 })
  })

  it('repete exatamente uma vez uma operação idempotente que falhou, e nunca uma que não é', async () => {
    const { service } = await build()
    const idempotent = await enabled(service)
    let attempts = 0
    const recovered = await service.callIntegration(admin, idempotent, { operation: 'ler', idempotent: true }, async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('cai uma vez')
      return 'ok na segunda'
    })
    expect(attempts).toBe(2)
    expect(recovered).toMatchObject({ state: 'OK', attempts: 2, retried: true })
    expect(await service.health(admin, idempotent)).toMatchObject({ calls: 2, failures: 1, retries: 1 })

    const unsafe = await enabled(service, { id: 'cobranca', name: 'Cobrança' })
    let sent = 0
    const refused = await service.callIntegration(admin, unsafe, { operation: 'cobrar', idempotent: false }, async () => {
      sent += 1
      throw new TypeError('caiu')
    })
    // Repetir uma cobrança cobra duas vezes do outro lado e, daqui, parece uma falha só.
    expect(sent).toBe(1)
    expect(refused).toMatchObject({ state: 'FAILED', attempts: 1, retried: false })
  })

  it('nunca tenta uma terceira vez, mesmo que as duas falhem', async () => {
    const { service } = await build()
    const id = await enabled(service)
    let attempts = 0
    const result = await service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => {
      attempts += 1
      throw new TypeError('sempre cai')
    })
    expect(attempts).toBe(2)
    expect(result).toMatchObject({ state: 'FAILED', attempts: 2, retried: true })
    const health = await service.health(admin, id)
    expect(health).toMatchObject({ calls: 2, failures: 2 })
    expect(health.state).toBe('DOWN')
    // Só a CLASSE do erro sobrevive: a mensagem do provedor costuma trazer host,
    // banner ou pedaço do segredo.
    expect(health.last_failure).toBe('TypeError')
    if (result.state === 'OK') throw new Error('esperado FAILED')
    expect(result.message).not.toContain('sempre cai')
  })

  it('para de esperar uma chamada que não volta, avisa a chamada abandonada e conta o estouro', async () => {
    const { service, repository } = await build({ callPolicy: { timeoutMs: 20, retryOnce: false } })
    const id = await enabled(service)
    let aborted = false
    const result = await service.callIntegration(admin, id, { operation: 'lento', idempotent: true }, async signal => {
      signal.addEventListener('abort', () => { aborted = true })
      return new Promise<string>(() => undefined)
    })
    expect(result.state).toBe('TIMEOUT')
    // O Studio não mata a chamada — ele pede que ela desista e para de esperar.
    expect(aborted).toBe(true)
    expect(await service.health(admin, id)).toMatchObject({ calls: 1, failures: 1, timeouts: 1 })
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'failure' })
    expect(repository.eventRows.at(-1)!.detail).toContain('TIMEOUT')
  })

  it('recusa a chamada de uma integração desligada e registra que NADA foi executado', async () => {
    const { service, repository } = await build()
    const registered = await service.register(admin, manifest())
    const id = registered.integration.integration_id
    let called = false
    await expect(service.callIntegration(admin, id, { operation: 'x', idempotent: true }, async () => { called = true; return 1 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(called).toBe(false)
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'not-executed' })
    // Nada saiu: os contadores continuam vazios e a saúde continua NOT_EXECUTED.
    expect((await service.health(admin, id)).state).toBe('NOT_EXECUTED')
    expect((await service.health(admin, id)).calls).toBe(0)
  })

  it('o teto é por integração e por escopo, e a repetição também gasta cota', async () => {
    const { service, repository } = await build({ callPolicy: { maxCallsPerWindow: 2, retryOnce: true } })
    const first = await enabled(service)
    const second = await enabled(service, { id: 'estoque', name: 'Estoque' })
    // Uma chamada que falha e repete gasta as DUAS tentativas da janela: a
    // repetição sai pela rede como qualquer outra.
    const failed = await service.callIntegration(admin, first, { operation: 'ler', idempotent: true }, async () => { throw new TypeError('cai') })
    expect(failed).toMatchObject({ attempts: 2, retried: true })
    await expect(service.callIntegration(admin, first, { operation: 'ler', idempotent: true }, async () => 1))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'not-executed' })
    // A outra integração, e o outro inquilino, têm cada um a sua cota.
    await expect(service.callIntegration(admin, second, { operation: 'ler', idempotent: true }, async () => 1)).resolves.toMatchObject({ state: 'OK' })
  })

  it('a repetição não acontece quando ela mesma não caberia no teto', async () => {
    const { service } = await build({ callPolicy: { maxCallsPerWindow: 1, retryOnce: true } })
    const id = await enabled(service)
    let attempts = 0
    const result = await service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => {
      attempts += 1
      throw new TypeError('cai')
    })
    // Dobrar a carga em cima de um provedor que está falhando é o pior momento
    // possível para gastar a cota de todo mundo.
    expect(attempts).toBe(1)
    expect(result).toMatchObject({ state: 'FAILED', attempts: 1, retried: false })
  })

  it('quem só lê não chama nada, e ninguém chama a integração de outro inquilino', async () => {
    const { service } = await build()
    const id = await enabled(service)
    await expect(service.callIntegration(viewer, id, { operation: 'x', idempotent: true }, async () => 1))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.callIntegration({ ...otherTenant, role: 'admin' }, id, { operation: 'x', idempotent: true }, async () => 1))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await service.health(admin, id)).state).toBe('NOT_EXECUTED')
  })

  it('a saúde e os contadores ficam no escopo em que a chamada aconteceu', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    await service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => 1)
    expect((await service.health(admin, id)).calls).toBe(1)
    // A mesma integração noutro inquilino é outro registro: não existe aqui.
    expect(repository.rows.filter(row => row.tenant_id === 'ws-b')).toEqual([])
  })

  it('o nome da operação entra no histórico sem quebra de linha nem espaço', () => {
    // Uma linha de auditoria com quebra de linha dentro deixa de ser uma linha:
    // quem lê o histórico passa a ver duas, uma delas escrita por quem chamou.
    expect(auditOperation('agenda listar\nintegration.enabled sucesso')).toBe('agenda-listar-integration.enabled-sucesso')
    expect(auditOperation('   ')).toBe('call')
    expect(auditOperation('a'.repeat(200))).toHaveLength(64)
  })

  it('a saúde derivada nunca discorda dos contadores gravados', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    await service.callIntegration(admin, id, { operation: 'ler', idempotent: false }, async () => { throw new TypeError('cai') })
    const stored = repository.rows.find(row => row.integration_id === id)!
    // Não existe campo de saúde gravado para envelhecer e passar a discordar:
    // ela sai dos contadores toda vez que alguém pergunta.
    expect((await service.health(admin, id)).state).toBe(integrationHealthState(stored))
  })

  it('ligar e desligar continua funcionando depois de uma chamada ter mexido no registro', async () => {
    const { service } = await build()
    const id = await enabled(service)
    await service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => 1)
    // Os contadores são gravados sobre o registro MAIS RECENTE, dentro da mesma
    // exclusão do ligar/desligar: uma cópia antiga desfaria, calada, o que
    // chegou no meio da chamada.
    const disabled = await service.setEnabled(admin, id, false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.calls).toBe(1)
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => 1))
      .rejects.toBeInstanceOf(HubError)
  })
})

describe('registro gravado antes destes campos', () => {
  it('continua abrindo, e a versão do domínio continua sendo 1', () => {
    // Uma instalação que já existe não tem migração: se a versão subir, `open()`
    // falha com `version-mismatch` e o Studio não abre o domínio inteiro.
    expect(studioIntegrationsDomainSpec.version).toBe(1)
    const legacy = {
      integration_id: 'i-antigo', org_id: 'org-a', tenant_id: 'ws-a', kind: 'skill', name: 'Agenda',
      manifest: null, effective_tier: 'T2', verification: 'verified', enabled: true, secret_ref: null,
      created_by: 'u-1', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }
    // Nenhum campo novo é obrigatório: a linha antiga passa exatamente como está.
    expect(studioIntegrationSchema.parse(legacy)).toMatchObject({ integration_id: 'i-antigo' })
    expect(studioIntegrationSchema.parse(legacy)).not.toHaveProperty('calls')
  })
})

describe('catálogo pelo serviço', () => {
  it('devolve uma página e os dois totais, e exige leitura do espaço de trabalho', async () => {
    const { service } = await build()
    await service.register(admin, manifest({ id: 'agenda', name: 'Agenda' }))
    await service.register(admin, manifest({ id: 'estoque', name: 'Estoque' }))
    const page = await service.searchIntegrations(viewer, { limit: 1 })
    expect(page.integrations.map(row => row.name)).toEqual(['Agenda'])
    expect(page.total).toBe(2)
    expect(page.matched).toBe(2)
    expect(page.next_cursor).not.toBeNull()
    // Outro inquilino não vê nada — nem os totais de quem ele não é.
    expect(await service.searchIntegrations(otherTenant)).toMatchObject({ total: 0, matched: 0 })
  })

  it('um cursor ilegível é pedido inválido, não erro interno', async () => {
    const { service } = await build()
    await expect(service.searchIntegrations(admin, { cursor: 'lixo' })).rejects.toThrow(HubError)
    try { await service.searchIntegrations(admin, { cursor: 'lixo' }) } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID' })
    }
  })
})

describe('E-11: a parada de emergência alcança as chamadas de integração', () => {
  function stopped() {
    const error = new Error('O Studio está parado por uma parada de emergência.') as Error & { code?: string }
    error.code = 'STOPPED'
    return error
  }

  it('escopo parado não chama fornecedor nenhum, e a recusa não gasta a cota de ninguém', async () => {
    const { service } = await build({ emergencyStop: { assertRunning: () => { throw stopped() } } })
    const running = await build()
    const id = await enabled(running.service)
    let called = false
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => { called = true; return 1 }))
      .rejects.toMatchObject({ code: 'STOPPED' })
    expect(called).toBe(false)
  })

  it('a parada de outro escopo não impede esta chamada', async () => {
    const { service } = await build({
      emergencyStop: { assertRunning: scope => { if (scope.tenantId === 'ws-b') throw stopped() } },
    })
    const id = await enabled(service)
    await expect(service.callIntegration(admin, id, { operation: 'ler', idempotent: true }, async () => 1))
      .resolves.toMatchObject({ state: 'OK' })
  })

  it('cancelar por escopo abandona a chamada em voo, e NUNCA a conta como cancelada', async () => {
    const { service } = await build()
    const id = await enabled(service)
    let observed: AbortSignal | undefined
    const call = service.callIntegration(admin, id, { operation: 'lento', idempotent: true }, async signal => {
      observed = signal
      return new Promise<number>(resolve => { signal.addEventListener('abort', () => { resolve(0) }, { once: true }) })
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    // A lista devolvida é do que foi ABANDONADO: o Studio pediu desistência e
    // não fala com o outro lado da rede.
    expect(service.cancelScope({ orgId: 'org-a', tenantId: 'ws-a' })).toEqual([id])
    expect(observed?.aborted).toBe(true)
    await call
    // Terminada, ela sai do registro: nada de relatar como "em voo" o que acabou.
    expect(service.cancelScope({ orgId: 'org-a', tenantId: 'ws-a' })).toEqual([])
  })

  it('cancelar um escopo não toca chamada de outro', async () => {
    const { service } = await build()
    const id = await enabled(service)
    const call = service.callIntegration(admin, id, { operation: 'lento', idempotent: true }, async signal =>
      new Promise<number>(resolve => { signal.addEventListener('abort', () => { resolve(0) }, { once: true }) }))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(service.cancelScope({ orgId: otherTenant.orgId, tenantId: otherTenant.tenantId })).toEqual([])
    service.cancelScope({ orgId: 'org-a', tenantId: 'ws-a' })
    await call
  })
})
