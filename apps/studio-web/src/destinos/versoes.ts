import type { ItemDoAcervo } from './acervo'

/**
 * As VERSÕES de um pacote dentro de uma tarefa — a segunda das seis operações
 * que a Biblioteca declarava não fazer.
 *
 * A escolha foi por PRÉ-REQUISITO, como a prévia antes dela: MEDI o que já
 * existe, e a resposta foi que o motor inteiro já estava gravado. Cada pacote
 * carrega a tentativa que o produziu (`run_id`), o resumo criptográfico do
 * conteúdo (`sha256`), o tamanho, a contagem de arquivos e o instante. Uma
 * tabela nova de versões seria a segunda contabilidade do mesmo fato, e ela
 * divergiria no primeiro pacote gravado por outro caminho.
 *
 * Então versionar aqui é DERIVAR, e não guardar: numerar o que já está lá, na
 * ordem em que aconteceu, e dizer o que mudou de uma para a seguinte.
 *
 * ## Por que a numeração é do MAIS ANTIGO para o mais novo
 *
 * Porque uma versão é um fato do passado, e um número que muda quando chega um
 * pacote novo não serve para conversar: "a versão 2" precisa continuar sendo a
 * mesma coisa amanhã. Numerar de trás para frente faria a versão 1 ser sempre a
 * última — e duas pessoas falando da versão 1 em dias diferentes estariam
 * falando de pacotes diferentes.
 */

/** O que mudou de uma versão para a anterior. */
export interface MudancaDaVersao {
  /** Diferença de tamanho em bytes. Negativa quando encolheu. */
  readonly bytes: number
  /** Diferença na contagem de arquivos. */
  readonly arquivos: number
  /**
   * O conteúdo é BYTE A BYTE o mesmo da versão anterior?
   *
   * Acontece de verdade: duas tentativas que produzem a mesma saída. Dizer
   * "mudou 0 bytes" seria ambíguo — um pacote pode trocar de conteúdo sem mudar
   * de tamanho —, e é o resumo criptográfico que responde isso sem dúvida.
   */
  readonly identico: boolean
}

export interface VersaoDoPacote {
  readonly item: ItemDoAcervo
  /** 1 na primeira, e sempre a anterior mais um. */
  readonly numero: number
  /** É a versão mais recente desta tarefa? */
  readonly vigente: boolean
  /** O que mudou em relação à anterior; `null` na primeira, que não tem anterior. */
  readonly mudanca: MudancaDaVersao | null
}

/**
 * As versões de uma tarefa, da MAIS RECENTE para a mais antiga.
 *
 * A ordem de LEITURA é a inversa da ordem de numeração, e as duas coisas são
 * diferentes de propósito: quem abre a Biblioteca procura o que acabou de sair,
 * e quem cita uma versão precisa de um número que não se mexe.
 *
 * O desempate é pelo identificador do pacote quando o instante é igual. Dois
 * pacotes gravados no mesmo milissegundo existem, e sem desempate a ordem
 * dependeria de como a lista chegou — o que faria a numeração mudar entre duas
 * leituras dos mesmos dados.
 * @param itens - os pacotes de UMA tarefa, em qualquer ordem.
 * @returns as versões numeradas, da mais nova para a mais antiga.
 */
export function versoesDaTarefa(itens: readonly ItemDoAcervo[]): readonly VersaoDoPacote[] {
  const doMaisAntigo = [...itens].sort((esquerda, direita) => {
    const porData = esquerda.registro.created_at.localeCompare(direita.registro.created_at)
    return porData !== 0 ? porData : esquerda.registro.export_id.localeCompare(direita.registro.export_id)
  })
  const versoes = doMaisAntigo.map((item, indice) => {
    const anterior = indice === 0 ? undefined : doMaisAntigo[indice - 1]
    return {
      item,
      numero: indice + 1,
      vigente: indice === doMaisAntigo.length - 1,
      mudanca: anterior === undefined ? null : {
        bytes: item.registro.size_bytes - anterior.registro.size_bytes,
        arquivos: item.registro.entries - anterior.registro.entries,
        identico: item.registro.sha256 === anterior.registro.sha256,
      },
    }
  })
  return versoes.reverse()
}

/**
 * A chave do texto que descreve a mudança de uma versão.
 *
 * A decisão mora aqui, e não no JSX, pela lição de sempre — e porque ela tem
 * uma ordem que diz a intenção: IDÊNTICO vem primeiro. Um pacote byte a byte
 * igual ao anterior tem diferença zero de tamanho e zero de arquivos, e
 * descrevê-lo como "mesmo tamanho" esconderia o fato mais útil, que é a
 * tentativa ter produzido exatamente a mesma coisa.
 *
 * SABOTAGEM QUE SOBREVIVE, DE PROPÓSITO: mover a linha de `identico` para
 * depois das duas de tamanho não quebra teste nenhum, e não quebra porque não
 * PODE quebrar — dois pacotes com o mesmo resumo criptográfico têm
 * necessariamente o mesmo tamanho, então `identico === true` implica
 * `bytes === 0`, e as duas linhas de cima nunca respondem primeiro. A ordem
 * está aqui pela leitura, e não pelo comportamento; escrever um teste que a
 * "cobrisse" exigiria uma entrada impossível — um resumo igual com tamanho
 * diferente —, e um teste de entrada impossível é cobertura fingida.
 * @param mudanca - o que mudou, ou `null` na primeira versão.
 * @returns a chave do catálogo, ou `null` quando não há o que dizer.
 */
export function chaveDaMudanca(mudanca: MudancaDaVersao | null): 'primeira' | 'identica' | 'maior' | 'menor' | 'mesmoTamanho' | null {
  if (mudanca === null) return 'primeira'
  if (mudanca.identico) return 'identica'
  if (mudanca.bytes > 0) return 'maior'
  if (mudanca.bytes < 0) return 'menor'
  return 'mesmoTamanho'
}

/**
 * Quantas versões DISTINTAS de conteúdo esta tarefa produziu.
 *
 * Distintas por resumo criptográfico, e não pela contagem de pacotes: duas
 * tentativas que devolveram a mesma saída produziram uma versão só do produto,
 * ainda que sejam dois arquivos no disco. É esse número que responde "quantas
 * vezes isto realmente mudou".
 * @param versoes - as versões da tarefa.
 * @returns quantos conteúdos diferentes existem.
 */
export function conteudosDistintos(versoes: readonly VersaoDoPacote[]): number {
  return new Set(versoes.map(versao => versao.item.registro.sha256)).size
}
