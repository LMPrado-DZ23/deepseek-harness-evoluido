import { Check, Copy } from 'lucide-react'
import { Fragment, createElement, useCallback, useState, type ReactNode } from 'react'
import copy from '../i18n/assistant.pt-BR.json'

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

export const MARKDOWN_MAX_CHARS = 128 * 1024

const SAFE_SCHEME = /^https?:\/\//iu
const LANGUAGE = /^[A-Za-z0-9_+-]{1,24}$/u
const FENCE = /^\s{0,3}(`{3,}|~{3,})[ \t]*(.*)$/u
const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/u
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/u
const QUOTE = /^\s{0,3}>\s?(.*)$/u

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
        if (closing !== null && closing[1]!.startsWith(marker[0]!) && closing[1]!.length >= marker.length) {
          index += 1
          break
        }
        body.push(candidate)
        index += 1
      }
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

export function inlineText(nodes: readonly MarkdownInline[]): string {
  return nodes.map(node => (node.kind === 'text' || node.kind === 'code' ? node.text : inlineText(node.children))).join('')
}

/**
 * Desenha a árvore lida de Markdown com elementos React.
 *
 * Não existe `dangerouslySetInnerHTML` neste arquivo, e não pode existir: o
 * texto vem de um modelo, e um único ponto que aceitasse HTML transformaria
 * "o assistente respondeu" em "o assistente escreveu a página".
 */

/** Um pedaço de linha. */
function Inline({ nodes }: { readonly nodes: readonly MarkdownInline[] }): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${String(index)}`
    if (node.kind === 'text') return <Fragment key={key}>{node.text}</Fragment>
    if (node.kind === 'code') return <code key={key} className="md-code">{node.text}</code>
    if (node.kind === 'strong') return <strong key={key}><Inline nodes={node.children} /></strong>
    if (node.kind === 'em') return <em key={key}><Inline nodes={node.children} /></em>
    // `noopener` porque a página aberta não pode alcançar esta; `noreferrer`
    // porque o endereço da conversa não é assunto do outro lado.
    return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
      <Inline nodes={node.children} />
    </a>
  })
}

/**
 * Um bloco de código, com o nome da linguagem e um botão de copiar.
 *
 * O botão existe porque a alternativa é a pessoa selecionar com o mouse um
 * bloco que rola na horizontal — e trazer metade do trecho.
 */
export function CodeBlock({ language, text }: { readonly language: string | null, readonly text: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    // Sem área de transferência (contexto sem permissão, navegador antigo) o
    // botão NÃO diz que copiou: o texto continua selecionável, e uma
    // confirmação falsa faria a pessoa colar o que não foi copiado.
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => { setCopied(false) }, 2_000)
      },
      () => { setCopied(false) },
    )
  }, [text])
  return <div className="md-block-code">
    <div className="md-block-code-bar">
      <span className="md-language">{language ?? copy.codeBlockUnknownLanguage}</span>
      <button type="button" className="secondary md-copy" onClick={onCopy}
        aria-label={copy.codeBlockCopy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? copy.codeBlockCopied : copy.codeBlockCopy}
      </button>
    </div>
    <pre><code {...(language === null ? {} : { className: `language-${language}` })}>{text}</code></pre>
  </div>
}

/** Um bloco. */
function Block({ block }: { readonly block: MarkdownBlock }): ReactNode {
  if (block.kind === 'paragraph') return <p dir="auto"><Inline nodes={block.children} /></p>
  if (block.kind === 'heading') {
    // Começa em `h3`: a conversa já tem `h1` e `h2` na página, e um `h2` vindo
    // de uma resposta quebraria a ordem dos títulos para quem navega por eles.
    return createElement(`h${String(block.level + 2)}`, { className: 'md-heading', dir: 'auto' },
      <Inline nodes={block.children} />)
  }
  if (block.kind === 'code') return <CodeBlock language={block.language} text={block.text} />
  if (block.kind === 'quote') return <blockquote dir="auto"><Inline nodes={block.children} /></blockquote>
  if (block.kind === 'rule') return <hr />
  const items = block.items.map((item, index) => <li key={`item-${String(index)}`} dir="auto">
    <Inline nodes={item} />
  </li>)
  return block.ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>
}

/**
 * O texto de uma mensagem, desenhado.
 * @param props.text - o texto cru da mensagem.
 * @returns os blocos desenhados.
 */
export function Markdown({ text }: { readonly text: string }) {
  const blocks = parseMarkdown(text)
  return <div className="md">
    {blocks.map((block, index) => <Fragment key={`${block.kind}-${String(index)}`}>
      <Block block={block} />
    </Fragment>)}
  </div>
}
