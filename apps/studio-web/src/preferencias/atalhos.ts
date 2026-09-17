/**
 * Os ATALHOS DE TECLADO do Studio — a lista e a decisão de quando cada um vale.
 *
 * Esta seção das Preferências era uma pendência que dizia "não há atalhos". A
 * medição mostrou que a frase estava quase certa e quase errada ao mesmo tempo:
 * havia `Esc` em três lugares, e nenhum lugar que dissesse isso a quem usa. Um
 * atalho que ninguém sabe que existe não é um atalho.
 *
 * E listar os três não fecharia o requisito — "informar a pendência não
 * substitui implementar a capacidade". Então a fatia acrescenta o atalho que
 * falta de verdade no produto: **enviar sem tirar a mão do teclado**.
 *
 * ## Por que `Ctrl+Enter`, e não `Enter`
 *
 * O compositor é uma caixa de texto de várias linhas, e `Enter` sozinho quebra
 * linha — é o que a pessoa espera dele em qualquer lugar. Sequestrá-lo faria
 * quem escreve dois parágrafos enviar o primeiro sem querer, e não há desfazer
 * para uma tarefa criada. `Ctrl+Enter` (e `Cmd+Enter` no Mac) é a convenção que
 * as ferramentas de texto usam exatamente por isso.
 */

/** Uma tecla observada, no pouco que a decisão precisa saber. */
export interface TeclaObservada {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/** Um atalho, como a tela o lista. */
export interface Atalho {
  readonly id: string
  /** As teclas, já na ordem em que se escreve. */
  readonly teclas: readonly string[]
  /** Onde ele vale: em toda parte, ou só dentro do compositor. */
  readonly escopo: 'global' | 'compositor'
}

/**
 * Os atalhos que o produto TEM. Não há nenhum aqui que não exista no código.
 *
 * A lista é a fonte da tela, e a tela não escreve atalho à mão: um atalho
 * listado e não implementado é o botão mudo da decisão do proprietário, com
 * outra forma.
 * @returns os atalhos, na ordem em que a tela os mostra.
 */
export function atalhosDoStudio(): readonly Atalho[] {
  return [
    { id: 'enviar', teclas: ['Ctrl', 'Enter'], escopo: 'compositor' },
    { id: 'quebrarLinha', teclas: ['Enter'], escopo: 'compositor' },
    { id: 'fechar', teclas: ['Esc'], escopo: 'global' },
  ]
}

/**
 * Esta tecla pede ENVIO?
 *
 * `Ctrl` ou `Cmd` — a segunda porque no Mac é ela que ocupa o lugar do
 * primeiro, e exigir `Ctrl` lá faria o atalho existir só para metade das
 * pessoas.
 *
 * `Shift+Ctrl+Enter` e `Alt+Ctrl+Enter` NÃO enviam: combinações com modificador
 * a mais são de outras ferramentas e do sistema, e engoli-las faria o Studio
 * responder no lugar de quem deveria.
 * @param tecla - o que o navegador reportou.
 * @returns `true` quando o envio deve acontecer.
 */
export function pedeEnvio(tecla: TeclaObservada): boolean {
  if (tecla.key !== 'Enter') return false
  if (tecla.shiftKey || tecla.altKey) return false
  return tecla.ctrlKey || tecla.metaKey
}

/**
 * O envio pode acontecer AGORA?
 *
 * O atalho não é uma segunda porta: ele passa pela MESMA condição do botão. Sem
 * isto, o teclado enviaria o que o botão recusa — e a recusa do botão é onde
 * moram as regras de "tem texto", "a rota permite" e "já está enviando".
 * @param tecla - o que o navegador reportou.
 * @param podeEnviar - a mesma condição que habilita o botão.
 * @returns `true` quando o atalho deve disparar o envio.
 */
export function atalhoEnvia(tecla: TeclaObservada, podeEnviar: boolean): boolean {
  return podeEnviar && pedeEnvio(tecla)
}
