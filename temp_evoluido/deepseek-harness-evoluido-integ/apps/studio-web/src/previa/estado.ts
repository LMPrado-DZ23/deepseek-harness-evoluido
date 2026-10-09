/**
 * O ESTADO HONESTO do painel de prévia.
 *
 * ## Por que ele não mora no JSX
 *
 * A lição mais repetida deste repositório: se a decisão importa, ela não mora
 * na montagem. Este módulo decide o que a pessoa vê quando a construção ainda
 * não terminou, quando a prévia caiu, quando chegou versão nova e quando a
 * versão nova falhou — e cada uma dessas respostas é uma afirmação sobre o que
 * o produto está fazendo. Uma afirmação dentro de um ternário de JSX não é
 * exercitada por teste nenhum.
 *
 * ## A regra que atravessa o arquivo inteiro
 *
 * **Ausência de prova nunca vira prova.** O painel não desenha um aplicativo
 * funcionando enquanto não houver uma versão executável autorizada; ele mostra
 * a PREPARAÇÃO, com o nome do que está acontecendo. Não há porcentagem
 * inventada e não há carregamento infinito: todo estado que não é terminal diz
 * de que ele está esperando, e todo estado terminal diz qual é a próxima ação.
 */

/** Os estados canônicos da prévia, como o servidor os grava. */
export const ESTADOS_DE_PREVIA = ['REQUESTED', 'STARTING', 'READY', 'STOPPING', 'STOPPED', 'FAILED', 'EXPIRED'] as const
export type EstadoDePrevia = typeof ESTADOS_DE_PREVIA[number]

/** A saúde que o batimento reporta. */
export type SaudeDePrevia = 'PENDING' | 'OK' | 'DOWN'

/** O estado da execução que produz a versão. */
export type EstadoDeExecucao = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'

/**
 * O que o painel MOSTRA. Nove situações, e nenhuma delas é "carregando".
 *
 * `preparando` e `construindo` são diferentes de propósito: a primeira é o
 * modelo escrevendo, a segunda é o build rodando, e elas falham por motivos
 * diferentes e por tempos diferentes. Colapsá-las mandaria a pessoa esperar sem
 * saber o que esperar.
 *
 * `atualizando` só existe quando havia uma versão ANTERIOR disponível: é a
 * troca controlada, e é o único estado em que o painel pode continuar servindo
 * conteúdo enquanto algo novo é preparado.
 */
export const SITUACOES = [
  'preparando', 'construindo', 'iniciando', 'disponivel',
  'atualizando', 'falhou', 'desconectado', 'expirado', 'encerrado',
] as const
export type Situacao = typeof SITUACOES[number]

/** O que o painel sabe no momento de decidir. */
export interface LeituraDoPainel {
  /** O registro da prévia, quando existe um. */
  readonly previa: { readonly state: EstadoDePrevia; readonly health: SaudeDePrevia } | null
  /** A execução corrente, quando há uma. */
  readonly execucao: { readonly state: EstadoDeExecucao; readonly stage: string } | null
  /** Se uma versão anterior continua servida e utilizável. */
  readonly anteriorDisponivel?: boolean
}

/** O que o painel decidiu mostrar. */
export interface SituacaoDoPainel {
  readonly situacao: Situacao
  /** Se o quadro do aplicativo pode ser desenhado agora. */
  readonly mostraAplicativo: boolean
  /**
   * Se o que está no quadro é a versão ANTERIOR, e não a recém-concluída.
   *
   * Isto precisa viajar até a tela. Apresentar a versão anterior como se fosse
   * a alteração que a pessoa acabou de pedir é a mentira mais fácil de contar
   * aqui, e a mais difícil de perceber: a tela parece certa.
   */
  readonly servindoVersaoAnterior: boolean
  /** Se a situação ainda pode mudar sozinha. Falso pede ação de alguém. */
  readonly aguardando: boolean
}

/**
 * A situação do painel, a partir do que o servidor disse.
 *
 * A ordem das perguntas é a ordem da VERDADE, e não a das telas: a prévia
 * pronta ganha de tudo, porque ela é a única evidência direta de que existe um
 * aplicativo executando; depois vêm os estados terminais dela, que são fatos
 * consumados; e só então o painel olha para a execução, que é o que ainda está
 * acontecendo.
 * @param leitura - o registro da prévia, a execução e se há versão anterior.
 * @returns a situação, se desenha o aplicativo, se ela é a anterior e se ainda espera.
 */
export function situacaoDoPainel(leitura: LeituraDoPainel): SituacaoDoPainel {
  const { previa, execucao } = leitura
  const anterior = leitura.anteriorDisponivel === true
  const executando = execucao !== null && (execucao.state === 'PENDING' || execucao.state === 'RUNNING')

  if (previa !== null && previa.state === 'READY') {
    /*
      Prévia pronta e execução NOVA em curso: a versão que está no quadro é a
      anterior, e o painel tem de dizer isso. Sem esta linha, a pessoa pede uma
      alteração, vê a tela de antes e conclui que a alteração não fez nada.
    */
    if (executando) return { situacao: 'atualizando', mostraAplicativo: true, servindoVersaoAnterior: true, aguardando: true }
    if (previa.health === 'DOWN') {
      // Desconectado NÃO é falhou: o processo pode voltar, e o trabalho
      // continua inteiro. Chamar isto de falha mandaria a pessoa recomeçar.
      return { situacao: 'desconectado', mostraAplicativo: false, servindoVersaoAnterior: false, aguardando: true }
    }
    return { situacao: 'disponivel', mostraAplicativo: true, servindoVersaoAnterior: false, aguardando: false }
  }

  if (previa !== null && previa.state === 'FAILED') {
    // A versão anterior pode continuar servida quando isso for tecnicamente
    // possível — identificada como anterior, nunca como a recém-concluída.
    return { situacao: 'falhou', mostraAplicativo: anterior, servindoVersaoAnterior: anterior, aguardando: false }
  }
  if (previa !== null && previa.state === 'EXPIRED') {
    return { situacao: 'expirado', mostraAplicativo: false, servindoVersaoAnterior: false, aguardando: false }
  }
  if (previa !== null && (previa.state === 'STOPPED' || previa.state === 'STOPPING')) {
    return { situacao: 'encerrado', mostraAplicativo: false, servindoVersaoAnterior: false, aguardando: previa.state === 'STOPPING' }
  }
  if (previa !== null && (previa.state === 'STARTING' || previa.state === 'REQUESTED')) {
    return { situacao: 'iniciando', mostraAplicativo: false, servindoVersaoAnterior: false, aguardando: true }
  }

  if (execucao !== null && (execucao.state === 'FAILED' || execucao.state === 'BUDGET_EXCEEDED' || execucao.state === 'BLOCKED_EXTERNAL')) {
    return { situacao: 'falhou', mostraAplicativo: anterior, servindoVersaoAnterior: anterior, aguardando: false }
  }
  if (execucao !== null && execucao.state === 'CANCELLED') {
    return { situacao: 'encerrado', mostraAplicativo: anterior, servindoVersaoAnterior: anterior, aguardando: false }
  }
  if (executando) {
    /*
      A ETAPA separa preparar de construir. O modelo escrevendo e o build
      rodando falham por motivos diferentes e demoram tempos diferentes;
      colapsá-los mandaria a pessoa esperar sem saber o que esperar.
    */
    const construindo = execucao.stage === 'build' || execucao.stage === 'test' || execucao.stage === 'verify'
    return { situacao: construindo ? 'construindo' : 'preparando', mostraAplicativo: false, servindoVersaoAnterior: false, aguardando: true }
  }
  return { situacao: 'preparando', mostraAplicativo: false, servindoVersaoAnterior: false, aguardando: execucao !== null }
}

/**
 * As situações em que o painel NUNCA desenha o aplicativo.
 *
 * Exportada para o teste poder varrer a lista inteira em vez de escolher
 * exemplos: uma situação nova entra aqui ou entra na outra lista, e não pode
 * entrar em nenhuma por esquecimento.
 */
export const SEM_APLICATIVO: readonly Situacao[] = ['preparando', 'construindo', 'iniciando', 'desconectado', 'expirado']
