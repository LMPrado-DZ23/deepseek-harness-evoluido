/**
 * As ABAS do painel, e o que cada uma diz quando não tem o que mostrar.
 *
 * ## A regra que este arquivo aplica
 *
 * Um controle indisponível EXPLICA a dependência; ele não fica mudo e não some.
 * Sumir faz a pessoa procurar o que não existe; ficar mudo faz ela clicar e não
 * acontecer nada, que é pior — ela conclui que o produto quebrou.
 *
 * E o contrário também vale, e é o erro mais tentador: uma aba que aparece
 * habilitada e mostra uma lista vazia AFIRMA que não há arquivos, que não houve
 * teste, que não existe histórico. `NÃO OBSERVADO` e `vazio` são respostas
 * diferentes, e colapsá-las manda a pessoa consertar o que talvez esteja certo.
 *
 * ## Por que isto não mora no componente
 *
 * Porque "esta aba existe?" e "por que ela não dá para abrir?" são afirmações
 * sobre o estado do produto, e afirmação dentro de um ternário de JSX não é
 * exercitada por teste nenhum. É a lição mais repetida deste repositório.
 */

export const ABAS = ['previa', 'arquivos', 'testes', 'historico'] as const
export type Aba = typeof ABAS[number]

/** O que o painel sabe para decidir as abas. */
export interface LeituraDasAbas {
  /** Se existe uma prévia servida agora. */
  readonly temPrevia: boolean
  /** Quantos arquivos o relato da tentativa mais recente declara. */
  readonly arquivos: number
  /** Quantas etapas de teste o relato traz. */
  readonly etapas: number
  /** Quantos pontos de retomada existem. */
  readonly checkpoints: number
  /** Se o relato foi LIDO. Falso é "ainda não sei", e não "não tem nada". */
  readonly relatoLido: boolean
}

export type MotivoIndisponivel =
  /** O relato ainda não chegou: não dá para afirmar nem que tem nem que não tem. */
  | 'SEM_RELATO'
  /** O relato chegou e está vazio de verdade. */
  | 'VAZIO'
  /** Não há prévia servida agora. */
  | 'SEM_PREVIA'

export interface EstadoDaAba {
  readonly aba: Aba
  readonly disponivel: boolean
  /** Por que não dá para abrir. `null` quando dá. */
  readonly motivo: MotivoIndisponivel | null
}

/**
 * O estado de cada aba, na ordem em que elas aparecem.
 *
 * A lista é SEMPRE completa: nenhuma aba some. Some faz a pessoa procurar o que
 * não existe — e, pior, faz a barra de abas mudar de tamanho enquanto a
 * construção anda, o que move o alvo do clique debaixo do dedo dela.
 * @param leitura - o que o painel sabe.
 * @returns o estado de cada aba.
 */
export function abasDoPainel(leitura: LeituraDasAbas): readonly EstadoDaAba[] {
  const porRelato = (quantos: number): MotivoIndisponivel | null => {
    // A ORDEM importa: "ainda não sei" vem antes de "está vazio". Afirmar vazio
    // sem ter lido é inventar um fato sobre o trabalho da pessoa.
    if (!leitura.relatoLido) return 'SEM_RELATO'
    return quantos === 0 ? 'VAZIO' : null
  }
  const semDisponivel: readonly Omit<EstadoDaAba, 'disponivel'>[] = [
    { aba: 'previa', motivo: leitura.temPrevia ? null : 'SEM_PREVIA' },
    { aba: 'arquivos', motivo: porRelato(leitura.arquivos) },
    { aba: 'testes', motivo: porRelato(leitura.etapas) },
    // O histórico não sai do relato de UMA tentativa: ele é a lista de pontos
    // de retomada, que existe mesmo quando a tentativa corrente não gravou nada.
    { aba: 'historico', motivo: leitura.checkpoints === 0 ? 'VAZIO' : null },
  ]
  return semDisponivel.map(item => ({ ...item, disponivel: item.motivo === null }))
}

/**
 * A aba que abre, dada a que a pessoa escolheu.
 *
 * Escolher uma aba que ficou indisponível não joga a pessoa para outra em
 * silêncio: ela continua onde estava, vendo por que aquilo não dá para abrir.
 * Trocar por baixo é como se perde o lugar numa tela que muda sozinha enquanto
 * a construção anda.
 * @param estados - as abas.
 * @param escolhida - a aba que a pessoa escolheu.
 * @returns a aba a mostrar.
 */
export function abaEfetiva(estados: readonly EstadoDaAba[], escolhida: Aba): Aba {
  return estados.some(estado => estado.aba === escolhida) ? escolhida : 'previa'
}
