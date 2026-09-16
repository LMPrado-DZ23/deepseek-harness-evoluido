import { describe, expect, it } from 'vitest'

import {
  NAO_RESSUSCITA, TRATAMENTOS, avaliarHandoff, planoDeRollback, restauravel,
  type EfeitoParaDesfazer, type Handoff,
} from '../src/handoff.js'

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  id: 'h1', de: 'atendimento', para: 'engenharia', objetivo: 'corrigir o cadastro que nao salva',
  escopo_destinatario: ['editar-codigo', 'rodar-teste'], acoes_pedidas: ['editar-codigo'],
  vedadas: [], evidencias: ['run-123'], ...over,
})

describe('AT-129/AT-130 — a passagem de responsabilidade NAO concede acesso', () => {
  it('a passagem dentro do escopo e aceitavel', () => {
    expect(avaliarHandoff(handoff())).toEqual({ estado: 'ACEITAVEL', acoes: ['editar-codigo'] })
  })

  it('pedir o que o destinatario NAO podia fazer e recusado', () => {
    // §51: "nenhum deles recebe acesso extra pelo conteudo de uma mensagem".
    // Um handoff que ampliasse escopo seria escalada de privilegio escrita em
    // portugues.
    expect(avaliarHandoff(handoff({ acoes_pedidas: ['publicar'] })))
      .toEqual({ estado: 'RECUSADO', motivo: 'FORA_DO_ESCOPO', detalhe: 'publicar' })
  })

  it('acao VEDADA nesta passagem e recusada mesmo dentro do escopo', () => {
    // E o motivo e outro de proposito: dizer "fora do escopo" mandaria alguem
    // pedir uma permissao que ela ja tem.
    expect(avaliarHandoff(handoff({ vedadas: ['editar-codigo'] })))
      .toEqual({ estado: 'RECUSADO', motivo: 'ACAO_VEDADA', detalhe: 'editar-codigo' })
  })

  it('sem destinatario e sem objetivo, nao ha passagem', () => {
    expect(avaliarHandoff(handoff({ para: '  ' })).estado).toBe('RECUSADO')
    expect(avaliarHandoff(handoff({ objetivo: '' }))).toEqual({ estado: 'RECUSADO', motivo: 'SEM_OBJETIVO' })
  })

  it('o escopo e o TETO, e nao a sugestao: nenhuma acao fora dele sobrevive', () => {
    const misto = handoff({ acoes_pedidas: ['editar-codigo', 'apagar-banco'] })
    expect(avaliarHandoff(misto).estado).toBe('RECUSADO')
  })

  it('as acoes aceitas saem ordenadas: duas leituras iguais comparam', () => {
    const varias = handoff({ escopo_destinatario: ['a', 'b', 'c'], acoes_pedidas: ['c', 'a'] })
    expect(avaliarHandoff(varias)).toEqual({ estado: 'ACEITAVEL', acoes: ['a', 'c'] })
  })
})

describe('AT-133/AT-134 — Git nao desfaz cobranca, e-mail nem entrega', () => {
  const efeito = (tipo: EfeitoParaDesfazer['tipo'], conhecido = true): EfeitoParaDesfazer =>
    ({ id: `${tipo}-1`, tipo, desfecho_conhecido: conhecido })

  it('arquivo RESTAURA, e nao pede autorizacao', () => {
    expect(planoDeRollback([efeito('ARQUIVO')])).toEqual([
      { efeito: 'ARQUIVO-1', tratamento: 'RESTAURAVEL', exige_autorizacao: false },
    ])
  })

  it('dado exige MIGRACAO EXPLICITA, porque a volta nem sempre existe', () => {
    expect(planoDeRollback([efeito('DADO')])[0]).toMatchObject({ tratamento: 'MIGRACAO_EXPLICITA', exige_autorizacao: true })
  })

  it('cobranca, mensagem, publicacao e entrega NAO desfazem: geram compensacao NOVA', () => {
    // §52: "uma compensacao de negocio e nova operacao autorizada com recibo e
    // idempotencia, nao replay do historico".
    for (const tipo of ['COBRANCA', 'MENSAGEM', 'PUBLICACAO', 'ENTREGA'] as const) {
      const passo = planoDeRollback([efeito(tipo)])[0]
      expect(passo, tipo).toMatchObject({ tratamento: 'COMPENSACAO_NOVA', exige_autorizacao: true })
    }
  })

  it('efeito com desfecho DESCONHECIDO e IRREVERSIVEL, e nao repetido', () => {
    // Sem saber se a cobranca passou, compensa-la pode devolver dinheiro que
    // nunca foi cobrado, e repeti-la pode cobrar duas vezes. A unica saida
    // honesta e parar e mandar reconciliar.
    const passo = planoDeRollback([efeito('COBRANCA', false)])[0]
    expect(passo).toMatchObject({ tratamento: 'IRREVERSIVEL', exige_autorizacao: true, nota: 'EFFECT_UNKNOWN' })
  })

  it('ate um ARQUIVO com desfecho desconhecido para de ser restauravel', () => {
    expect(planoDeRollback([efeito('ARQUIVO', false)])[0]?.tratamento).toBe('IRREVERSIVEL')
  })

  it('o plano tem um passo por efeito, e nao um veredito unico', () => {
    const plano = planoDeRollback([efeito('ARQUIVO'), efeito('COBRANCA'), efeito('DADO')])
    expect(plano).toHaveLength(3)
    expect(new Set(plano.map(p => p.tratamento)).size).toBe(3)
    for (const passo of plano) expect(TRATAMENTOS).toContain(passo.tratamento)
  })

  it('restaurar NAO ressuscita segredo revogado, aprovacao consumida nem saldo gasto', () => {
    // Um rollback que reativasse uma credencial revogada desfaria uma decisao
    // de seguranca usando uma ferramenta de arquivos.
    for (const recurso of NAO_RESSUSCITA) expect(restauravel(recurso), recurso).toBe(false)
    expect(restauravel('src/App.tsx')).toBe(true)
  })

  it('rotina pausada continua pausada ate revalidacao', () => {
    expect(restauravel('rotina-pausada')).toBe(false)
  })
})
