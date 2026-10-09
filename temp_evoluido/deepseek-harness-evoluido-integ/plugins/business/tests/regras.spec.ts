import { describe, expect, it } from 'vitest'
import { briefingDaEmpresa, nomeDaTarefa, planoNormalizado, planoVigente, planosIguais, proximaVersao, recusaDePlano, textoNormalizado } from '../src/regras.js'
import type { Empresa, PlanoDeNegocio, RegistroDePlano } from '../src/model.js'

const AGORA = '2026-09-17T12:00:00.000Z'

const PLANO: PlanoDeNegocio = {
  objetivo: 'vender bolos caseiros por encomenda no bairro',
  publico: 'moradores do bairro',
  oferta: 'bolo de 1kg por encomenda com 2 dias de antecedência',
  limites: ['não entrega fora do bairro', 'não aceita encomenda para o mesmo dia'],
}

function empresa(extra: Partial<Empresa> = {}): Empresa {
  return {
    business_id: 'emp-1', org_id: 'org-a', tenant_id: 'tenant-a', nome: 'Bolos da Ana',
    origem: 'criada', identidade_juridica_declarada: null, created_by: 'user-a',
    created_at: AGORA, updated_at: AGORA, archived_at: null, ...extra,
  }
}

function registro(version: number, plano: PlanoDeNegocio = PLANO): RegistroDePlano {
  return {
    plan_id: `plan-${version}`, business_id: 'emp-1', org_id: 'org-a', tenant_id: 'tenant-a',
    version, plano, created_by: 'user-a', created_at: AGORA,
  }
}

describe('a versão do plano', () => {
  it('a primeira é 1', () => {
    expect(proximaVersao([])).toBe(1)
  })

  it('é a MAIOR mais um, e não a quantidade mais um', () => {
    // Com a contagem, apagar a versão 2 faria a próxima ser 3 de novo — e
    // "a versão 3" passaria a ser duas coisas diferentes para sempre.
    expect(proximaVersao([registro(1), registro(3)])).toBe(4)
  })

  it('o plano vigente é o de maior VERSÃO, e não o mais recente por data', () => {
    // Dois registros no mesmo milissegundo empatariam por data, e a ordem de
    // leitura decidiria qual plano a empresa tem.
    expect(planoVigente([registro(2), registro(1), registro(3)])?.version).toBe(3)
  })

  it('sem plano nenhum, não inventa um', () => {
    expect(planoVigente([])).toBeUndefined()
  })
})

describe('quando um plano novo é recusado', () => {
  it('empresa ARQUIVADA não recebe plano novo', () => {
    expect(recusaDePlano(empresa({ archived_at: AGORA }), undefined, PLANO)).toBe('arquivada')
  })

  it('plano IDÊNTICO ao vigente é recusado — versão sem mudança é ruído no histórico', () => {
    expect(recusaDePlano(empresa(), PLANO, PLANO)).toBe('sem-mudanca')
  })

  it('mudar UM campo já é mudança', () => {
    expect(recusaDePlano(empresa(), PLANO, { ...PLANO, oferta: 'bolo de 2kg' })).toBeNull()
  })

  it('trocar a ORDEM dos limites não é mudança', () => {
    // Reordenar não é uma decisão nova, e uma versão por reordenação encheria o
    // histórico de mudanças que ninguém tomou.
    const invertido = { ...PLANO, limites: [...PLANO.limites].reverse() }
    expect(planosIguais(PLANO, invertido)).toBe(true)
  })

  it('ACRESCENTAR um limite é mudança', () => {
    expect(planosIguais(PLANO, { ...PLANO, limites: [...PLANO.limites, 'não faz bolo sem açúcar'] })).toBe(false)
  })

  it('a primeira versão nunca é recusada por falta de mudança', () => {
    expect(recusaDePlano(empresa(), undefined, PLANO)).toBeNull()
  })
})

describe('a normalização do que a pessoa escreveu', () => {
  it('tira espaço das pontas e junta os repetidos, e NÃO mexe no resto', () => {
    expect(textoNormalizado('  Bolos   da Ana  ')).toBe('Bolos da Ana')
  })

  it('limites repetidos com espaçamento diferente viram UM', () => {
    const normalizado = planoNormalizado({ ...PLANO, limites: ['não entrega fora do bairro', '  não  entrega fora do bairro '] })
    expect(normalizado.limites).toEqual(['não entrega fora do bairro'])
  })

  it('limite vazio some, em vez de virar uma regra em branco', () => {
    expect(planoNormalizado({ ...PLANO, limites: ['   ', 'só à vista'] }).limites).toEqual(['só à vista'])
  })

  it('a ORDEM dos limites que sobraram é a que a pessoa escreveu', () => {
    const normalizado = planoNormalizado({ ...PLANO, limites: ['zebra', 'abacate'] })
    expect(normalizado.limites).toEqual(['zebra', 'abacate'])
  })
})

describe('o briefing de uma tarefa da empresa', () => {
  it('o PEDIDO da pessoa vem primeiro, e o plano é o contexto', () => {
    // A ordem não é estética: é o pedido dela que decide o que construir.
    const texto = briefingDaEmpresa(empresa(), PLANO, 'uma página para receber encomendas')
    expect(texto.startsWith('uma página para receber encomendas')).toBe(true)
  })

  it('leva objetivo, público, oferta e o nome da empresa', () => {
    const texto = briefingDaEmpresa(empresa(), PLANO, 'uma página')
    expect(texto).toContain('Bolos da Ana')
    expect(texto).toContain('vender bolos caseiros por encomenda no bairro')
    expect(texto).toContain('moradores do bairro')
    expect(texto).toContain('bolo de 1kg por encomenda com 2 dias de antecedência')
  })

  it('cada limite entra como LIMITE, e não como enfeite', () => {
    const texto = briefingDaEmpresa(empresa(), PLANO, 'uma página')
    expect(texto).toContain('O que a empresa NÃO faz, e o aplicativo não pode prometer:')
    expect(texto).toContain('- não entrega fora do bairro')
    expect(texto).toContain('- não aceita encomenda para o mesmo dia')
  })

  it('oferta VAZIA não vira um rótulo com nada depois', () => {
    // "Ainda não decidi" é honesto; "O que ela entrega:" seguido de nada
    // mandaria o gerador inventar uma oferta que ninguém decidiu.
    const texto = briefingDaEmpresa(empresa(), { ...PLANO, oferta: '' }, 'uma página')
    expect(texto).not.toContain('O que ela entrega')
  })

  it('sem limite nenhum, não escreve o cabeçalho dos limites', () => {
    const texto = briefingDaEmpresa(empresa(), { ...PLANO, limites: [] }, 'uma página')
    expect(texto).not.toContain('NÃO faz')
  })
})

describe('o nome da tarefa', () => {
  it('é o pedido, quando ele serve', () => {
    expect(nomeDaTarefa('uma página para encomendas', 'Bolos da Ana')).toBe('uma página para encomendas')
  })

  it('CORTA em 120, porque o domínio da tarefa recusa mais que isso', () => {
    // Sem o corte, a recusa viria do servidor depois de tudo montado, e a
    // pessoa leria como defeito o que é só um teto.
    const nome = nomeDaTarefa('a'.repeat(400), 'Bolos da Ana')
    expect(nome.length).toBeLessThanOrEqual(120)
    expect(nome.endsWith('…')).toBe(true)
  })

  it('pedido curto demais cai no nome da EMPRESA, e não numa string vazia', () => {
    expect(nomeDaTarefa('  ', 'Bolos da Ana')).toBe('Tarefa de Bolos da Ana')
  })
})
