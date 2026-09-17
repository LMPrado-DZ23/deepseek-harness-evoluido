/**
 * Para onde vai o que a pessoa escreve no compositor inferior.
 *
 * Este arquivo existe por causa de uma frase da decisão de produto: "Pedir uma
 * alteração continua na MESMA tarefa e no MESMO projeto; não recomeça um
 * wizard." Na tela antiga não havia onde escrever depois do resultado — a única
 * caixa de texto do produto era a da home, e usá-la criava outra tarefa. O
 * defeito não estava no texto do botão: estava em não existir decisão nenhuma
 * sobre o que "enviar" significa quando já há uma tarefa aberta.
 *
 * A decisão é por ESTADO da tarefa, e não por qual tela está montada, porque
 * era a tela que definia isso antes e foi assim que "continuar" virou "começar
 * de novo". Uma função pura também deixa a regra falsificável: dá para provar
 * que nenhum estado devolve "criar outra tarefa".
 */

/** O que o envio faz. Nenhum destino sai da tarefa aberta. */
export type Destino =
  /** Responder a pergunta de admissão que está aberta. */
  | { readonly tipo: 'responder'; readonly perguntaId: string }
  /** Pedir mudança no plano proposto — mesma tarefa, revisão nova. */
  | { readonly tipo: 'mudar-plano' }
  /**
   * Pedir um ajuste depois de um resultado. Continua na mesma tarefa: o texto
   * vira pedido de mudança sobre o plano vigente, e a tentativa seguinte é
   * outra tentativa DESTA tarefa, com o histórico inteiro no lugar.
   */
  | { readonly tipo: 'ajustar' }
  /** Há trabalho em curso: o texto fica guardado e o envio espera. */
  | { readonly tipo: 'aguardar'; readonly motivo: 'execucao' | 'aprovacao' }
  /** Não há tarefa aberta: é a home, e o envio cria ou recupera uma. */
  | { readonly tipo: 'abrir-tarefa' }

export interface SituacaoDaTarefa {
  /** O estado do projeto, ou `null` quando nenhuma tarefa está aberta. */
  readonly estado: string | null
  /** A pergunta de admissão sem resposta, quando existe uma. */
  readonly perguntaAberta: string | null
}

/**
 * Estados em que uma tentativa está correndo. Enviar durante uma tentativa não
 * pode disparar outra: o pedido de mudança concorreria com a execução e o
 * orçamento seria gasto duas vezes pela mesma intenção.
 */
const EM_EXECUCAO = new Set(['GENERATING', 'BUILD_OK', 'TESTS_OK'])

/**
 * O destino do envio, dada a situação da tarefa.
 *
 * @param situacao - o estado da tarefa e a pergunta aberta, se houver.
 * @returns o destino; `abrir-tarefa` SOMENTE quando não há tarefa aberta.
 */
export function destinoDoEnvio(situacao: SituacaoDaTarefa): Destino {
  if (situacao.estado === null) return { tipo: 'abrir-tarefa' }
  // A pergunta aberta vence o estado: ela é o que está esperando resposta, e
  // ignorá-la faria o texto da pessoa virar pedido de mudança num plano que
  // ainda não existe.
  if (situacao.perguntaAberta !== null) return { tipo: 'responder', perguntaId: situacao.perguntaAberta }
  if (EM_EXECUCAO.has(situacao.estado)) return { tipo: 'aguardar', motivo: 'execucao' }
  if (situacao.estado === 'PLAN_PROPOSED') return { tipo: 'mudar-plano' }
  if (situacao.estado === 'PLAN_APPROVED') return { tipo: 'aguardar', motivo: 'aprovacao' }
  return { tipo: 'ajustar' }
}

/**
 * Se o envio está disponível agora.
 *
 * Separado de `destinoDoEnvio` porque as duas perguntas são diferentes: mesmo
 * quando o destino existe, o texto vazio não é um envio. O compositor continua
 * habilitado enquanto espera — o rascunho é preservado, que é o que a decisão
 * pede ao falar em "fechar retorna à conversa com rascunho preservado".
 * @param destino - o destino calculado.
 * @param texto - o que está escrito no compositor.
 * @returns `true` quando enviar produz efeito.
 */
export function envioDisponivel(destino: Destino, texto: string): boolean {
  if (texto.trim() === '') return false
  return destino.tipo !== 'aguardar'
}
