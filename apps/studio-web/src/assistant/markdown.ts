/**
 * O pedaço de Markdown que uma resposta de assistente realmente usa, lido para
 * uma árvore de blocos — sem HTML, sem biblioteca, sem `dangerouslySetInnerHTML`.
 *
 * Por que escrever isto em vez de usar um renderizador pronto: o texto vem de um
 * MODELO. Qualquer caminho que aceite HTML cru transforma "o assistente
 * respondeu" em "o assistente escreveu a página" — e a maioria dos
 * renderizadores prontos aceita HTML por padrão, ou o desliga por opção que
 * alguém pode remover sem perceber. Aqui não existe passagem de HTML para
 * desligar: o resultado é uma árvore de dados, e quem desenha só sabe criar
 * elementos React. Marcação que este leitor não conhece vira TEXTO, nunca
 * marcação.
 *
 * Até aqui a conversa renderizava `<p>{texto}</p>`: quem pedisse um passo a
 * passo recebia uma parede com asteriscos, e um trecho de código vinha
 * embaralhado no meio do parágrafo.
 */

/** Um pedaço de texto dentro de um bloco. */
export type MarkdownInline =
  | { readonly kind: 'text', readonly text: string }
  | { readonly kind: 'code', readonly text: string }
  | { readonly kind: 'strong', readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'em', readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'link', readonly href: string, readonly children: readonly MarkdownInline[] }

export type MarkdownBlock =
  | { readonly kind: 'paragraph', readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'heading', readonly level: 1 | 2 | 3, readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'code', readonly language: string | null, readonly text: string }
  | { readonly kind: 'list', readonly ordered: boolean, readonly items: readonly (readonly MarkdownInline[])[] }
  | { readonly kind: 'quote', readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'rule' }

/**
 * Tamanho máximo do texto que este leitor aceita interpretar, em caracteres.
 *
 * Acima disso a mensagem é mostrada como texto puro. Um leitor recursivo sobre
 * uma resposta muito grande é tempo de CPU na aba de quem lê, e travar a página
 * de quem está conversando é pior que mostrar asteriscos.
 */
export const MARKDOWN_MAX_CHARS = 128 * 1024

/** Só estes esquemas viram link. O resto vira o texto que o modelo escreveu. */
const SAFE_SCHEME = /^https?:\/\//iu

/**
 * O nome de linguagem que a cerca declara.
 *
 * Aceito bem estreito de propósito: ele vira uma CLASSE no HTML, e um texto
 * arbitrário vindo do modelo dentro de um atributo de classe é superfície que
 * não precisa existir.
 */
const LANGUAGE = /^[A-Za-z0-9_+-]{1,24}$/u

// A cerca aceita QUALQUER texto depois do marcador. Recusar a linha inteira
// por causa de um nome de linguagem estranho faria o bloco deixar de ser
// código - e o exemplo sairia deformado, que é o defeito que este leitor
// existe para não ter. O nome é validado depois, e vira `null` quando não
// serve.
const FENCE = /^\s{0,3}(`{3,}|~{3,})[ \t]*(.*)$/u
const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/u
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/u
const QUOTE = /^\s{0,3}>\s?(.*)$/u

/**
 * Lê o texto para blocos.
 *
 * As cercas de código são resolvidas ANTES de tudo: um exemplo de código que
 * contenha `**` ou `#` não pode virar negrito nem título. Era esse o erro que
 * fazia um trecho de programa chegar deformado a quem pediu para ver o código.
 * @param source - o texto da mensagem.
 * @returns os blocos, na ordem em que aparecem.
 */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  if (source.length > MARKDOWN_MAX_CHARS) {
    return [{ kind: 'paragraph', children: [{ kind: 'text', text: source }] }]
  }
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const language = LANGUAGE.test((fence[2] ?? '').trim()) ? fence[2]!.trim() : null
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index]!
        const closing = FENCE.exec(candidate)
        // Fecha só com o MESMO caractere e pelo menos o mesmo comprimento, para
        // que ``` dentro de um bloco ~~~ não corte o exemplo ao meio.
        if (closing !== null && closing[1]!.startsWith(marker[0]!) && closing[1]!.length >= marker.length) {
          index += 1
          break
        }
        body.push(candidate)
        index += 1
      }
      // Uma cerca que a resposta abriu e não fechou ainda é código: mostrar o
      // resto da mensagem como parágrafo entregaria o programa deformado.
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }
    if (line.trim() === '') { index += 1; continue }
    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        children: parseInline(heading[2]!.trim()),
      })
      index += 1
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      const body: string[] = []
      while (index < lines.length) {
        const current = QUOTE.exec(lines[index]!)
        if (current === null) break
        body.push(current[1]!)
        index += 1
      }
      blocks.push({ kind: 'quote', children: parseInline(body.join(' ').trim()) })
      continue
    }
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet !== null || ordered !== null) {
      const isOrdered = bullet === null
      const items: (readonly MarkdownInline[])[] = []
      while (index < lines.length) {
        const current = isOrdered ? ORDERED.exec(lines[index]!) : BULLET.exec(lines[index]!)
        if (current === null) break
        items.push(parseInline(current[1]!.trim()))
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index]!
      if (current.trim() === '' || FENCE.test(current) || HEADING.test(current) || RULE.test(current)
        || BULLET.test(current) || ORDERED.test(current) || QUOTE.test(current)) break
      paragraph.push(current.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) })
  }
  return blocks
}

/**
 * Lê a marcação de dentro de uma linha.
 *
 * O código entre crases é resolvido primeiro e o conteúdo dele NUNCA é
 * reinterpretado: `**` dentro de um trecho de código é o que a pessoa escreveu.
 * @param source - o texto de um bloco.
 * @returns os pedaços, na ordem.
 */
export function parseInline(source: string): readonly MarkdownInline[] {
  const parts: MarkdownInline[] = []
  let text = ''
  const flush = (): void => {
    if (text !== '') { parts.push({ kind: 'text', text }); text = '' }
  }
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    const code = /^(`+)([\s\S]*?)\1/u.exec(rest)
    if (code !== null) {
      flush()
      parts.push({ kind: 'code', text: code[2]! })
      index += code[0].length
      continue
    }
    // A imagem do Markdown vira LINK, nunca `<img>`. Uma imagem remota numa
    // resposta é um aviso a um terceiro de que a pessoa leu a mensagem, e este
    // produto diz que nada sai do computador dela.
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)/u.exec(rest)
    if (image !== null) {
      flush()
      const href = image[2]!
      const caption = image[1] === '' ? href : image[1]!
      parts.push(SAFE_SCHEME.test(href)
        ? { kind: 'link', href, children: [{ kind: 'text', text: caption }] }
        : { kind: 'text', text: image[0] })
      index += image[0].length
      continue
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/u.exec(rest)
    if (link !== null) {
      flush()
      const href = link[2]!
      // `javascript:` e qualquer outro esquema viram o texto que o modelo
      // escreveu. Um link que executa não é um link: é o modelo apertando um
      // botão na página de quem está lendo.
      if (SAFE_SCHEME.test(href)) parts.push({ kind: 'link', href, children: parseInline(link[1]!) })
      else parts.push({ kind: 'text', text: link[0] })
      index += link[0].length
      continue
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/u.exec(rest)
    if (strong !== null) {
      flush()
      parts.push({ kind: 'strong', children: parseInline(strong[2]!) })
      index += strong[0].length
      continue
    }
    const em = /^([*_])(?=\S)((?:[^*_]|\*\*|__)*?\S)\1(?![*_])/u.exec(rest)
    if (em !== null) {
      flush()
      parts.push({ kind: 'em', children: parseInline(em[2]!) })
      index += em[0].length
      continue
    }
    text += source[index]!
    index += 1
  }
  flush()
  return parts
}

/**
 * O texto puro de uma árvore, para quem precisa comparar ou copiar.
 * @param nodes - os pedaços de uma linha.
 * @returns o texto sem marcação.
 */
export function inlineText(nodes: readonly MarkdownInline[]): string {
  return nodes.map(node => (node.kind === 'text' || node.kind === 'code' ? node.text : inlineText(node.children))).join('')
}
