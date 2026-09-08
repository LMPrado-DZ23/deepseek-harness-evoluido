/**
 * O ambiente do processo filho é construído, nunca herdado.
 *
 * O teste contra o servidor real (`real-server.spec.ts`) prova o efeito: o
 * `get-env` de um servidor MCP de verdade só enxerga o que foi declarado. Este
 * arquivo prova a REGRA, incluindo os casos que um servidor real não teria como
 * mostrar.
 */
import { describe, expect, it } from 'vitest'
import { McpEnvironmentError, childEnvironment } from '../src/environment.ts'

describe('ambiente do processo filho', () => {
  it('devolve exatamente o que foi declarado, e nada do processo do Studio', () => {
    process.env.DZ23_MCP_NAO_DEVE_ENTRAR = 'segredo'
    const environment = childEnvironment({ DZ23_MCP_DECLARADO: 'valor' })
    expect({ ...environment }).toEqual({ DZ23_MCP_DECLARADO: 'valor' })
    expect(Object.keys(environment)).not.toContain('DZ23_MCP_NAO_DEVE_ENTRAR')
    // Nem as variáveis "inofensivas": herdar `PATH` já entrega a topologia da
    // máquina, e a próxima variável ao lado dela costuma ser uma credencial.
    expect(Object.keys(environment)).not.toContain('PATH')
    expect(Object.keys(environment)).not.toContain('HOME')
  })

  it('um ambiente vazio é um ambiente vazio, e não "o do pai"', () => {
    expect(Object.keys(childEnvironment({}))).toEqual([])
  })

  it('o objeto não tem protótipo: um cadastro com __proto__ não planta nada no Object', () => {
    expect(Object.getPrototypeOf(childEnvironment({}))).toBeNull()
    // `JSON.parse` cria `__proto__` como chave PRÓPRIA, com um objeto de valor:
    // o nome até seria aceito, mas o valor não é texto e a recusa vem daí.
    const hostile = JSON.parse('{"__proto__": {"poluido": "sim"}}') as Record<string, string>
    expect(() => childEnvironment(hostile)).toThrow(McpEnvironmentError)
    expect(({} as Record<string, unknown>).poluido).toBeUndefined()
  })

  it('recusa um nome de variável que o sistema operacional não aceitaria', () => {
    const failure = (() => { try { childEnvironment({ 'NAO=VALE': 'x' }); return undefined } catch (error) { return error } })()
    expect(failure).toBeInstanceOf(McpEnvironmentError)
    expect((failure as McpEnvironmentError).code).toBe('NAME_INVALID')
  })

  it('recusa um valor com byte zero: ele cortaria a string no limite do processo', () => {
    const failure = (() => { try { childEnvironment({ VALIDO: 'antes' + String.fromCharCode(0) + 'depois' }); return undefined } catch (error) { return error } })()
    expect(failure).toBeInstanceOf(McpEnvironmentError)
    expect((failure as McpEnvironmentError).code).toBe('VALUE_INVALID')
  })
})
