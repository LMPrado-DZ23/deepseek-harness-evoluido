/**
 * O cadastro de servidores e a derivação dos tetos.
 *
 * São as duas decisões que acontecem ANTES de qualquer processo existir, e por
 * isso são as duas que um servidor real não poderia provar.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_INTEGRATION_CALL_POLICY } from '../../integration-hub/src/runtime.ts'
import { McpCatalogError, mcpLimitsFromCallPolicy, parseServerCatalog } from '../src/dispatch.ts'
import { DEFAULT_MCP_LIMITS } from '../src/model.ts'

describe('cadastro de servidores MCP', () => {
  it('aceita um cadastro completo e devolve um catálogo sem protótipo herdado', () => {
    const catalog = parseServerCatalog({
      agenda: { command: '/usr/bin/node', args: ['/opt/agenda/servidor.js'], cwd: '/var/lib/agenda', env: { PATH: '/usr/bin' } },
    })
    expect(catalog.agenda).toEqual({ command: '/usr/bin/node', args: ['/opt/agenda/servidor.js'], cwd: '/var/lib/agenda', env: { PATH: '/usr/bin' } })
    expect(Object.getPrototypeOf(catalog)).toBeNull()
  })

  it('sem argumentos declarados, a lista é vazia — nunca "o que o sistema achar"', () => {
    const catalog = parseServerCatalog({ agenda: { command: '/usr/bin/node', cwd: '/tmp', env: {} } })
    expect(catalog.agenda?.args).toEqual([])
  })

  it('recusa um comando relativo: o Studio não procura executável no caminho de busca', () => {
    const failure = (() => { try { parseServerCatalog({ agenda: { command: 'node', cwd: '/tmp', env: {} } }); return undefined } catch (error) { return error } })()
    expect(failure).toBeInstanceOf(McpCatalogError)
    expect((failure as McpCatalogError).message).toContain('agenda: command')
  })

  it('recusa uma pasta de trabalho relativa: "onde o Studio por acaso estava" não é um limite', () => {
    expect(() => parseServerCatalog({ agenda: { command: '/usr/bin/node', cwd: 'dados', env: {} } })).toThrow(McpCatalogError)
  })

  it('recusa um ambiente com nome de variável inválido, já no cadastro', () => {
    expect(() => parseServerCatalog({ agenda: { command: '/usr/bin/node', cwd: '/tmp', env: { 'nao-vale': 'x' } } })).toThrow(McpCatalogError)
  })

  it('recusa campo desconhecido: um cadastro com "network: false" prometeria um isolamento que não existe', () => {
    expect(() => parseServerCatalog({
      agenda: { command: '/usr/bin/node', cwd: '/tmp', env: {}, network: false },
    })).toThrow(McpCatalogError)
  })
})

describe('tetos derivados da política do Hub', () => {
  it('o tempo vem do Hub, e a apresentação recebe metade do orçamento', () => {
    const limits = mcpLimitsFromCallPolicy({ ...DEFAULT_INTEGRATION_CALL_POLICY, timeoutMs: 8_000 })
    expect(limits.callTimeoutMs).toBe(8_000)
    expect(limits.handshakeTimeoutMs).toBe(4_000)
    // O que não é tempo continua sendo o padrão da casa.
    expect(limits.maxMessageBytes).toBe(DEFAULT_MCP_LIMITS.maxMessageBytes)
    expect(limits.maxTools).toBe(DEFAULT_MCP_LIMITS.maxTools)
  })

  it('um teto minúsculo do Hub não vira zero: a apresentação fica com pelo menos um milissegundo', () => {
    expect(mcpLimitsFromCallPolicy({ ...DEFAULT_INTEGRATION_CALL_POLICY, timeoutMs: 1 }).handshakeTimeoutMs).toBe(1)
  })

  it('o perfil ajusta tamanho e número de ferramentas, e não o tempo', () => {
    const limits = mcpLimitsFromCallPolicy(DEFAULT_INTEGRATION_CALL_POLICY, { maxTools: 4, maxMessageBytes: 1024 })
    expect(limits.maxTools).toBe(4)
    expect(limits.maxMessageBytes).toBe(1024)
    expect(limits.callTimeoutMs).toBe(DEFAULT_INTEGRATION_CALL_POLICY.timeoutMs)
  })
})
