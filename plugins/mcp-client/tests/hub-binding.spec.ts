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
import { desfechoParaOAgente, ferramentasDeConector, MAXIMO_DO_RESULTADO } from '../src/agent-tools.ts'

const EVERYTHING = createRequire(import.meta.url).resolve('@modelcontextprotocol/server-everything/dist/index.js')

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; eventRows: HubEvent[] = []
  integrations = async (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = async (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  deleteIntegration = async (scope: HubActor, integrationId: string) => { this.rows = this.rows.filter(row => !(row.integration_id === integrationId && row.org_id === scope.orgId && row.tenant_id === scope.tenantId)) }
  putIntegration = async (value: StudioIntegration) => {
    this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value]
  }
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

async function build(options: { readonly timeoutMs?: number; readonly registerServer?: boolean; readonly semDespachante?: boolean } = {}) {
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
  if (options.semDespachante !== true) {
    service.useMcpDispatcher(createMcpDispatcher({
      catalog,
      limits: () => mcpLimitsFromCallPolicy(service.callPolicy),
    }))
  }
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
    expect((await service.health(admin, id)).state).toBe('NOT_EXECUTED')

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
    const health = await service.health(admin, id)
    expect(health.state).toBe('OK')
    expect(health.calls).toBe(1)
    // Sem preço informado, o custo é DESCONHECIDO e não zero.
    expect(health.cost_state).toBe('UNKNOWN')
    expect(repository.eventRows.filter(row => row.action === 'integration.called')).toMatchObject([
      { outcome: 'success', subject_id: id, detail: 'mcp.echo OK attempts=1 cost=UNKNOWN' },
    ])
  })

  it('o tempo máximo do HUB mata o processo do servidor: um teto só, e é o do Hub', async () => {
    const { service, repository } = await build({ timeoutMs: 3_000 })
    const id = await enabled(service)
    // O teto era 700 ms e reprovava POR CARGA, não por defeito: esta é a
    // PRIMEIRA chamada ao servidor, então o `spawn` do processo e o aperto de
    // mão do MCP moram dentro do orçamento. Com a máquina cheia (a suíte
    // inteira em paralelo) o servidor não ficava de pé a tempo e o desfecho
    // virava FAILED - "o servidor demorou a subir" lido como "a ferramenta
    // demorou a responder". Três segundos continuam DEZ VEZES menores do que
    // os trinta segundos de trabalho da ferramenta, então o que o teste afirma
    // - o teto que mata é o do Hub - continua sendo exatamente o que ele mede.
    // Ferramenta real, trinta segundos de trabalho, teto do Hub bem abaixo.
    // `idempotent: false` para que a repetição única não entre na conta e o
    // desfecho seja exatamente um estouro.
    const result = await service.callMcpTool(admin, id, {
      tool: 'trigger-long-running-operation', arguments: { duration: 30, steps: 3 }, idempotent: false,
    })
    expect(result.state).toBe('TIMEOUT')
    expect(result.attempts).toBe(1)
    expect((await service.health(admin, id)).timeouts).toBe(1)
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
    expect((await service.health(admin, id)).last_failure).toBe('McpError')
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
    expect((await service.health(admin, id)).calls).toBe(0)
    expect(liveMcpChildCount()).toBe(0)
  })
})

describe('os conectores na conversa do agente, contra o servidor real', () => {
  const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal }) as never
  const porNome = (tools: ReturnType<typeof ferramentasDeConector>, nome: string) => tools.find(tool => tool.name === nome)!

  it('listar mostra só os MCP ligados; perguntar traz as ferramentas; chamar executa e o Hub conta', async () => {
    const { service, repository } = await build()
    const id = await enabled(service)
    const desligado = (await service.register(admin, signedManifest({ id: 'outro-mcp', name: 'Outro' }))).integration.integration_id
    const tools = ferramentasDeConector(service, agent => agent === 'agente-do-admin' ? admin : undefined)
    expect(tools.map(tool => tool.name)).toEqual(['studio_connector_list', 'studio_connector_tools', 'studio_connector_call'])

    const lista = JSON.parse((await porNome(tools, 'studio_connector_list').execute({}, exec('agente-do-admin')) as { json: string }).json)
    expect(lista).toEqual({ conectores: [{ integration_id: id, name: 'Agenda MCP' }] })
    expect(JSON.stringify(lista)).not.toContain(desligado)

    const ferramentas = JSON.parse((await porNome(tools, 'studio_connector_tools').execute({ integration_id: id }, exec('agente-do-admin')) as { json: string }).json)
    expect(ferramentas.ok).toBe(true)
    expect(ferramentas.ferramentas).toContain('echo')

    const chamada = JSON.parse((await porNome(tools, 'studio_connector_call').execute({ integration_id: id, tool: 'echo', arguments: { message: 'FRIGG' } }, exec('agente-do-admin')) as { json: string }).json)
    expect(chamada).toMatchObject({ ok: true, erro_da_ferramenta: false, conteudo: 'Echo: FRIGG' })
    // O Hub auditou as duas operações que subiram o servidor, e só elas.
    expect(repository.eventRows.filter(row => row.action === 'integration.called').map(row => row.detail)).toEqual([
      'tools-list OK attempts=1 cost=UNKNOWN', 'mcp.echo OK attempts=1 cost=UNKNOWN',
    ])
  })

  it('sem dono conhecido, nada sobe; sem conector ligado, o aviso diz por quê', async () => {
    const { service } = await build()
    const tools = ferramentasDeConector(service, () => undefined)
    await expect(porNome(tools, 'studio_connector_list').execute({}, exec('estranho'))).rejects.toThrow('não tem um dono conhecido')
    await expect(porNome(tools, 'studio_connector_call').execute({ integration_id: 'x', tool: 'echo' }, exec('estranho'))).rejects.toThrow('não tem um dono conhecido')
    const comDono = ferramentasDeConector(service, () => admin)
    const vazia = JSON.parse((await porNome(comDono, 'studio_connector_list').execute({}, exec('a')) as { json: string }).json)
    expect(vazia.conectores).toEqual([])
    expect(vazia.aviso).toMatch(/manifesto assinado/u)
  })

  it('desfecho que não deu certo vai com o estado e o motivo; texto grande é cortado', () => {
    expect(JSON.parse(desfechoParaOAgente({ state: 'TIMEOUT', message: 'demorou', attempts: 1, retried: false, latencyMs: 1, cost: {} as never }, () => ({})))).toEqual({ ok: false, estado: 'TIMEOUT', motivo: 'demorou' })
    const grande = desfechoParaOAgente({ state: 'OK', value: 'x'.repeat(MAXIMO_DO_RESULTADO * 2), attempts: 1, retried: false, latencyMs: 1, cost: {} as never }, valor => ({ valor }))
    expect(grande.length).toBe(MAXIMO_DO_RESULTADO)
    expect(grande.endsWith('\u2026')).toBe(true)
  })
})

describe('os limites da porta do agente', () => {
  const exec = { agent: 'a', signal: new AbortController().signal } as never

  it('a chamada do agente NUNCA se declara repetível: o Hub só repete o que foi declarado assim', async () => {
    const pedidos: unknown[] = []
    const hub = {
      list: async () => [], mcpTools: async () => { throw new Error('não usado') },
      callMcpTool: async (_actor: unknown, _id: string, pedido: unknown) => { pedidos.push(pedido); return { state: 'FAILED' as const, message: 'x', attempts: 1, retried: false, latencyMs: 1, cost: {} as never } },
    }
    const call = ferramentasDeConector(hub as never, () => admin).find(tool => tool.name === 'studio_connector_call')!
    await call.execute({ integration_id: 'i', tool: 'enviar' }, exec)
    expect(pedidos).toEqual([{ tool: 'enviar', arguments: {}, idempotent: false }])
  })

  it('perguntar as ferramentas passa pelas mesmas recusas da chamada, antes de subir qualquer processo', async () => {
    const { service, repository } = await build({ semDespachante: true })
    const id = await enabled(service)
    await expect(service.mcpTools(admin, id)).rejects.toMatchObject({ code: 'NOT_EXECUTED' })
    expect(repository.eventRows.filter(row => row.action === 'integration.called').map(row => row.detail)).toEqual(['tools-list no-dispatcher'])
    const leitor: HubActor = { ...admin, role: 'viewer' }
    await expect(service.mcpTools(leitor, id)).rejects.toMatchObject({ code: 'NOT_EXECUTED' })
  })
})
