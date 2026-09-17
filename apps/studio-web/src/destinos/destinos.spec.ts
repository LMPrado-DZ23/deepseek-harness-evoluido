import { describe, expect, it } from 'vitest'
import {
  AGENDADO_PATH, BIBLIOTECA_PATH, CAMINHOS, DISPONIBILIDADE, ESCOPO, HABILIDADES_PATH,
  PLUGINS_PATH, TODOS_OS_TIPOS, destinoDoCaminho, pertenceAoDestino, type Destino,
} from './destinos'

describe('os seis destinos existem e são distintos', () => {
  it('Habilidades, Plugins, Biblioteca e Agendado têm endereços diferentes', () => {
    const caminhos = [HABILIDADES_PATH, PLUGINS_PATH, BIBLIOTECA_PATH, AGENDADO_PATH]
    expect(new Set(caminhos).size).toBe(caminhos.length)
  })

  it('Biblioteca NÃO é um apelido de Projetos', () => {
    // A decisão de produto é literal sobre isto. Um destino que apontasse para
    // o mesmo endereço seria duas portas para a mesma sala.
    expect(BIBLIOTECA_PATH).not.toBe('/studio/projects')
    expect(BIBLIOTECA_PATH).not.toBe('/studio/projetos')
  })

  it('cada endereço volta para o seu destino, inclusive na tela de um item', () => {
    for (const [destino, caminho] of Object.entries(CAMINHOS) as [Destino, string][]) {
      expect(destinoDoCaminho(caminho)).toBe(destino)
      expect(destinoDoCaminho(`${caminho}/algum-item`)).toBe(destino)
    }
  })

  it('a home não é destino nenhum destes — senão todos ficariam ativos sempre', () => {
    expect(destinoDoCaminho('/studio/')).toBeNull()
  })

  it('um endereço parecido NÃO casa por acidente', () => {
    expect(destinoDoCaminho('/studio/pluginsdemais')).toBeNull()
  })
})

describe('o recorte de Habilidades e Plugins', () => {
  it('os dois recortes não se sobrepõem', () => {
    // Sobreposição faria a mesma integração aparecer nas duas telas, com ações
    // diferentes, e as duas discordariam no primeiro conserto de uma delas.
    for (const tipo of ESCOPO.habilidades) expect(ESCOPO.plugins).not.toContain(tipo)
  })

  it('juntos cobrem TODOS os tipos: nenhum fica invisível', () => {
    const cobertos = new Set([...ESCOPO.habilidades, ...ESCOPO.plugins])
    for (const tipo of TODOS_OS_TIPOS) expect(cobertos.has(tipo)).toBe(true)
  })

  it('habilidade é habilidade; conector é plugin', () => {
    expect(pertenceAoDestino('habilidades', 'skill')).toBe(true)
    expect(pertenceAoDestino('habilidades', 'mcp')).toBe(false)
    expect(pertenceAoDestino('plugins', 'mcp')).toBe(true)
    expect(pertenceAoDestino('plugins', 'skill')).toBe(false)
  })

  it('um tipo que este cliente não conhece não entra em nenhum dos dois', () => {
    expect(pertenceAoDestino('habilidades', 'tipo-novo')).toBe(false)
    expect(pertenceAoDestino('plugins', 'tipo-novo')).toBe(false)
  })
})

describe('a pendência fica declarada, não removida', () => {
  it('Agendado está no escopo e marcado como pendente', () => {
    // O requisito continua existindo mesmo sem serviço. Apagar a linha para
    // chamar o visual de completo é o que a decisão proíbe.
    expect(CAMINHOS.agendado).toBe(AGENDADO_PATH)
    expect(DISPONIBILIDADE.agendado).toBe('pendente')
  })

  it('os destinos com serviço real estão marcados como prontos', () => {
    expect(DISPONIBILIDADE.habilidades).toBe('pronto')
    expect(DISPONIBILIDADE.plugins).toBe('pronto')
    expect(DISPONIBILIDADE.biblioteca).toBe('pronto')
  })

  it('todo destino tem uma disponibilidade declarada', () => {
    for (const destino of Object.keys(CAMINHOS) as Destino[]) {
      expect(['pronto', 'pendente']).toContain(DISPONIBILIDADE[destino])
    }
  })
})
