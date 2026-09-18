/**
 * O LAYOUT do painel: dividido, expandido ou fechado — e o que cada um preserva.
 *
 * ## As três operações que as pessoas confundem, e o produto não pode confundir
 *
 * Fechar o painel, parar a prévia e cancelar a tarefa são TRÊS coisas, com três
 * efeitos diferentes e três desfazeres diferentes:
 *
 * | ação | o que ela desfaz | o que continua |
 * | --- | --- | --- |
 * | fechar o painel | só a visão | a construção, a prévia, a conversa |
 * | parar a prévia | o processo servido | a tarefa, o histórico, os arquivos |
 * | cancelar a tarefa | a construção | nada dela; é a única destrutiva |
 *
 * Este módulo garante a primeira linha por construção: o layout não tem como
 * encostar em execução nem em prévia, porque ele não recebe nenhuma das duas.
 * É uma garantia estrutural, e é por isso que ela cabe num teste curto.
 */

/** Como o painel está disposto. */
export const MODOS = ['fechado', 'dividido', 'expandido'] as const
export type Modo = typeof MODOS[number]

/** O tamanho da tela que a prévia finge, e que ela realmente aplica. */
export const VIEWPORTS = ['desktop', 'celular'] as const
export type Viewport = typeof VIEWPORTS[number]

/** A largura, em pixels CSS, que cada viewport aplica ao quadro. */
export const LARGURA_DO_VIEWPORT: Readonly<Record<Viewport, number | null>> = {
  // `null` é "ocupe o que houver": o desktop não tem largura fixa, e fingir uma
  // faria a prévia mentir sobre o espaço que o aplicativo realmente tem.
  desktop: null,
  celular: 390,
}

/**
 * Os limites da divisão, em fração da largura.
 *
 * Eles não são estéticos. Abaixo de `MINIMO_DA_CONVERSA` o compositor deixa de
 * caber e a conversa vira uma coluna de palavras quebradas; acima de
 * `MAXIMO_DA_PREVIA` o quadro do aplicativo fica menor que o menor aparelho que
 * ele diz emular, e a prévia passa a mostrar uma coisa que ninguém veria.
 */
export const MINIMO_DA_CONVERSA = 0.3
export const MAXIMO_DA_PREVIA = 0.7
export const DIVISAO_PADRAO = 0.45

/**
 * A fração de largura da prévia, dentro dos limites úteis.
 * @param pedida - a fração que o arrasto pediu.
 * @returns a fração aplicada.
 */
export function divisaoUtil(pedida: number): number {
  if (!Number.isFinite(pedida)) return DIVISAO_PADRAO
  return Math.min(MAXIMO_DA_PREVIA, Math.max(MINIMO_DA_CONVERSA, pedida))
}

/** O que sobrevive a qualquer mudança de layout. */
export interface EstadoPreservado {
  readonly tarefaId: string | null
  readonly rascunho: string
  readonly posicaoDeLeitura: number
  readonly divisao: number
  readonly viewport: Viewport
}

export interface EstadoDoPainel extends EstadoPreservado {
  readonly modo: Modo
}

export type AcaoDeLayout =
  | { readonly tipo: 'abrir' }
  | { readonly tipo: 'fechar' }
  | { readonly tipo: 'expandir' }
  | { readonly tipo: 'restaurar' }
  | { readonly tipo: 'alternar' }
  | { readonly tipo: 'redimensionar'; readonly divisao: number }
  | { readonly tipo: 'viewport'; readonly viewport: Viewport }

/**
 * O próximo estado do painel.
 *
 * A função é TOTAL sobre a identidade da tarefa, o rascunho e a posição de
 * leitura: nenhuma ação de layout os toca, e isso é conferido varrendo todas as
 * ações em vez de escolher algumas. Perder o rascunho ao expandir o painel é o
 * defeito que esta forma impede de existir.
 * @param estado - o estado atual.
 * @param acao - o que a pessoa fez.
 * @returns o estado seguinte.
 */
export function proximoLayout(estado: EstadoDoPainel, acao: AcaoDeLayout): EstadoDoPainel {
  switch (acao.tipo) {
    case 'abrir':
      // Reabrir devolve o modo DIVIDIDO, e não o expandido de antes: expandir é
      // um pedido momentâneo, e herdá-lo esconderia a conversa de quem só
      // quis ver o aplicativo de novo.
      return { ...estado, modo: 'dividido' }
    case 'fechar':
      return { ...estado, modo: 'fechado' }
    case 'expandir':
      return { ...estado, modo: 'expandido' }
    case 'restaurar':
      return { ...estado, modo: 'dividido' }
    case 'alternar':
      return { ...estado, modo: estado.modo === 'fechado' ? 'dividido' : 'fechado' }
    case 'redimensionar':
      return { ...estado, divisao: divisaoUtil(acao.divisao) }
    case 'viewport':
      return { ...estado, viewport: acao.viewport }
  }
}

/** Quanto uma seta move o divisor. */
export const PASSO_DO_DIVISOR = 0.05

/**
 * O passo que uma tecla pede ao divisor.
 *
 * Existe como função exportada porque arrastar NÃO pode ser a única forma de
 * mexer no divisor — quem navega por teclado não arrasta —, e porque uma
 * decisão dentro de um `onKeyDown` não é exercitada por teste nenhum: a
 * sabotagem que zerou o passo SOBREVIVEU enquanto ele morava lá.
 * @param tecla - o valor de `event.key`.
 * @returns o passo, ou zero quando a tecla não é de redimensionar.
 */
export function passoDoDivisor(tecla: string): number {
  if (tecla === 'ArrowLeft') return -PASSO_DO_DIVISOR
  if (tecla === 'ArrowRight') return PASSO_DO_DIVISOR
  return 0
}

/**
 * No CELULAR não há divisão: há troca.
 *
 * Espremer três colunas num aparelho de 390 pontos produz uma conversa
 * ilegível ao lado de uma prévia ilegível. A alternância mostra uma das duas
 * por inteiro, e o compositor continua alcançável — ele não pode ficar atrás de
 * um painel nem do teclado.
 */
export type FaceNoCelular = 'conversa' | 'previa'

/**
 * Qual face o celular mostra, a partir do modo do painel.
 * @param modo - o modo do painel.
 * @returns a face visível.
 */
export function faceNoCelular(modo: Modo): FaceNoCelular {
  return modo === 'fechado' ? 'conversa' : 'previa'
}
