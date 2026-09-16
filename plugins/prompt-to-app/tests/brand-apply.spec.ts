import { describe, expect, it } from 'vitest'

import { createDesignSpec } from '../src/design.js'
import {
  FORMATOS, MARCADOR, VARIAVEIS_DO_STUDIO, aplicarMarca, contaminacoes, distribuicao, marcadorDe, mesmaMarca,
  type MarcaDaEmpresa,
} from '../src/brand-apply.js'

/** Duas empresas de teste, com marcas visivelmente diferentes. */
const acme: MarcaDaEmpresa = {
  empresa: 'acme', versao: 'v1', ativos: ['acme-logo.png'],
  spec: createDesignSpec({ preset: 'brand', primary: { h: 12, s: 84, l: 46 } }),
}
const beta: MarcaDaEmpresa = {
  empresa: 'beta', versao: 'v1', ativos: ['beta-logo.png'],
  spec: createDesignSpec({ preset: 'brand', primary: { h: 204, s: 70, l: 40 } }),
}

describe('AT-115 — a marca da empresa em DOIS formatos', () => {
  it('os dois formatos existem e saem da MESMA especificacao', () => {
    const artefatos = FORMATOS.map(formato => aplicarMarca(acme, formato))
    expect(artefatos).toHaveLength(2)
    // Procedencia, e nao aparencia: dois arquivos diferentes (folha de estilo e
    // apresentacao) vindos da mesma marca.
    expect(mesmaMarca(artefatos)).toBe(true)
    expect(new Set(artefatos.map(a => a.conteudo)).size).toBe(2)
  })

  it('cada artefato CARREGA a referencia da marca, dentro do proprio arquivo', () => {
    // Um artefato exportado sai do produto: quem o receber tres meses depois
    // precisa dizer de qual empresa e versao ele e, sem acesso ao banco.
    for (const formato of FORMATOS) {
      const artefato = aplicarMarca(acme, formato)
      expect(artefato.conteudo, formato).toContain(`${MARCADOR}: acme v1`)
      expect(artefato.conteudo, formato).toContain(artefato.referencia.marca_sha256)
    }
  })

  it('marcas DIFERENTES produzem impressoes diferentes', () => {
    // Sem isto, `mesmaMarca` responderia sim para qualquer par.
    expect(aplicarMarca(acme, 'aplicativo-web').referencia.marca_sha256)
      .not.toBe(aplicarMarca(beta, 'aplicativo-web').referencia.marca_sha256)
    expect(mesmaMarca([aplicarMarca(acme, 'aplicativo-web'), aplicarMarca(beta, 'apresentacao')])).toBe(false)
  })

  it('uma versao NOVA da mesma empresa nao passa por igual', () => {
    const v2: MarcaDaEmpresa = { ...acme, versao: 'v2' }
    expect(mesmaMarca([aplicarMarca(acme, 'apresentacao'), aplicarMarca(v2, 'apresentacao')])).toBe(false)
  })

  it('a mesma empresa e a mesma versao com CORES diferentes tambem nao passam', () => {
    // O caso que a falsificacao encontrou: sem conferir a IMPRESSAO, dois
    // materiais rotulados "acme v1" passariam como a mesma marca mesmo tendo
    // sido gerados de paletas diferentes — que e exatamente o estado em que
    // alguem edita a marca sem mudar o numero da versao.
    const mesmoRotuloOutraCor: MarcaDaEmpresa = { ...acme, spec: beta.spec }
    expect(mesmaMarca([aplicarMarca(acme, 'aplicativo-web'), aplicarMarca(mesmoRotuloOutraCor, 'aplicativo-web')])).toBe(false)
  })

  it('NENHUM artefato nao e "a mesma marca": e a ausencia de resposta', () => {
    // Responder sim para uma lista vazia faria uma conferencia que nao olhou
    // nada parecer uma conferencia que aprovou.
    expect(mesmaMarca([])).toBe(false)
  })

  it('a cor da empresa CHEGA na apresentacao, e nao so no aplicativo', () => {
    // Uma apresentacao com paleta propria divergiria da folha de estilo sem
    // ninguem notar — que e o defeito que "dois formatos" existe para pegar.
    const slide = aplicarMarca(acme, 'apresentacao').conteudo
    expect(slide).toContain('hsl(12 84%')
    expect(aplicarMarca(beta, 'apresentacao').conteudo).toContain('hsl(204 70%')
  })

  it('o painel do DZ23 NAO e reestilizado por marca de cliente', () => {
    // A prova e pelo contrario: o material da empresa nao define nada do
    // painel. Se definisse, aplicar a marca do cliente mudaria o produto.
    for (const formato of FORMATOS) {
      const conteudo = aplicarMarca(acme, formato).conteudo
      for (const variavel of VARIAVEIS_DO_STUDIO) expect(conteudo, `${formato}/${variavel}`).not.toContain(variavel)
    }
  })

  it('a referencia e CALCULADA da marca, e nao aceita carimbo', () => {
    // Receber a impressao por parametro permitiria carimbar "v2" num material
    // gerado com a v1 — precisamente a mentira que a AT-116 procura.
    const artefato = aplicarMarca({ ...acme, versao: 'v9' }, 'aplicativo-web')
    expect(artefato.referencia.marca_sha256).toBe(aplicarMarca(acme, 'aplicativo-web').referencia.marca_sha256)
    expect(artefato.referencia.versao).toBe('v9')
  })
})

describe('AT-116 — trocar e revogar NAO atravessa empresas', () => {
  const referencias = [acme, beta].map(marca => aplicarMarca(marca, 'aplicativo-web').referencia)

  it('o material de uma empresa esta limpo do ponto de vista da outra', () => {
    for (const formato of FORMATOS) {
      expect(contaminacoes(aplicarMarca(acme, formato), referencias, acme.ativos), formato).toEqual([])
      expect(contaminacoes(aplicarMarca(beta, formato), referencias, beta.ativos), formato).toEqual([])
    }
  })

  it('marca de OUTRA empresa dentro do material e acusada', () => {
    const contaminado = { ...aplicarMarca(acme, 'aplicativo-web') }
    const sujo = { ...contaminado, conteudo: `${contaminado.conteudo}\n/* ${marcadorDe({ empresa: 'beta' })}v1 */` }
    expect(contaminacoes(sujo, referencias, acme.ativos)).toContainEqual({
      artefato: 'aplicativo-web', motivo: 'MARCA_DE_OUTRA_EMPRESA', detalhe: 'beta',
    })
  })

  it('a impressao da marca da outra empresa tambem acusa, mesmo sem o nome', () => {
    const outro = aplicarMarca(beta, 'aplicativo-web')
    const meu = aplicarMarca(acme, 'aplicativo-web')
    const sujo = { ...meu, conteudo: `${meu.conteudo}\n/* ${outro.referencia.marca_sha256} */` }
    expect(contaminacoes(sujo, referencias, acme.ativos).map(c => c.motivo)).toContain('MARCA_DE_OUTRA_EMPRESA')
  })

  it('ativo de outra empresa no material e acusado', () => {
    const meu = aplicarMarca(acme, 'aplicativo-web')
    const sujo = { ...meu, ativos: ['beta-logo.png'] }
    expect(contaminacoes(sujo, referencias, acme.ativos)).toContainEqual({
      artefato: 'aplicativo-web', motivo: 'ATIVO_NAO_AUTORIZADO', detalhe: 'beta-logo.png',
    })
  })

  it('estilo do painel dentro do material da empresa e acusado', () => {
    const meu = aplicarMarca(acme, 'apresentacao')
    const sujo = { ...meu, conteudo: `${meu.conteudo}\n--dz23-shell: red;` }
    expect(contaminacoes(sujo, referencias, acme.ativos).map(c => c.motivo)).toContain('ESTILO_DO_STUDIO')
  })

  it('revogar um ativo BLOQUEIA nova distribuicao', () => {
    const meu = { ...aplicarMarca(acme, 'aplicativo-web'), ativos: ['acme-logo.png'] }
    expect(distribuicao(meu, [])).toEqual({ permitida: true })
    expect(distribuicao(meu, ['acme-logo.png'])).toEqual({ permitida: false, motivo: 'ATIVO_REVOGADO', ativo: 'acme-logo.png' })
  })

  it('e o material JA PUBLICADO nao muda por causa da revogacao', () => {
    // As duas metades juntas sao o comportamento honesto: revogar impede que
    // aquilo continue saindo, e nao reescreve o passado. Apagar o material
    // antigo prometeria um poder que o produto nao tem — a copia que alguem ja
    // baixou continua existindo.
    const publicado = { ...aplicarMarca(acme, 'aplicativo-web'), ativos: ['acme-logo.png'] }
    const antes = publicado.sha256
    distribuicao(publicado, ['acme-logo.png'])
    expect(publicado.sha256).toBe(antes)
    expect(publicado.conteudo).toContain(`${MARCADOR}: acme v1`)
  })

  it('a v2 de uma empresa NAO reescreve o material v1 ja gerado', () => {
    const v1 = aplicarMarca(acme, 'aplicativo-web')
    const v2 = aplicarMarca({ ...acme, versao: 'v2', spec: beta.spec }, 'aplicativo-web')
    // O material v1 continua citando v1 e a impressao v1.
    expect(v1.conteudo).toContain(`${MARCADOR}: acme v1`)
    expect(v1.referencia.marca_sha256).not.toBe(v2.referencia.marca_sha256)
    expect(v1.sha256).not.toBe(v2.sha256)
  })

  it('a conferencia NAO recebe o banco: ela recebe as referencias', () => {
    // Uma funcao de conferencia com acesso a dados de todas as empresas e ela
    // mesma o vazamento que ela existe para pegar.
    expect(contaminacoes(aplicarMarca(acme, 'aplicativo-web'), [], acme.ativos)).toEqual([])
  })
})
