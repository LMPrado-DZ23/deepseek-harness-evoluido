import { describe, expect, it } from 'vitest'

import {
  ESTADOS_DE_ETAPA, ETAPAS, NATUREZAS,
  alvoProvado, alvosUtilizaveis, escolherPerfil, podeReceberEfeitoSensivel, transicao, validadeDaAtestacao,
  type Alvo, type Atestacao, type PedidoDeTransicao, type Perfil,
} from '../src/execution-profiles.js'

const alvo = (id: string, etapas: Partial<Alvo['etapas']> = {}): Alvo => ({
  id,
  etapas: { fonte: 'PROVADO', build: 'PROVADO', execucao: 'PROVADO', assinatura: 'NAO_SE_APLICA', distribuicao: 'NAO_SE_APLICA', ...etapas },
})
const perfil = (id: string, over: Partial<Perfil> = {}): Perfil => ({
  id, capacidades: ['build', 'teste'], disponivel: true, host: false, autorizado: true, ...over,
})
const atestacao = (over: Partial<Atestacao> = {}): Atestacao => ({
  adaptador: 'docker', versao: '27.1', configuracao_sha256: 'a'.repeat(64),
  ambiente: 'worker', natureza: 'INTEGRACAO_REAL', limitacoes: [], ...over,
})

describe('AT-125 — a matriz de alvo SEPARA fonte, build, execucao, assinatura e distribuicao', () => {
  it('as cinco etapas existem e sao independentes', () => {
    // "Gera para celular" esconde cinco coisas. Um produto que responde
    // "suportado" para a primeira e deixa a pessoa descobrir as outras quatro
    // sozinha mentiu por omissao.
    expect(ETAPAS).toEqual(['fonte', 'build', 'execucao', 'assinatura', 'distribuicao'])
    expect(ESTADOS_DE_ETAPA).toContain('DECLARADO')
    expect(ESTADOS_DE_ETAPA).toContain('PROVADO')
  })

  it('DECLARADO nao conta como provado: alguem escreveu, e ninguem rodou', () => {
    expect(alvoProvado(alvo('web'))).toBe(true)
    expect(alvoProvado(alvo('web', { build: 'DECLARADO' }))).toBe(false)
  })

  it('NAO_SE_APLICA nao e um sim disfarcado, e tambem nao reprova', () => {
    // Um alvo web nao tem assinatura. Responder PRONTO ali faria a contagem
    // subir por causa de uma etapa que nao existe; reprovar faria o alvo web
    // nunca ficar pronto.
    expect(alvoProvado(alvo('web', { assinatura: 'NAO_SE_APLICA', distribuicao: 'NAO_SE_APLICA' }))).toBe(true)
    expect(alvoProvado(alvo('android', { assinatura: 'INDISPONIVEL' }))).toBe(false)
  })

  it('um alvo INDISPONIVEL NAO derruba os outros', () => {
    // §49: "nao exigir que todos os perfis existam em toda instalacao".
    // AT-125: "bloqueio nao e estendido a todo o Studio".
    const alvos = [alvo('web'), alvo('android', { build: 'INDISPONIVEL', assinatura: 'INDISPONIVEL' })]
    expect(alvosUtilizaveis(alvos).map(a => a.id)).toEqual(['web'])
    expect(alvosUtilizaveis(alvos)).toHaveLength(1)
  })

  it('nenhum alvo utilizavel devolve lista vazia, e nao um alvo qualquer', () => {
    expect(alvosUtilizaveis([alvo('x', { fonte: 'INDISPONIVEL' })])).toEqual([])
  })
})

describe('AT-123 — onde a tarefa roda, e o que acontece quando o lugar certo nao existe', () => {
  it('escolhe o perfil compativel, autorizado e disponivel', () => {
    expect(escolherPerfil(['build'], [perfil('worker')])).toEqual({ estado: 'ESCOLHIDO', perfil: 'worker' })
  })

  it('o host NAO recebe a tarefa por QUEDA do isolado: sem ele autorizado, bloqueia', () => {
    // Um produto que, ao nao encontrar o ambiente isolado, roda na maquina de
    // quem opera trocou uma tarefa bloqueada por uma execucao sem isolamento —
    // e quem pagou nao foi avisado.
    //
    // O host NAO e proibido por ser host: ele e escolhido quando ele proprio e
    // compativel, autorizado e disponivel. O que nao existe e a QUEDA: quando o
    // isolado cai e o host nao esta autorizado, a resposta e bloquear.
    expect(escolherPerfil(['build'], [
      perfil('worker', { disponivel: false }),
      perfil('host', { host: true, autorizado: false }),
    ])).toEqual({ estado: 'BLOQUEADO', motivo: 'INDISPONIVEL' })
    // ^ INDISPONIVEL, e nao NAO_AUTORIZADO: entre os perfis AUTORIZADOS, nenhum
    // esta de pe. E a verdade acionavel — o lugar certo existe e nao subiu —, e
    // apontar o host diria a quem le para autorizar a maquina dela.
  })

  it('o host autorizado E disponivel roda, porque ele nao e proibido por ser host', () => {
    expect(escolherPerfil(['build'], [perfil('host', { host: true })]))
      .toEqual({ estado: 'ESCOLHIDO', perfil: 'host' })
  })

  it('o ISOLADO e preferido quando os dois servem: a ordem nao decide por acidente', () => {
    const escolha = escolherPerfil(['build'], [perfil('host', { host: true }), perfil('worker')])
    expect(escolha).toEqual({ estado: 'ESCOLHIDO', perfil: 'worker' })
  })

  it('os tres motivos de bloqueio sao DIFERENTES, porque pedem coisas diferentes', () => {
    // Um pede outro perfil, outro pede permissao, o terceiro pede esperar.
    expect(escolherPerfil(['gpu'], [perfil('worker')])).toEqual({ estado: 'BLOQUEADO', motivo: 'SEM_PERFIL_COMPATIVEL' })
    expect(escolherPerfil(['build'], [perfil('worker', { autorizado: false })])).toEqual({ estado: 'BLOQUEADO', motivo: 'NAO_AUTORIZADO' })
    expect(escolherPerfil(['build'], [perfil('worker', { disponivel: false })])).toEqual({ estado: 'BLOQUEADO', motivo: 'INDISPONIVEL' })
  })

  it('sem perfil nenhum, bloqueia — e nao inventa um', () => {
    expect(escolherPerfil(['build'], [])).toEqual({ estado: 'BLOQUEADO', motivo: 'SEM_PERFIL_COMPATIVEL' })
  })
})

describe('AT-124 — transicao entre ambientes', () => {
  const pedido = (over: Partial<PedidoDeTransicao> = {}): PedidoDeTransicao => ({
    origem: 'a', destino: 'b',
    snapshot_sha256_origem: 'x'.repeat(64), snapshot_sha256_destino: 'x'.repeat(64),
    credenciais_transportadas: [], efeitos_desconhecidos: [], ...over,
  })

  it('a transicao limpa conclui, e o destino vira o dono', () => {
    expect(transicao(pedido())).toEqual({ estado: 'CONCLUIDA', dono: 'b' })
  })

  it('hash que nao confere recusa: o que chegou nao e o que saiu', () => {
    expect(transicao(pedido({ snapshot_sha256_destino: 'y'.repeat(64) })))
      .toEqual({ estado: 'RECUSADA', motivo: 'HASH_NAO_CONFERE' })
  })

  it('DOIS donos e recusado: execucao dupla cobra duas vezes', () => {
    expect(transicao(pedido({ dono_no_destino: 'outra-instancia' })))
      .toEqual({ estado: 'RECUSADA', motivo: 'DONO_DUPLICADO' })
  })

  it('credencial que viaja junto e recusada', () => {
    // Uma credencial copiada passa a existir em dois lugares, e revoga-la num
    // nao a revoga no outro.
    expect(transicao(pedido({ credenciais_transportadas: ['DZ23_APP_SMTP'] })))
      .toEqual({ estado: 'RECUSADA', motivo: 'CREDENCIAL_COPIADA' })
  })

  it('efeito com desfecho DESCONHECIDO nao e repetido: ele bloqueia', () => {
    // §52: EFFECT_UNKNOWN continua sem retry automatico. Reconciliar e trabalho
    // de quem tem autoridade, e nao da transicao.
    expect(transicao(pedido({ efeitos_desconhecidos: ['cobranca-123'] })))
      .toEqual({ estado: 'RECUSADA', motivo: 'EFEITO_ABERTO' })
  })

  it('dono VAZIO nao conta como dono', () => {
    expect(transicao(pedido({ dono_no_destino: '' })).estado).toBe('CONCLUIDA')
  })
})

describe('AT-127/AT-128 — atestacao vale para o perfil observado', () => {
  const ambiente = { nome: 'worker', configuracao_sha256: 'a'.repeat(64), versao: '27.1' }

  it('a atestacao do proprio ambiente vale', () => {
    expect(validadeDaAtestacao(atestacao(), ambiente)).toEqual({ valida: true })
  })

  it('outro ambiente, outra versao e outra configuracao invalidam — cada um com seu nome', () => {
    // Cada motivo pede uma acao diferente: rodar no ambiente certo, subir a
    // versao, ou reconferir a configuracao.
    expect(validadeDaAtestacao(atestacao({ ambiente: 'host' }), ambiente)).toEqual({ valida: false, motivo: 'OUTRO_AMBIENTE' })
    expect(validadeDaAtestacao(atestacao({ versao: '27.0' }), ambiente)).toEqual({ valida: false, motivo: 'VERSAO_MUDOU' })
    expect(validadeDaAtestacao(atestacao({ configuracao_sha256: 'b'.repeat(64) }), ambiente)).toEqual({ valida: false, motivo: 'CONFIGURACAO_MUDOU' })
  })

  it('a comparacao e por IGUALDADE, e nao por "compativel"', () => {
    // Decidir que a 27.2 herda a prova da 27.1 e a suposicao que o §50 proibe:
    // "material" e uma palavra que quem quer reaproveitar a prova sempre
    // consegue interpretar a seu favor.
    expect(validadeDaAtestacao(atestacao({ versao: '27.1' }), { ...ambiente, versao: '27.2' }).valida).toBe(false)
  })

  it('DECLARADA nao recebe efeito sensivel, e as tres naturezas sao distintas', () => {
    // Um adaptador que responde a um ping pode ainda assim ignorar um
    // cancelamento.
    expect(NATUREZAS).toEqual(['DECLARADA', 'CONTRATO_COM_DOBRO', 'INTEGRACAO_REAL'])
    expect(podeReceberEfeitoSensivel(atestacao({ natureza: 'DECLARADA' }))).toBe(false)
    expect(podeReceberEfeitoSensivel(atestacao({ natureza: 'CONTRATO_COM_DOBRO' }))).toBe(true)
    expect(podeReceberEfeitoSensivel(atestacao({ natureza: 'INTEGRACAO_REAL' }))).toBe(true)
  })

  it('uma atestacao INVALIDA nao vira autorizacao por ser de natureza forte', () => {
    // As duas perguntas sao independentes de proposito: "vale aqui?" e "basta
    // para efeito sensivel?". Uma integracao real provada em OUTRO ambiente
    // continua sendo prova de outro lugar.
    const velha = atestacao({ ambiente: 'host', natureza: 'INTEGRACAO_REAL' })
    expect(podeReceberEfeitoSensivel(velha)).toBe(true)
    expect(validadeDaAtestacao(velha, ambiente).valida).toBe(false)
  })
})
