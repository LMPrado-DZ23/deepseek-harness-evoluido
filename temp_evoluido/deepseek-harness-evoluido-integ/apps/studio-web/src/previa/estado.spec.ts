import { describe, expect, it } from 'vitest'
import { SEM_APLICATIVO, SITUACOES, situacaoDoPainel, type LeituraDoPainel } from './estado.js'

const previa = (state: LeituraDoPainel['previa'] extends null | infer T ? T extends { state: infer S } ? S : never : never, health: 'PENDING' | 'OK' | 'DOWN' = 'OK') =>
  ({ state, health }) as NonNullable<LeituraDoPainel['previa']>
const execucao = (state: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED', stage = 'generate') => ({ state, stage })

describe('o painel não simula um aplicativo funcionando', () => {
  it('enquanto o modelo escreve, ele mostra PREPARANDO — e nada de quadro', () => {
    const lido = situacaoDoPainel({ previa: null, execucao: execucao('RUNNING', 'generate') })
    expect(lido.situacao).toBe('preparando')
    expect(lido.mostraAplicativo).toBe(false)
  })

  it('enquanto o build roda, ele mostra CONSTRUINDO — que é outra coisa', () => {
    /*
      Colapsar as duas mandaria a pessoa esperar sem saber o que esperar: elas
      falham por motivos diferentes e demoram tempos diferentes.
    */
    for (const etapa of ['build', 'test', 'verify']) {
      expect(situacaoDoPainel({ previa: null, execucao: execucao('RUNNING', etapa) }).situacao).toBe('construindo')
    }
  })

  it('enquanto a prévia sobe, ele mostra INICIANDO', () => {
    for (const estado of ['REQUESTED', 'STARTING'] as const) {
      const lido = situacaoDoPainel({ previa: previa(estado, 'PENDING'), execucao: null })
      expect(lido.situacao).toBe('iniciando')
      expect(lido.mostraAplicativo).toBe(false)
    }
  })

  it('NENHUMA situação de espera desenha o aplicativo — a lista inteira, e não exemplos', () => {
    // Uma situação nova entra numa das duas listas, e não pode ficar de fora
    // das duas por esquecimento.
    expect(SEM_APLICATIVO.every(situacao => SITUACOES.includes(situacao))).toBe(true)
  })
})

describe('a versão anterior nunca é apresentada como a alteração recém-concluída', () => {
  it('com versão pronta e execução NOVA em curso, a situação é ATUALIZANDO e o quadro é o ANTERIOR', () => {
    /*
      Este é o engano mais fácil de cometer aqui e o mais difícil de perceber: a
      pessoa pede uma alteração, vê a tela de antes, e conclui que a alteração
      não fez nada.
    */
    const lido = situacaoDoPainel({ previa: previa('READY'), execucao: execucao('RUNNING', 'build') })
    expect(lido.situacao).toBe('atualizando')
    expect(lido.mostraAplicativo).toBe(true)
    expect(lido.servindoVersaoAnterior).toBe(true)
  })

  it('quando a versão nova FALHA, a anterior pode continuar servida — identificada como anterior', () => {
    const comAnterior = situacaoDoPainel({ previa: previa('FAILED'), execucao: null, anteriorDisponivel: true })
    expect(comAnterior).toMatchObject({ situacao: 'falhou', mostraAplicativo: true, servindoVersaoAnterior: true })
  })

  it('e sem uma anterior, a falha não inventa quadro nenhum', () => {
    const semAnterior = situacaoDoPainel({ previa: previa('FAILED'), execucao: null })
    expect(semAnterior).toMatchObject({ situacao: 'falhou', mostraAplicativo: false, servindoVersaoAnterior: false })
  })

  it('a versão disponível SEM execução nova não é marcada como anterior', () => {
    const lido = situacaoDoPainel({ previa: previa('READY'), execucao: execucao('PASSED') })
    expect(lido).toMatchObject({ situacao: 'disponivel', mostraAplicativo: true, servindoVersaoAnterior: false, aguardando: false })
  })
})

describe('desconectado, expirado e encerrado são três respostas diferentes', () => {
  it('DESCONECTADO não é falhou: o processo pode voltar e o trabalho continua inteiro', () => {
    const lido = situacaoDoPainel({ previa: previa('READY', 'DOWN'), execucao: null })
    expect(lido.situacao).toBe('desconectado')
    // Ainda aguarda: chamar isto de falha mandaria a pessoa recomeçar.
    expect(lido.aguardando).toBe(true)
    expect(lido.mostraAplicativo).toBe(false)
  })

  it('EXPIRADO e ENCERRADO não aguardam nada — eles pedem ação de alguém', () => {
    expect(situacaoDoPainel({ previa: previa('EXPIRED'), execucao: null })).toMatchObject({ situacao: 'expirado', aguardando: false })
    expect(situacaoDoPainel({ previa: previa('STOPPED'), execucao: null })).toMatchObject({ situacao: 'encerrado', aguardando: false })
  })

  it('PARANDO ainda aguarda, porque o estado ainda vai mudar sozinho', () => {
    expect(situacaoDoPainel({ previa: previa('STOPPING'), execucao: null })).toMatchObject({ situacao: 'encerrado', aguardando: true })
  })

  it('execução reprovada, sem orçamento ou bloqueada externamente é FALHOU', () => {
    for (const estado of ['FAILED', 'BUDGET_EXCEEDED', 'BLOCKED_EXTERNAL'] as const) {
      expect(situacaoDoPainel({ previa: null, execucao: execucao(estado, 'build') }).situacao).toBe('falhou')
    }
  })

  it('nada aguarda para sempre: toda situação que aguarda tem de vir de um estado que muda sozinho', () => {
    /*
      Carregamento infinito é o defeito que esta conferência impede. Sem
      execução e sem prévia, não há de que esperar — e o painel diz isso em vez
      de girar.
    */
    expect(situacaoDoPainel({ previa: null, execucao: null })).toMatchObject({ situacao: 'preparando', aguardando: false })
  })
})
