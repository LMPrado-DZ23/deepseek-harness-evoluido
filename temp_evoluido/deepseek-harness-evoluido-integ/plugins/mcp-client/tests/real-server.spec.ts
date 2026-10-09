/**
 * Prova contra um servidor MCP DE VERDADE.
 *
 * Nada aqui fala com um objeto escrito neste repositório. Todo teste deste
 * arquivo sobe `@modelcontextprotocol/server-everything` como processo filho por
 * stdio, faz a apresentação real, lê o catálogo real e chama ferramenta real. É
 * o ponto do requisito X-11: um teste contra um dublê provaria que o dublê
 * responde, e foi exatamente por isso que este requisito estava marcado como
 * "é tudo fixture".
 */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMcpConnection, type McpConnection } from '../src/client.ts'
import { createMcpDispatcher } from '../src/dispatch.ts'
import { DEFAULT_MCP_LIMITS, type McpServerCommand } from '../src/model.ts'
import { McpError, killAllMcpChildren, liveMcpChildCount } from '../src/transport.ts'

/**
 * O caminho do servidor real. Resolvido, nunca escrito à mão: se o pacote sair
 * do repositório este teste FALHA em vez de passar contra outra coisa.
 */
const EVERYTHING = createRequire(import.meta.url).resolve('@modelcontextprotocol/server-everything/dist/index.js')

/**
 * Um segredo do processo PAI, plantado de propósito.
 *
 * O teste do ambiente pergunta ao servidor real o que ele enxerga. Sem um
 * segredo real no pai, "não vazou" seria uma frase sobre nada.
 */
const PARENT_SECRET_NAME = 'DZ23_MCP_SEGREDO_DO_PAI'
process.env[PARENT_SECRET_NAME] = 'valor-que-nao-pode-atravessar'

const scratch: string[] = []
const open: McpConnection[] = []

async function workingDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-mcp-'))
  scratch.push(root)
  return root
}

async function everything(env: Readonly<Record<string, string>> = {}): Promise<McpServerCommand> {
  return { command: process.execPath, args: [EVERYTHING, 'stdio'], cwd: await workingDirectory(), env }
}

async function connect(command: McpServerCommand, limits: Partial<typeof DEFAULT_MCP_LIMITS> = {}): Promise<McpConnection> {
  const connection = await openMcpConnection(command, { limits })
  open.push(connection)
  return connection
}

/** Espera o processo sumir de verdade da tabela do sistema operacional. */
async function died(pid: number, withinMs = 4000): Promise<boolean> {
  const deadline = Date.now() + withinMs
  for (;;) {
    try { process.kill(pid, 0) } catch { return true }
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

afterEach(async () => {
  for (const connection of open.splice(0)) await connection.close()
  // A rede de segurança tem de encontrar ZERO: se ela matou alguém, o teste
  // acima deixou processo para trás e a garantia "nada sobra" seria falsa.
  expect(killAllMcpChildren()).toBe(0)
  expect(liveMcpChildCount()).toBe(0)
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('conexão MCP real por stdio', () => {
  it('faz a apresentação real e negocia uma versão de protocolo conhecida', async () => {
    const connection = await connect(await everything())
    // O nome vem do servidor real, não de uma constante deste repositório.
    expect(connection.identity.serverName).toBe('mcp-servers/everything')
    expect(['2025-06-18', '2025-03-26', '2024-11-05']).toContain(connection.identity.protocolVersion)
    expect(connection.pid).toBeGreaterThan(0)
  })

  it('lista as ferramentas reais do servidor e chama uma delas de verdade', async () => {
    const connection = await connect(await everything())
    const names = connection.tools.map(tool => tool.name)
    expect(names).toContain('echo')
    expect(names).toContain('get-env')
    expect(names.length).toBeGreaterThan(3)
    const result = await connection.call('echo', { message: 'DZ23' })
    expect(result.isError).toBe(false)
    // A resposta é a que o servidor de verdade produz: "Echo: " + a mensagem.
    expect(result.content[0]?.text).toBe('Echo: DZ23')
  })

  it('o ambiente do processo filho tem só o que foi declarado: o segredo do pai não atravessa', async () => {
    // Confirmado no PAI primeiro: sem isto, o teste passaria num ambiente onde
    // o segredo nunca existiu e não teria provado nada.
    expect(process.env[PARENT_SECRET_NAME]).toBe('valor-que-nao-pode-atravessar')
    const connection = await connect(await everything({ DZ23_MCP_DECLARADO: 'unico-valor' }))
    // Quem responde é o servidor real, sobre o PRÓPRIO ambiente dele.
    const result = await connection.call('get-env', {})
    const environment = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, string>
    expect(environment).toEqual({ DZ23_MCP_DECLARADO: 'unico-valor' })
    expect(environment[PARENT_SECRET_NAME]).toBeUndefined()
    // Nem por acaso: nenhuma variável do pai chegou lá, nem `PATH`, nem `HOME`.
    expect(Object.keys(environment)).toEqual(['DZ23_MCP_DECLARADO'])
  })

  it('o tempo máximo de chamada MATA o processo em vez de abandoná-lo', async () => {
    const connection = await connect(await everything(), { callTimeoutMs: 300 })
    const pid = connection.pid
    expect(pid).toBeDefined()
    // Ferramenta real do servidor real: trinta segundos de trabalho contra um
    // teto de 300 ms. Nenhuma resposta vai chegar dentro do prazo.
    const failure = await connection.call('trigger-long-running-operation', { duration: 30, steps: 3 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('CALL_TIMEOUT')
    await connection.close()
    expect(await died(pid as number)).toBe(true)
  })

  it('a desistência de quem chamou mata o processo', async () => {
    const connection = await connect(await everything())
    const pid = connection.pid as number
    const abandon = new AbortController()
    const running = connection.call('trigger-long-running-operation', { duration: 30, steps: 3 }, abandon.signal)
    setTimeout(() => abandon.abort(), 50)
    const failure = await running.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('ABORTED')
    await connection.close()
    expect(await died(pid)).toBe(true)
  })

  it('o tempo máximo de apresentação mata o processo antes de qualquer chamada', async () => {
    // Um milissegundo: o servidor real existe, sobe e simplesmente não consegue
    // se apresentar tão rápido. Nada é simulado — o relógio é o de verdade.
    const failure = await openMcpConnection(await everything(), { limits: { handshakeTimeoutMs: 1 } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('HANDSHAKE_TIMEOUT')
  })

  it('o teto de bytes recusa a conexão em vez de ler o resto da mensagem', async () => {
    // A resposta real de `initialize` do `server-everything` passa de 4 KiB (ela
    // traz as instruções do servidor). Com 512 bytes de teto, o Studio para de
    // ler e derruba a conexão.
    const failure = await openMcpConnection(await everything(), { limits: { maxMessageBytes: 512 } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('MESSAGE_TOO_LARGE')
  })

  it('o teto de ferramentas RECUSA em vez de truncar o catálogo em silêncio', async () => {
    const failure = await openMcpConnection(await everything(), { limits: { maxTools: 2 } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('TOO_MANY_TOOLS')
  })

  it('uma ferramenta fora da lista anunciada não chega a sair daqui', async () => {
    const connection = await connect(await everything())
    const failure = await connection.call('ferramenta-que-o-servidor-nao-anunciou', {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('TOOL_NOT_OFFERED')
    // A conexão continua utilizável: recusar o pedido de quem chamou não é
    // motivo para derrubar um servidor que não fez nada de errado.
    expect((await connection.call('echo', { message: 'segue' })).content[0]?.text).toBe('Echo: segue')
  })

  it('fechar duas vezes é seguro e o processo continua morto', async () => {
    const connection = await openMcpConnection(await everything())
    const pid = connection.pid as number
    await connection.close()
    await connection.close()
    expect(await died(pid)).toBe(true)
    expect(liveMcpChildCount()).toBe(0)
  })

  it('um servidor que IGNORA o pedido de saída morre mesmo assim, no SIGKILL', async () => {
    // O único processo deste arquivo que não é um servidor MCP, e de propósito:
    // nenhum servidor MCP honesto se recusa a morrer, então a garantia "o
    // SIGKILL existe e funciona" não teria como ser provada com um deles. O que
    // se prova aqui é o encerramento — o resto do arquivo prova o protocolo.
    const teimoso = {
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      cwd: await workingDirectory(), env: {},
    }
    const failure = await openMcpConnection(teimoso, { limits: { handshakeTimeoutMs: 200, shutdownGraceMs: 150 } })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('HANDSHAKE_TIMEOUT')
    // `openMcpConnection` já encerrou no caminho de erro; o processo teimoso
    // sobreviveu ao SIGTERM e só pode ter saído pelo SIGKILL.
    expect(liveMcpChildCount()).toBe(0)
  })

  it('um executável que não existe falha fechado, sem deixar processo', async () => {
    const failure = await openMcpConnection({
      command: '/usr/bin/dz23-servidor-que-nao-existe', args: [], cwd: await workingDirectory(), env: {},
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect(['SPAWN_FAILED', 'CLOSED', 'HANDSHAKE_TIMEOUT']).toContain((failure as McpError).code)
  })
})

describe('X-04 teste de conexão contra um servidor MCP de verdade', () => {
  it('sonda: cumprimenta, lê o catálogo real, NÃO chama ferramenta e não deixa processo de pé', async () => {
    const command = await everything()
    const dispatcher = createMcpDispatcher({ catalog: { 'agenda-mcp': command }, limits: () => DEFAULT_MCP_LIMITS })
    const before = liveMcpChildCount()
    const outcome = await dispatcher.probe({
      integrationId: 'i-1',
      manifest: { schema_version: 1, id: 'agenda-mcp', name: 'Agenda', version: '1.0.0', kind: 'mcp', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T1' },
      signal: AbortSignal.timeout(20_000),
    })
    // O catálogo é o que o servidor REAL anunciou, e não uma lista esperada.
    expect(outcome.tools.length).toBeGreaterThan(0)
    expect(outcome.serverName).toBeTruthy()
    expect(outcome.protocolVersion).toBeTruthy()
    // A conexão foi fechada: uma sondagem que deixasse processo de pé seria pior
    // do que não sondar, porque ninguém aperta "testar" esperando um servidor vivo.
    expect(liveMcpChildCount()).toBe(before)
  })

  it('sondar um servidor que não está cadastrado falha fechado, sem subir nada', async () => {
    const dispatcher = createMcpDispatcher({ catalog: {}, limits: () => DEFAULT_MCP_LIMITS })
    const failure = await dispatcher.probe({
      integrationId: 'i-1',
      manifest: { schema_version: 1, id: 'nao-cadastrado', name: 'X', version: '1.0.0', kind: 'mcp', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T1' },
      signal: AbortSignal.timeout(5_000),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect(liveMcpChildCount()).toBe(0)
  })
})
