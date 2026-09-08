/**
 * As RECUSAS do caminho MCP, e o que elas garantem: nada foi executado.
 *
 * A prova contra um servidor MCP de verdade mora em `plugins/mcp-client`. Aqui
 * o despachante é um espião — de propósito, e é a única forma de provar que ele
 * NÃO foi chamado. Um servidor real não consegue testemunhar sobre uma conexão
 * que nunca existiu.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import {
  HubError, IntegrationHubService, securityFingerprint,
  type HubActor, type HubRepository, type McpCallOutcome, type McpDispatchInput, type McpDispatchPort,
} from '../src/service.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; eventRows: HubEvent[] = []
  integrations = (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  putIntegration = async (value: StudioIntegration) => {
    this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value]
  }
  compareAndSwapIntegration = async (scope: HubActor, integrationId: string, expected: string, value: StudioIntegration) => {
    const current = this.integration(scope, integrationId)
    if (current === undefined || securityFingerprint(current) !== expected) return false
    await this.putIntegration(value); return true
  }
  exports = (): readonly StudioExport[] => []
  export = () => undefined
  putExport = async () => undefined
  eventPage = () => []
  eventCount = () => this.eventRows.length
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
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

function manifestOf(overrides: Partial<IntegrationManifest> = {}, options: { readonly sign?: boolean } = {}): IntegrationManifest {
  const value = {
    schema_version: 1, id: 'agenda-mcp', name: 'Agenda MCP', version: '1.0.0', kind: 'mcp',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T1', ...overrides,
  } as IntegrationManifest
  if (options.sign === false) return value
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

/** Um despachante que só ANOTA. É o que permite provar que uma recusa recusou antes de qualquer coisa sair. */
function spy(): McpDispatchPort & { readonly calls: McpDispatchInput[] } {
  const calls: McpDispatchInput[] = []
  return {
    calls,
    async call(input: McpDispatchInput): Promise<McpCallOutcome> {
      calls.push(input)
      return { protocolVersion: '2025-06-18', serverName: 'espiao', tools: ['echo'], content: [{ type: 'text', text: 'ok' }], isError: false }
    },
  }
}

async function build() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-hub-mcp-'))
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

async function enabled(service: IntegrationHubService, overrides: Partial<IntegrationManifest> = {}): Promise<string> {
  const registered = await service.register(admin, manifestOf(overrides))
  await service.setEnabled(admin, registered.integration.integration_id, true)
  return registered.integration.integration_id
}

describe('despachante MCP do Hub', () => {
  it('sem cliente MCP montado no perfil, nada é executado e a recusa fica registrada', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    expect(service.mcpAvailable).toBe(false)
    const failure = await service.callMcpTool(admin, id, { tool: 'echo', idempotent: false }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect((failure as HubError).code).toBe('NOT_EXECUTED')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'not-executed', detail: 'mcp.echo no-dispatcher' })
    // A recusa não gasta contador de chamada: nada foi tentado.
    expect(service.health(admin, id).calls).toBe(0)
  })

  it('um manifesto SEM assinatura não conecta, mesmo com o registro gravado como ligado', async () => {
    const { service, repository } = await build()
    const dispatcher = spy()
    service.useMcpDispatcher(dispatcher)
    // Escrito direto na tabela: é assim que uma linha antiga, ou a de outro
    // escritor, chegaria aqui. O caminho normal (`setEnabled`) já recusaria.
    const record: StudioIntegration = {
      integration_id: 'i-sem-assinatura', org_id: admin.orgId, tenant_id: admin.tenantId,
      kind: 'mcp', name: 'Agenda MCP', manifest: manifestOf({}, { sign: false }),
      effective_tier: 'T1', verification: 'verified', enabled: true, secret_ref: null,
      created_by: admin.userId, created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    }
    await repository.putIntegration(record)
    const failure = await service.callMcpTool(admin, 'i-sem-assinatura', { tool: 'echo', idempotent: false }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect((failure as HubError).code).toBe('FORBIDDEN')
    // A prova de que nada saiu: o despachante nunca foi chamado.
    expect(dispatcher.calls).toEqual([])
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'not-executed', detail: 'mcp.echo unsigned' })
  })

  it('um publicador sem chave neste Studio não conecta, ainda que o manifesto esteja assinado', async () => {
    const { service, repository } = await build()
    const dispatcher = spy()
    service.useMcpDispatcher(dispatcher)
    const record: StudioIntegration = {
      integration_id: 'i-outro-publicador', org_id: admin.orgId, tenant_id: admin.tenantId,
      kind: 'mcp', name: 'Agenda MCP', manifest: manifestOf({ publisher: { id: 'desconhecido', name: 'Outro' } }),
      effective_tier: 'T1', verification: 'verified', enabled: true, secret_ref: null,
      created_by: admin.userId, created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    }
    await repository.putIntegration(record)
    const failure = await service.callMcpTool(admin, 'i-outro-publicador', { tool: 'echo', idempotent: false }).catch((error: unknown) => error)
    expect((failure as HubError).code).toBe('FORBIDDEN')
    expect(dispatcher.calls).toEqual([])
    expect(repository.eventRows.at(-1)).toMatchObject({ outcome: 'not-executed', detail: 'mcp.echo unsigned' })
  })

  it('uma integração que não é do tipo MCP não entra por esta porta', async () => {
    const { service, repository } = await build()
    const dispatcher = spy()
    service.useMcpDispatcher(dispatcher)
    const registered = await service.register(admin, manifestOf({ id: 'agenda', kind: 'skill', tier: 'T0' }))
    await service.setEnabled(admin, registered.integration.integration_id, true)
    const failure = await service.callMcpTool(admin, registered.integration.integration_id, { tool: 'echo', idempotent: false }).catch((error: unknown) => error)
    expect((failure as HubError).code).toBe('INVALID')
    expect(dispatcher.calls).toEqual([])
    expect(repository.eventRows.at(-1)).toMatchObject({ outcome: 'not-executed', detail: 'mcp.echo not-mcp' })
  })

  it('uma integração DESLIGADA continua sendo barrada pela regra que já existia, sem recusa nova', async () => {
    const { service, repository } = await build()
    const dispatcher = spy()
    service.useMcpDispatcher(dispatcher)
    const registered = await service.register(admin, manifestOf())
    const failure = await service.callMcpTool(admin, registered.integration.integration_id, { tool: 'echo', idempotent: false }).catch((error: unknown) => error)
    expect((failure as HubError).code).toBe('FORBIDDEN')
    expect(dispatcher.calls).toEqual([])
    // `disabled` é a recusa de `callIntegration`, e não uma cópia dela feita aqui.
    expect(repository.eventRows.at(-1)).toMatchObject({ outcome: 'not-executed', detail: 'mcp.echo disabled' })
  })

  it('o manifesto que chega ao despachante é o VERIFICADO, e o desfecho passa pelos contadores do Hub', async () => {
    const { service, repository } = await build()
    const dispatcher = spy()
    service.useMcpDispatcher(dispatcher)
    const id = await enabled(service)
    const result = await service.callMcpTool(admin, id, { tool: 'echo', arguments: { message: 'oi' }, idempotent: true, priceUsd: 0.25 })
    expect(result.state).toBe('OK')
    expect(dispatcher.calls).toHaveLength(1)
    expect(dispatcher.calls[0]?.manifest.id).toBe('agenda-mcp')
    expect(dispatcher.calls[0]?.tool).toBe('echo')
    expect(dispatcher.calls[0]?.arguments).toEqual({ message: 'oi' })
    // O sinal de desistência do Hub chega inteiro ao despachante.
    expect(dispatcher.calls[0]?.signal.aborted).toBe(false)
    const health = service.health(admin, id)
    expect(health.calls).toBe(1)
    // Com preço informado o custo é MEDIDO — a política é a do Hub, não deste caminho.
    expect(health.cost_state).toBe('MEASURED')
    expect(health.cost_usd).toBe(0.25)
    expect(repository.eventRows.at(-1)).toMatchObject({ outcome: 'success', detail: 'mcp.echo OK attempts=1 cost=MEASURED' })
  })

  it('a repetição única é a do Hub: uma operação idempotente que falha tenta exatamente duas vezes', async () => {
    const { service } = await build()
    let attempts = 0
    service.useMcpDispatcher({
      async call(): Promise<McpCallOutcome> { attempts += 1; throw new Error('servidor caiu') },
    })
    const id = await enabled(service)
    const result = await service.callMcpTool(admin, id, { tool: 'echo', idempotent: true })
    expect(result.state).toBe('FAILED')
    expect(result.attempts).toBe(2)
    expect(result.retried).toBe(true)
    expect(attempts).toBe(2)
  })

  it('dois clientes MCP montados é erro, e o primeiro continua valendo', async () => {
    const { service } = await build()
    const first = spy()
    const uninstall = service.useMcpDispatcher(first)
    expect(() => service.useMcpDispatcher(spy())).toThrow(HubError)
    const id = await enabled(service)
    await service.callMcpTool(admin, id, { tool: 'echo', idempotent: false })
    expect(first.calls).toHaveLength(1)
    // Desmontado o plugin, o Studio volta a recusar em vez de chamar um fantasma.
    uninstall()
    expect(service.mcpAvailable).toBe(false)
  })
})
