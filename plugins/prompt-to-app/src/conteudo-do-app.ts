import { GeneratedFileRejectedError, type GeneratedFile } from './generator.js'
import { t } from './i18n.js'

/** O único arquivo de conteúdo que o gerador pode escrever. */
export const CAMINHO_DO_CONTEUDO = 'content/app.json'

/**
 * O que o template EXIGE de `content/app.json`: um objeto JSON com `title`.
 *
 * O `app/layout.tsx` do template importa o arquivo e lê `appContent.title`
 * para o texto alternativo do logotipo. O TypeScript tipa a importação pelo
 * conteúdo que o modelo escreveu: sem `title`, o `next build` para em TS2339.
 * Medido em 19/09/2026 com o qwen2.5-coder:7b: o contador de copos COMPILOU
 * (a diretiva completada funcionou) e morreu na checagem de tipos porque o
 * conteúdo era `{"meta_copos": 8}`.
 *
 * Um valor que não é objeto é recusado com a causa exata, e volta ao modelo
 * como reparo: sem objeto não há onde pôr o título sem inventar o conteúdo.
 * @param files - os arquivos da resposta.
 */
export function assertConteudoDoApp(files: readonly GeneratedFile[]): void {
  const arquivo = files.find(file => file.path.replaceAll('\\', '/') === CAMINHO_DO_CONTEUDO)
  if (arquivo === undefined) return
  if (objetoDoConteudo(arquivo.content) === undefined) throw new GeneratedFileRejectedError(t('errors.generatedContentShape', { path: CAMINHO_DO_CONTEUDO }))
}

/**
 * COMPLETA o `title` que falta, com o nome da primeira página da especificação.
 *
 * Como a diretiva de cliente, o título é exigência do TEMPLATE, não decisão do
 * aplicativo: o modelo não escolheu deixar o logotipo sem nome, ele só não sabia
 * que o layout lê esse campo. As outras chaves que o modelo escreveu ficam como
 * estão, na ordem dele. JSON não tem comentário, então a autoria não fica no
 * arquivo: LIMITE DECLARADO — quem lê só o `app.json` não sabe que o `title`
 * veio do FRIGG. Um `title` que existe e é texto nunca é trocado.
 * @param files - os arquivos da resposta.
 * @param tituloPadrao - o título a usar quando falta.
 * @returns os arquivos, com o título onde ele faltava.
 */
export function completarTituloDoConteudo(files: readonly GeneratedFile[], tituloPadrao: string): readonly GeneratedFile[] {
  return files.map(file => {
    if (file.path.replaceAll('\\', '/') !== CAMINHO_DO_CONTEUDO) return file
    const objeto = objetoDoConteudo(file.content)
    if (objeto === undefined) return file
    if (typeof objeto.title === 'string' && objeto.title.trim() !== '') return file
    // `title` entra PRIMEIRO e é reafirmado no fim: a ordem das chaves segue a
    // primeira inserção, e um `title` não textual do modelo não sobrevive.
    return { ...file, content: `${JSON.stringify(Object.assign({ title: tituloPadrao }, objeto, { title: tituloPadrao }), null, 2)}\n` }
  })
}

function objetoDoConteudo(content: string): Record<string, unknown> | undefined {
  let valor: unknown
  try {
    valor = JSON.parse(content)
  } catch {
    // Texto que não é JSON: quem responde é o chamador, recusando ou deixando
    // o arquivo como veio. Nenhum outro erro sai de `JSON.parse`.
    return undefined
  }
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? valor as Record<string, unknown> : undefined
}
