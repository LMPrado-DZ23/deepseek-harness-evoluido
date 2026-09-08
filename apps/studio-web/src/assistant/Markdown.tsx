import { Check, Copy } from 'lucide-react'
import { Fragment, createElement, useCallback, useState, type ReactNode } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import {
  inlineText,
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from './markdown'

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

export { inlineText, parseMarkdown }
