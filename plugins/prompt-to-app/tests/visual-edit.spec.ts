import { describe, expect, it } from 'vitest'

import {
  ALCANCES, MAPAS, MOTIVOS, QUALIFICACOES,
  autorizadoPara, exigeConfirmacao, impacto, qualificacoesValidas, selecao,
  type ContextoDaEdicao, type Origem, type ProvaDeQualificacao,
} from '../src/visual-edit.js'

const SNAP = 'a'.repeat(64)
const origem = (over: Partial<Origem> = {}): Origem => ({
  mapa: 'EXATO', arquivo: 'src/GeneratedApp.tsx', componente: 'Botao', snapshot_sha256: SNAP, ...over,
})
const contexto = (over: Partial<ContextoDaEdicao> = {}): ContextoDaEdicao => ({
  snapshot_atual: SNAP, alterados_por_outro: [], alcance: 'INSTANCIA', ...over,
})

describe('AT-119/AT-120 — seleção visual so edita o que ela SABE onde fica', () => {
  it('mapa EXATO, prévia atual e ninguém mexendo: edita', () => {
    expect(selecao(origem(), contexto())).toEqual({ estado: 'EDITAVEL', arquivo: 'src/GeneratedApp.tsx', alcance: 'INSTANCIA' })
  })

  it('os TRES estados de mapa existem, e PARCIAL nao vira exato', () => {
    // A tentacao e editar assim mesmo avisando que "pode nao ser exatamente
    // aqui". Quem le esse aviso e quem nao programa, e ela nao tem como julgar.
    expect(MAPAS).toEqual(['EXATO', 'PARCIAL', 'AUSENTE'])
    expect(selecao(origem({ mapa: 'PARCIAL' }), contexto())).toEqual({ estado: 'SO_INSPECAO', motivo: 'MAPA_PARCIAL' })
    expect(selecao(origem({ mapa: 'AUSENTE' }), contexto())).toEqual({ estado: 'SO_INSPECAO', motivo: 'MAPA_AUSENTE' })
  })

  it('elemento EXTERNO nunca recebe apontamento inventado', () => {
    // §48: "frames/widgets de terceiros e conteudo sem fonte confiavel nao
    // recebem apontamento inventado".
    expect(selecao(origem({ externo: true }), contexto())).toEqual({ estado: 'SO_INSPECAO', motivo: 'ELEMENTO_EXTERNO' })
  })

  it('previa DESATUALIZADA nao edita: o arquivo de hoje nao e o da foto', () => {
    expect(selecao(origem(), contexto({ snapshot_atual: 'b'.repeat(64) })))
      .toEqual({ estado: 'SO_INSPECAO', motivo: 'PREVIA_DESATUALIZADA' })
  })

  it('alteracao CONCORRENTE nao e sobrescrita', () => {
    // §48: "mudanca concorrente exige reconciliacao; nao sobrescrever trabalho
    // humano".
    expect(selecao(origem(), contexto({ alterados_por_outro: ['src/GeneratedApp.tsx'] })))
      .toEqual({ estado: 'SO_INSPECAO', motivo: 'ALTERACAO_CONCORRENTE' })
  })

  it('mapa EXATO sem arquivo nomeado e tratado como AUSENTE', () => {
    // "Exato" sem arquivo e uma contradicao no registro, e a resposta segura e
    // a que nao inventa um caminho.
    const { arquivo: _semArquivo, ...semCaminho } = origem()
    expect(selecao(semCaminho, contexto()).estado).toBe('SO_INSPECAO')
    expect(selecao(origem({ arquivo: '' }), contexto())).toEqual({ estado: 'SO_INSPECAO', motivo: 'MAPA_AUSENTE' })
  })

  it('o externo vence os demais: nem se pergunta o snapshot dele', () => {
    expect(selecao(origem({ externo: true, mapa: 'AUSENTE' }), contexto({ snapshot_atual: 'z'.repeat(64) })))
      .toEqual({ estado: 'SO_INSPECAO', motivo: 'ELEMENTO_EXTERNO' })
  })

  it('todo motivo de recusa tem nome na lista fechada', () => {
    for (const caso of [
      origem({ externo: true }), origem({ mapa: 'AUSENTE' }), origem({ mapa: 'PARCIAL' }),
    ]) {
      const resultado = selecao(caso, contexto())
      if (resultado.estado === 'SO_INSPECAO') expect(MOTIVOS).toContain(resultado.motivo)
    }
  })
})

describe('AT-121/AT-122 — o impacto de uma edicao', () => {
  it('os tres alcances existem e crescem', () => {
    expect(ALCANCES).toEqual(['INSTANCIA', 'COMPONENTE_COMPARTILHADO', 'MARCA'])
  })

  it('instancia unica e conhecida NAO exige confirmacao', () => {
    expect(exigeConfirmacao(impacto('INSTANCIA', ['src/a.tsx'], false))).toBe(false)
  })

  it('componente compartilhado e marca SEMPRE exigem', () => {
    // A pessoa clicou em UM botao nos tres casos.
    expect(exigeConfirmacao(impacto('COMPONENTE_COMPARTILHADO', ['src/a.tsx'], false))).toBe(true)
    expect(exigeConfirmacao(impacto('MARCA', ['src/a.tsx'], false))).toBe(true)
  })

  it('INCERTEZA exige confirmacao mesmo numa instancia', () => {
    // Dizer "muda 3 lugares" quando podem ser 4 e pior que dizer "muda estes
    // 3, e pode haver outros".
    expect(exigeConfirmacao(impacto('INSTANCIA', ['src/a.tsx'], true))).toBe(true)
  })

  it('mais de um atingido exige confirmacao', () => {
    expect(exigeConfirmacao(impacto('INSTANCIA', ['src/a.tsx', 'src/b.tsx'], false))).toBe(true)
  })

  it('a lista de atingidos e ESTAVEL entre leituras', () => {
    expect(impacto('MARCA', ['c', 'a', 'b'], false).atingidos).toEqual(['a', 'b', 'c'])
  })
})

describe('AT-131/AT-132 — as quatro qualificacoes NAO se promovem', () => {
  const prova = (q: ProvaDeQualificacao['qualificacao'], over: Partial<ProvaDeQualificacao> = {}): ProvaDeQualificacao =>
    ({ qualificacao: q, snapshot_sha256: SNAP, ambiente: 'worker', ...over })

  it('as quatro existem e sao distintas', () => {
    // §52: "essas dimensoes NAO formam uma promocao automatica".
    expect(QUALIFICACOES).toEqual(['SALVO', 'TESTADO', 'REVISADO', 'AUTORIZADO'])
  })

  it('SALVO nao implica TESTADO', () => {
    const provas = [prova('SALVO')]
    expect(qualificacoesValidas(provas, SNAP).map(p => p.qualificacao)).toEqual(['SALVO'])
    expect(qualificacoesValidas(provas, SNAP).some(p => p.qualificacao === 'TESTADO')).toBe(false)
  })

  it('uma alteracao invalida as provas do snapshot anterior', () => {
    const provas = [prova('SALVO'), prova('TESTADO'), prova('REVISADO')]
    expect(qualificacoesValidas(provas, 'c'.repeat(64))).toEqual([])
  })

  it('e as provas antigas NAO sao apagadas: elas continuam na lista', () => {
    // §52: "preservar resultados antigos como historico, nunca converte-los em
    // prova de codigo novo".
    const provas = [prova('TESTADO'), prova('TESTADO', { snapshot_sha256: 'c'.repeat(64) })]
    expect(provas).toHaveLength(2)
    expect(qualificacoesValidas(provas, SNAP)).toHaveLength(1)
    expect(qualificacoesValidas(provas, 'c'.repeat(64))).toHaveLength(1)
  })

  it('AUTORIZADO e sobre UMA acao, e nao um cheque em branco', () => {
    // A diferenca entre "ele deixou enviar aquele e-mail" e "ele deixou enviar
    // e-mails".
    const provas = [prova('AUTORIZADO', { acao: 'enviar-email-boas-vindas' })]
    expect(autorizadoPara(provas, 'enviar-email-boas-vindas')).toBe(true)
    expect(autorizadoPara(provas, 'enviar-email-cobranca')).toBe(false)
  })

  it('AUTORIZADO sem acao nomeada nao autoriza nada', () => {
    expect(autorizadoPara([prova('AUTORIZADO')], 'qualquer')).toBe(false)
  })

  it('REVISADO nao autoriza: sao dimensoes diferentes', () => {
    expect(autorizadoPara([prova('REVISADO', { acao: 'publicar' })], 'publicar')).toBe(false)
  })
})
