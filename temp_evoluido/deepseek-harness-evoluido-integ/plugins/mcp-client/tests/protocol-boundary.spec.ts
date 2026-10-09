/**
 * O que o CLIENTE escreve, e o que ele faz com uma resposta que nenhum servidor
 * instalado aqui produz.
 *
 * O outro lado deste arquivo NÃO é um servidor MCP: é uma sonda de doze linhas
 * que registra o que recebeu e responde o que mandarmos responder. Isso é
 * deliberado e é o oposto do dublê que este requisito proibia — as garantias do
 * PROTOCOLO (apresentação, catálogo, chamada) estão provadas contra o servidor
 * real em `real-server.spec.ts`. O que se prova aqui é o que um servidor real
 * não tem como testemunhar:
 *
 * - que o cliente conclui a apresentação com `notifications/initialized`, coisa
 *   que só quem RECEBE pode contar (o `server-everything` instalado tolera a
 *   ausência, então ele nunca acusaria a falta);
 * - que uma versão de protocolo desconhecida encerra a conexão, coisa que
 *   nenhum servidor honesto vai responder.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMcpConnection } from '../src/client.ts'
import type { McpServerCommand } from '../src/model.ts'
import { McpError, killAllMcpChildren, liveMcpChildCount } from '../src/transport.ts'

/** A sonda: lê linhas JSON-RPC, anota se a apresentação foi concluída e responde a versão que lhe mandarem. */
const PROBE = [
  "let seen = false, buffer = '';",
  "const write = value => process.stdout.write(JSON.stringify(value) + '\\n');",
  "process.stdin.on('data', chunk => { buffer += chunk; for (;;) {",
  "  const cut = buffer.indexOf('\\n'); if (cut < 0) break;",
  "  const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); if (!line.trim()) continue;",
  '  const message = JSON.parse(line);',
  "  if (message.method === 'initialize') write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: process.env.DZ23_PROBE_VERSION, capabilities: {}, serverInfo: { name: 'sonda', version: '1' } } });",
  "  else if (message.method === 'notifications/initialized') seen = true;",
  "  else if (message.method === 'tools/list') write({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: seen ? 'apresentacao-concluida' : 'apresentacao-incompleta' }] } });",
  '} });',
].join('\n')

const scratch: string[] = []
afterEach(async () => {
  expect(killAllMcpChildren()).toBe(0)
  expect(liveMcpChildCount()).toBe(0)
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function probe(version: string): Promise<McpServerCommand> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-mcp-sonda-'))
  scratch.push(root)
  return { command: process.execPath, args: ['-e', PROBE], cwd: root, env: { DZ23_PROBE_VERSION: version } }
}

describe('fronteira do protocolo', () => {
  it('o cliente conclui a apresentação com notifications/initialized', async () => {
    // Quem responde é o outro lado, e ele só sabe dizer isso porque recebeu o
    // aviso. Sem o aviso, servidores mais estritos recusam tudo o que vem depois.
    const connection = await openMcpConnection(await probe('2025-06-18'))
    expect(connection.tools.map(tool => tool.name)).toEqual(['apresentacao-concluida'])
    await connection.close()
  })

  it('uma versão de protocolo desconhecida encerra a conexão em vez de seguir adivinhando', async () => {
    const failure = await openMcpConnection(await probe('1999-01-01')).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpError)
    expect((failure as McpError).code).toBe('VERSION_UNSUPPORTED')
  })

  it('uma versão mais antiga que este Studio conhece é aceita: quem escolhe é o servidor', async () => {
    const connection = await openMcpConnection(await probe('2024-11-05'))
    expect(connection.identity.protocolVersion).toBe('2024-11-05')
    await connection.close()
  })
})
