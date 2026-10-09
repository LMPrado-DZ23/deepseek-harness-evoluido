import ts from 'typescript'
import { t } from './i18n.js'

/**
 * O ESBOÇO: comportamento prometido na tela e não escrito no código.
 *
 * ## O defeito que esta guarda existe para pegar
 *
 * Em 18/09/2026 o `qwen2.5-coder:7b` da máquina do titular produziu, pela
 * primeira vez nesta missão, um jogo da velha que ATRAVESSOU tudo: o JSON foi
 * lido, o schema aprovou, a política de imports aceitou, e o perfil interativo
 * autorizou o clique. O arquivo tinha nove botões, um `onClick` em cada um, um
 * botão de reiniciar e um placar.
 *
 * E o corpo das duas funções que fariam alguma coisa era isto:
 *
 * ```ts
 * const handleClick = (index: number) => {
 *   // Lógica para lidar com o clique na casa
 * }
 * ```
 *
 * Nada no caminho podia recusar isso. Todas as guardas anteriores perguntam "o
 * que este código PODE fazer de errado?", e um corpo vazio não pode fazer nada
 * de errado — é justamente o problema. O aplicativo abre, desenha o tabuleiro,
 * responde ao clique com silêncio, e a pessoa passa a tarde procurando o defeito
 * numa tela que nunca teve comportamento nenhum.
 *
 * ## Por que ela vale só no perfil interativo
 *
 * Uma tela declarativa NÃO TEM função com corpo para preencher: ela é JSX
 * parado, e é assim que ela deve ser. Rodar esta guarda lá recusaria o que já
 * funciona. O perfil interativo é exatamente a promessa de que existe
 * comportamento — e é onde a promessa vazia tem de doer.
 *
 * ## O que ela NÃO é
 *
 * Não é medida de qualidade, e não tenta saber se a lógica está certa. Ela
 * responde UMA pergunta: a função tem corpo? Uma função que calcula errado
 * passa por aqui, e tem de passar: quem confere resultado é o critério de
 * aceitação exercitado no navegador, não a análise estática.
 */

export class EsbocoEncontradoError extends Error {
  readonly code = 'GENERATED_STUB'
  constructor(readonly caminho: string, readonly nomes: readonly string[]) {
    super(t('errors.esbocoEncontrado', { caminho, nomes: nomes.join(', ') }))
  }
}

/** Como uma função aparece quando ela é só promessa. */
export interface FuncaoVazia {
  readonly nome: string
  readonly linha: number
}

function nomeDaFuncao(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText() ?? t('errors.funcaoAnonima')
  const pai = node.parent
  if (pai !== undefined && ts.isVariableDeclaration(pai)) return pai.name.getText()
  if (pai !== undefined && ts.isPropertyAssignment(pai)) return pai.name.getText()
  return t('errors.funcaoAnonima')
}

/**
 * As funções cujo corpo é vazio — ou só comentário.
 *
 * Comentário CONTA como vazio, e essa é a parte que importa: um modelo que não
 * sabe o que escrever escreve `// Lógica para ...`, e um corpo com zero
 * instruções e uma frase em português é indistinguível, em execução, de um
 * corpo com zero instruções.
 *
 * Duas formas NÃO são esboço, e a distinção é deliberada:
 *
 * - `() => {}` passado como argumento (um tratador neutro de propósito, como
 *   `onDismiss={() => {}}`) continua sendo uma decisão de quem escreveu;
 * - uma função com `return` sozinho tem corpo: ela decidiu devolver nada.
 * @param source - o arquivo já analisado.
 * @returns as funções vazias, na ordem em que aparecem.
 */
export function funcoesVazias(source: ts.SourceFile): readonly FuncaoVazia[] {
  const achados: FuncaoVazia[] = []
  const texto = source.getFullText()
  const walk = (node: ts.Node): void => {
    const ehFuncao = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    if (ehFuncao) {
      const corpo = node.body
      if (corpo !== undefined && ts.isBlock(corpo) && corpo.statements.length === 0) {
        /*
          Entre as chaves não há instrução nenhuma. Se houver texto ali, ele é
          comentário — e comentário não roda. Um corpo literalmente vazio, sem
          nem comentário, é a mesma coisa em execução; a diferença entre os dois
          é só quanto de intenção o autor escreveu antes de desistir.
        */
        const dentro = texto.slice(corpo.getStart(source) + 1, corpo.getEnd() - 1)
        const ehArgumento = node.parent !== undefined && ts.isCallExpression(node.parent)
          && node.parent.arguments.includes(node as ts.Expression)
        const comComentario = dentro.trim() !== ''
        // Um `() => {}` cru como argumento é tratador neutro; com comentário
        // dentro, alguém prometeu escrever algo ali e não escreveu.
        if (!ehArgumento || comComentario) {
          achados.push({
            nome: nomeDaFuncao(node),
            linha: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          })
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return achados
}

/**
 * Recusa um arquivo que promete comportamento e não o escreve.
 * @param caminho - o caminho do arquivo gerado.
 * @param source - o arquivo já analisado.
 */
export function assertSemEsboco(caminho: string, source: ts.SourceFile): void {
  const vazias = funcoesVazias(source)
  if (vazias.length === 0) return
  throw new EsbocoEncontradoError(caminho, vazias.map(vazia => t('errors.esbocoLinha', { nome: vazia.nome, linha: String(vazia.linha) })))
}
