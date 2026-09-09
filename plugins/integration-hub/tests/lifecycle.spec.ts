/**
 * X-04 — o ciclo de vida da integração: instalar, testar, ligar, desligar,
 * atualizar e remover.
 *
 * O que estes testes protegem:
 *
 * - REMOVER é destrutivo, e portanto: só desligado, com a mesma confirmação
 *   que ligar exigiria, e sem apagar a auditoria;
 * - TESTAR não executa nada do lado de lá, e não inventa um "funcionando" para
 *   um tipo que não tem com quem conectar;
 * - ATUALIZAR nunca deixa a integração ligada: uma versão nova pode pedir
 *   coisas que a anterior não pedia, e "continuou ligada" seria uma permissão
 *   concedida por inércia.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationKillSwitch, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import {
  HubError, IntegrationHubService, securityFingerprint,
  type HubActor, type HubRepository, type McpCallOutcome, type McpDispatchPort, type McpProbeInput, type McpProbeOutcome,
} from '../src/service.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; eventRows: HubEvent[] = []
  integrations = async (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = async (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  deleteIntegration = async (scope: HubActor, integrationId: string) => {
    this.rows = this.rows.filter(row => !(sameScope(scope, row) && row.integration_id === integrationId))
  }
  putIntegration = async (value: StudioIntegration) => { this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value] }
  compareAndSwapIntegration = async (scope: HubActor, integrationId: string, expected: string, value: StudioIntegration) => {
    const current = await this.integration(scope, integrationId)
    if (current === undefined || securityFingerprint(current) !== expected) return false
    await this.putIntegration(value); return true
  }
  exports = async (): Promise<readonly StudioExport[]> => []
  export = async () => undefined
  putExport = async () => undefined
  eventPage = async () => []
  eventCount = async () => this.eventRows.length
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

const admin: HubActor = { userId: 'u-admin', orgId: 'org-a', tenantId: 'ws-a', role: 'admin' }
const stranger: HubActor = { userId: 'u-other', orgId: 'org-b', tenantId: 'ws-b', role: 'admin' }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

function manifestOf(overrides: Record<string, unknown> = {}): IntegrationManifest {
  const value = {
    schema_version: 1, id: 'agenda-mcp', name: 'Agenda MCP', version: '1.0.0', kind: 'mcp',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T1', ...overrides,
  } as IntegrationManifest
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

async function build() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-hub-life-'))
  scratch.push(root)
  const repository = new MemoryRepository()
  let sequence = 0
  const service = new IntegrationHubService({
    repository, exportsRoot: root, runsRoot: root, publisherKeys, channel: 'stable',
    secrets: { inspect: async () => ({ present: false, shapeOk: false }) },
    projects: { project: () => { throw new Error('sem projeto') }, runs: () => [] },
    now: () => new Date('2026-09-08T00:00:00.000Z'), createId: () => `id-${++sequence}`,
  })
  return { service, repository }
}

function prober(outcome?: () => Promise<McpProbeOutcome>): McpDispatchPort & { readonly probes: McpProbeInput[] } {
  const probes: McpProbeInput[] = []
  return {
    probes,
    async probe(input: McpProbeInput): Promise<McpProbeOutcome> {
      probes.push(input)
      return outcome === undefined ? { protocolVersion: '2025-06-18', serverName: 'agenda', tools: ['listar', 'marcar'] } : outcome()
    },
    async call(): Promise<McpCallOutcome> { throw new Error('o teste de conexão NUNCA chama ferramenta') },
  }
}

describe('X-04 remover', () => {
  it('remove uma integração desligada, e o registro some da lista', async () => {
    const { service, repository } = await build()
    const { integration } = await service.register(admin, manifestOf())
    expect(await service.list(admin)).toHaveLength(1)
    const removed = await service.removeIntegration(admin, integration.integration_id)
    expect(removed).toMatchObject({ integration_id: integration.integration_id, name: 'Agenda MCP' })
    expect(await service.list(admin)).toHaveLength(0)
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.removed', outcome: 'success' })
  })

  it('NÃO remove uma integração LIGADA: desligar é uma decisão, não um efeito colateral de apagar', async () => {
    const { service, repository } = await build()
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    const failure = await service.removeIntegration(admin, integration.integration_id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect((failure as HubError).code).toBe('CONFLICT')
    expect(await service.list(admin)).toHaveLength(1)
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.removed', outcome: 'failure', detail: 'still-enabled' })
  })

  it('os EVENTOS ficam: remover a integração não apaga a auditoria do que ela fez', async () => {
    const { service, repository } = await build()
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    await service.setEnabled(admin, integration.integration_id, false)
    const before = repository.eventRows.length
    await service.removeIntegration(admin, integration.integration_id)
    // Nenhum evento sumiu, e o de remoção entrou: apagar o rastro junto seria
    // exatamente o que alguém faria depois de um incidente.
    expect(repository.eventRows.length).toBe(before + 1)
    expect(repository.eventRows.filter(row => row.action === 'integration.enabled')).not.toHaveLength(0)
  })

  it('não remove a integração de outro espaço de trabalho', async () => {
    const { service } = await build()
    const { integration } = await service.register(admin, manifestOf())
    const failure = await service.removeIntegration(stranger, integration.integration_id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect((failure as HubError).code).toBe('NOT_FOUND')
    expect(await service.list(admin)).toHaveLength(1)
  })

  it('remover algo que não existe é NOT_FOUND, e não um sucesso silencioso', async () => {
    const { service } = await build()
    const failure = await service.removeIntegration(admin, 'nunca-existiu').catch((error: unknown) => error)
    expect((failure as HubError).code).toBe('NOT_FOUND')
  })

  it('a remoção de um nível que exige confirmação é RECUSADA sem ela', async () => {
    const { service } = await build()
    // `network.outbound` leva o piso a T2, que exige confirmação.
    const { integration } = await service.register(admin, manifestOf({ id: 'com-rede', permissions: ['network.outbound'], tier: 'T2' }))
    expect(service.requiredApprovalTier(integration)).not.toBeNull()
    const failure = await service.removeIntegration(admin, integration.integration_id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect(await service.list(admin)).toHaveLength(1)
  })

  it('religada ENQUANTO a pessoa confirmava: a remoção é recusada, e não apaga algo ligado', async () => {
    // O caminho que este teste cobre é o de duas mãos: a pessoa manda remover, e
    // entre a leitura e a gravação outra coisa (outra aba, outra pessoa, um
    // script) religa a integração. Sem a releitura, o registro seria apagado
    // LIGADO — e o que sumiria junto é a lista do que ela podia fazer.
    const { service, repository } = await build()
    const { integration } = await service.register(admin, manifestOf())
    const original = repository.integration.bind(repository)
    let reads = 0
    repository.integration = (scope: HubActor, integrationId: string) => {
      const row = original(scope, integrationId)
      reads += 1
      // A primeira leitura vê desligado (passa pela guarda); da segunda em
      // diante, alguém já religou.
      return row === undefined || reads <= 1 ? row : { ...row, enabled: true }
    }
    const failure = await service.removeIntegration(admin, integration.integration_id).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect((failure as HubError).code).toBe('CONFLICT')
    expect(repository.rows).toHaveLength(1)
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.removed', outcome: 'failure', detail: 'changed-during-approval' })
  })

  it('a referência do segredo VOLTA no resultado, porque o Studio não apaga do cofre', async () => {
    // Quem cuida do cofre precisa saber qual referência deixou de ser usada.
    // Apagar do cofre por conta própria seria este serviço decidir sobre um
    // segredo que outra coisa pode estar usando.
    const { service } = await build()
    const { integration } = await service.register(admin, manifestOf())
    const removed = await service.removeIntegration(admin, integration.integration_id)
    expect(removed.secret_ref).toBeNull()
  })
})

describe('X-04 testar a conexão', () => {
  it('conecta de verdade, lê o catálogo e NÃO executa ferramenta nenhuma', async () => {
    const { service, repository } = await build()
    const dispatcher = prober()
    service.useMcpDispatcher(dispatcher)
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('OK')
    expect(result.message).toContain('agenda')
    expect(result.message).toContain('2')
    // A prova de que testar não é usar: o despachante sondou uma vez e `call`
    // lança se for tocado.
    expect(dispatcher.probes).toHaveLength(1)
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'success' })
  })

  it('uma habilidade não tem com quem conectar, e a resposta diz isso em vez de "OK"', async () => {
    const { service, repository } = await build()
    const { integration } = await service.register(admin, manifestOf({ id: 'habilidade', kind: 'skill' }))
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('NOT_APPLICABLE')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.tested', outcome: 'not-executed', detail: 'skill-has-no-connection' })
  })

  it('webhook ainda não tem teste, e isso é dito — não é um OK e não é uma falha do servidor da pessoa', async () => {
    const { service } = await build()
    const { integration } = await service.register(admin, manifestOf({ id: 'gancho', kind: 'webhook', endpoint: 'https://servico.example/hook', tier: 'T2' }))
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('NOT_APPLICABLE')
  })

  it('integração DESLIGADA não é testada: testar ligaria o que ninguém mandou ligar', async () => {
    const { service, repository } = await build()
    service.useMcpDispatcher(prober())
    const { integration } = await service.register(admin, manifestOf())
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('NOT_EXECUTED')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.tested', detail: 'disabled' })
  })

  it('sem despachante montado, NOT_EXECUTED — e a frase não culpa o servidor da pessoa', async () => {
    const { service, repository } = await build()
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('NOT_EXECUTED')
    expect(result.message).toContain('Studio')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.tested', detail: 'no-dispatcher' })
  })

  it('quando o servidor cai, é FAILED — e a mensagem do provedor NÃO sai daqui', async () => {
    const { service } = await build()
    service.useMcpDispatcher(prober(async () => { throw new Error('conectou em 10.0.0.7:9000 com a senha hunter2') }))
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('FAILED')
    expect(result.message).not.toContain('hunter2')
    expect(result.message).not.toContain('10.0.0.7')
    // E o CÓDIGO técnico também não entra na frase. A pessoa lê a frase, não o
    // estado da máquina: "…não deu certo FAILED" é o defeito que E-06 existe
    // para não repetir. O estado vai no campo `result`, que é onde o programa
    // olha.
    for (const code of ['FAILED', 'TIMEOUT', 'NOT_EXECUTED', 'OK']) expect(result.message).not.toContain(code)
  })

  it('o servidor que não responde a tempo é TIMEOUT, e não FAILED', async () => {
    // "não respondeu a tempo" e "recusou" mandam a pessoa fazer coisas
    // diferentes: esperar, ou ir mexer na configuração. Colapsar os dois faz
    // ela mexer justamente no que estava certo.
    const { service } = await build()
    service.useMcpDispatcher(prober(async () => {
      await new Promise(resolve => setTimeout(resolve, 50_000))
      throw new Error('inalcançável')
    }))
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('TIMEOUT')
    expect(result.message).toContain('a tempo')
  }, 60_000)

  it('a sondagem é IDEMPOTENTE: uma falha de rede é tentada de novo, porque nada foi executado do lado de lá', async () => {
    // Isto é o que separa sondar de chamar: repetir um aperto de mão que falhou
    // não pode ter efeito no servidor da pessoa, e por isso vale repetir. Uma
    // chamada de ferramenta não idempotente NÃO é repetida.
    const { service } = await build()
    let attempts = 0
    service.useMcpDispatcher(prober(async () => { attempts += 1; throw new Error('rede caiu') }))
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    const result = await service.testIntegration(admin, integration.integration_id)
    expect(result.result).toBe('FAILED')
    expect(attempts).toBe(2)
  })

  it('testar não é autorizado a quem não gerencia integrações', async () => {
    const { service } = await build()
    const { integration } = await service.register(admin, manifestOf())
    const viewer: HubActor = { ...admin, role: 'viewer' }
    await expect(service.testIntegration(viewer, integration.integration_id)).rejects.toBeInstanceOf(HubError)
  })
})

describe('X-04 atualizar', () => {
  it('uma versão nova NUNCA fica ligada por inércia', async () => {
    const { service } = await build()
    const { integration } = await service.register(admin, manifestOf())
    await service.setEnabled(admin, integration.integration_id, true)
    expect((await service.list(admin))[0]!.enabled).toBe(true)

    // A mesma integração, versão nova, agora pedindo a rede.
    const updated = await service.register(admin, manifestOf({ version: '2.0.0', permissions: ['network.outbound'], tier: 'T2' }))
    // Mesmo registro (o id não muda: é a MESMA integração)…
    expect(updated.integration.integration_id).toBe(integration.integration_id)
    // …e DESLIGADA. Continuar ligada seria conceder por inércia uma permissão
    // que a versão anterior não tinha.
    expect(updated.integration.enabled).toBe(false)
    expect((await service.list(admin))[0]!.enabled).toBe(false)
    expect(updated.integration.effective_tier).toBe('T2')
  })

  it('a atualização preserva quem instalou e quando, e não reescreve a história', async () => {
    const { service } = await build()
    const first = await service.register(admin, manifestOf())
    const second = await service.register({ ...admin, userId: 'u-outro' }, manifestOf({ version: '1.1.0' }))
    expect(second.integration.created_by).toBe(first.integration.created_by)
    expect(second.integration.created_at).toBe(first.integration.created_at)
    expect(second.integration.manifest?.version).toBe('1.1.0')
  })
})
