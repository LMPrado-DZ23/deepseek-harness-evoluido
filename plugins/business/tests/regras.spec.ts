import { describe, expect, it } from 'vitest'
import { planoNormalizado, planoVigente, planosIguais, proximaVersao, recusaDePlano, textoNormalizado } from '../src/regras.js'
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
