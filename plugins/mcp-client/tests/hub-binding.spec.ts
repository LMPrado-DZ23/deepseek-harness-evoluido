/**
 * O caminho inteiro, do Hub até um servidor MCP DE VERDADE.
 *
 * Aqui não há despachante de mentira: o `IntegrationHubService` real recebe o
 * despachante real deste plugin, que sobe o `server-everything` real como
 * processo filho. O que se prova é a costura — assinatura, teto, desfecho,
 * contadores e auditoria do Hub em volta de uma chamada MCP que realmente
 * aconteceu.
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../../integration-hub/src/manifest.ts'
import type { HubEvent, IntegrationKillSwitch, IntegrationManifest, StudioExport, StudioIntegration } from '../../integration-hub/src/model.ts'
import {
  HubError, IntegrationHubService, securityFingerprint,
  type HubActor, type HubRepository,
} from '../../integration-hub/src/service.ts'
import { createMcpDispatcher, mcpLimitsFromCallPolicy, parseServerCatalog } from '../src/dispatch.ts'
import { killAllMcpChildren, liveMcpChildCount } from '../src/transport.ts'

const EVERYTHING = createRequire(import.meta.url).resolve('@modelcontextprotocol/server-everything/dist/index.js')

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; eventRows: HubEvent[] = []
  integrations = (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  deleteIntegration = async (scope: HubActor, integrationId: string) => { this.rows = this.rows.filter(row => !(row.integration_id === integrationId && row.org_id === scope.orgId && row.tenant_id === scope.tenantId)) }
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
const MANIFEST_ID = 'agenda-mcp'

const scratch: string[] = []
afterEach(async () => {
  // O Hub ABANDONA a espera quando estoura o tempo: ele não fica preso ao
  // processo que desistiu. A morte do filho é, portanto, concorrente — e por
  // isso se espera por ela em vez de conferir no mesmo instante. O que se prova
  // continua sendo o mesmo: dentro de um prazo curto não sobra nenhum processo,
  // e a rede de segurança não tem ninguém para matar.
  expect(await settled()).toBe(0)
  expect(killAllMcpChildren()).toBe(0)
  expect(liveMcpChildCount()).toBe(0)
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** Espera todo servidor MCP deste processo morrer, com prazo. Devolve quantos ainda restam. */
async function settled(withinMs = 5000): Promise<number> {
  const deadline = Date.now() + withinMs
  while (liveMcpChildCount() > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return liveMcpChildCount()
}

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-mcp-hub-'))
  scratch.push(root)
  return root
}

/** Um manifesto MCP assinado com a chave do publicador conhecido deste Studio. */
function signedManifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  const value = {
    schema_version: 1, id: MANIFEST_ID, name: 'Agenda MCP', version: '1.0.0', kind: 'mcp',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T1', ...overrides,
  } as IntegrationManifest
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

async function build(options: { readonly timeoutMs?: number; readonly registerServer?: boolean } = {}) {
  const root = await scratchRoot()
  const repository = new MemoryRepository()
  let sequence = 0
  const service = new IntegrationHubService({
    repository, exportsRoot: root, runsRoot: root, publisherKeys, channel: 'stable',
    secrets: { inspect: async () => ({ present: false, shapeOk: false }) },
    projects: { project: () => { throw new Error('sem projeto') }, runs: () => [] },
    ...(options.timeoutMs === undefined ? {} : { callPolicy: { timeoutMs: options.timeoutMs } }),
    createId: () => `id-${++sequence}`,
  })
  const catalog = parseServerCatalog(options.registerServer === false ? {} : {
    [MANIFEST_ID]: { command: process.execPath, args: [EVERYTHING, 'stdio'], cwd: root, env: {} },
  })
  service.useMcpDispatcher(createMcpDispatcher({
    catalog,
    limits: () => mcpLimitsFromCallPolicy(service.callPolicy),
  }))
  return { service, repository }
}

/** Uma integração MCP registrada e LIGADA, que é a única condição em que ela pode ser chamada. */
async function enabled(service: IntegrationHubService, overrides: Partial<IntegrationManifest> = {}): Promise<string> {
  const registered = await service.register(admin, signedManifest(overrides))
  expect(registered.integration.verification).toBe('verified')
  await service.setEnabled(admin, registered.integration.integration_id, true)
  return registered.integration.integration_id
}

describe('Hub chamando um servidor MCP real', () => {
  it('uma integração MCP assinada e ligada chama a ferramenta real e o Hub conta a chamada', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    expect(service.mcpAvailable).toBe(true)
    // Nunca chamada ainda: NOT_EXECUTED, não "OK".
    expect(service.health(admin, id).state).toBe('NOT_EXECUTED')

    const result = await service.callMcpTool(admin, id, { tool: 'echo', arguments: { message: 'DZ23' }, idempotent: true })
    expect(result.state).toBe('OK')
    if (result.state !== 'OK') throw new Error('desfecho inesperado')
    // A resposta é a do servidor real, e a identidade também.
    expect(result.value.serverName).toBe('mcp-servers/everything')
    expect(result.value.content[0]?.text).toBe('Echo: DZ23')
    expect(result.value.tools).toContain('echo')
    expect(result.attempts).toBe(1)
    expect(result.retried).toBe(false)

    // Os contadores e a auditoria são os do Hub — este plugin não guarda nada.
    const health = service.health(admin, id)
    expect(health.state).toBe('OK')
    expect(health.calls).toBe(1)
    // Sem preço informado, o custo é DESCONHECIDO e não zero.
    expect(health.cost_state).toBe('UNKNOWN')
    expect(repository.eventRows.filter(row => row.action === 'integration.called')).toMatchObject([
      { outcome: 'success', subject_id: id, detail: 'mcp.echo OK attempts=1 cost=UNKNOWN' },
    ])
  })

  it('o tempo máximo do HUB mata o processo do servidor: um teto só, e é o do Hub', async () => {
    const { service, repository } = await build({ timeoutMs: 700 })
    const id = await enabled(service)
    // Ferramenta real, trinta segundos de trabalho, teto de 700 ms no Hub.
    // `idempotent: false` para que a repetição única não entre na conta e o
    // desfecho seja exatamente um estouro.
    const result = await service.callMcpTool(admin, id, {
      tool: 'trigger-long-running-operation', arguments: { duration: 30, steps: 3 }, idempotent: false,
    })
    expect(result.state).toBe('TIMEOUT')
    expect(result.attempts).toBe(1)
    expect(service.health(admin, id).timeouts).toBe(1)
    expect(repository.eventRows.filter(row => row.action === 'integration.called')).toMatchObject([
      { outcome: 'failure', detail: 'mcp.trigger-long-running-operation TIMEOUT attempts=1 cost=UNKNOWN' },
    ])
    // O `afterEach` prova o resto: nenhum processo sobrou depois do estouro.
  })

  it('um manifesto sem servidor cadastrado é recusado, e o Hub registra a falha', async () => {
    const { service, repository } = await build({ registerServer: false })
    const id = await enabled(service)
    const result = await service.callMcpTool(admin, id, { tool: 'echo', arguments: {}, idempotent: false })
    expect(result.state).toBe('FAILED')
    // Só a CLASSE do erro entra no registro; a mensagem do servidor nunca.
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'failure' })
    expect(service.health(admin, id).last_failure).toBe('McpError')
  })

  it('um manifesto ALTERADO depois de assinado não conecta: a assinatura é reconferida na chamada', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    // Outro escritor da tabela mexe no manifesto gravado. `verification`
    // continua dizendo `verified` — foi decidido no cadastro e envelheceu.
    const stored = repository.rows.find(row => row.integration_id === id)
    expect(stored?.verification).toBe('verified')
    await repository.putIntegration({ ...(stored as StudioIntegration), manifest: { ...(stored as StudioIntegration).manifest as IntegrationManifest, name: 'Agenda MCP (adulterada)' } })

    const failure = await service.callMcpTool(admin, id, { tool: 'echo', arguments: {}, idempotent: false }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HubError)
    expect((failure as HubError).code).toBe('FORBIDDEN')
    // `not-executed` é o desfecho honesto: nenhum processo subiu.
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'integration.called', outcome: 'not-executed', detail: 'mcp.echo unsigned' })
    expect(service.health(admin, id).calls).toBe(0)
    expect(liveMcpChildCount()).toBe(0)
  })
})
