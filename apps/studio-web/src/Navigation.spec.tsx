import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StudioSidebar } from './Navigation'
import { NAV_MENU_ID, activeNavId, studioNavItems } from './navigation'
import { ASSISTANT_PATH } from './assistant/AssistantEntry'
import { HUB_PATH } from './hub/presentation'

const render = (props: Partial<Parameters<typeof StudioSidebar>[0]> = {}) =>
  renderToStaticMarkup(createElement(StudioSidebar, { active: 'home', open: false, onClose: () => {}, ...props }))

describe('navegação do Studio', () => {
  it('leva às telas que existem de verdade', () => {
    const hrefs = new Map(studioNavItems().map(item => [item.id, item.href]))
    expect(hrefs.get('home')).toBe('/studio/')
    expect(hrefs.get('assistant')).toBe(ASSISTANT_PATH)
    expect(hrefs.get('hub')).toBe(HUB_PATH)
  })

  it('não tem item morto: nenhum "em breve", nenhum botão desabilitado', () => {
    // A história em três atos. (1) Quatro botões sem ação: a pessoa apertava e
    // nada acontecia, sem nem saber se tinha quebrado. (2) Os itens viraram
    // DESABILITADOS com a etiqueta "em breve" - melhor, porque parava de
    // enganar. (3) O Prado leu a etiqueta pelo que ela é: "o produto não está
    // pronto", dito toda vez que alguém abre o menu. "Meus projetos" ganhou
    // tela; "Ver resultado" não precisava de uma, porque o resultado é o pé da
    // tela inicial. Agora todo item leva a algum lugar.
    const html = render()
    expect(studioNavItems().every(item => item.href.startsWith('/'))).toBe(true)
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('em breve')
    // Cada item vira um <a> com destino - e não um <button>, que não abre em
    // outra aba e não anuncia navegação para quem usa leitor de tela.
    expect(html.match(/<a class="nav/gu) ?? []).toHaveLength(studioNavItems().length)
  })

  it('a conversa - e portanto as confirmações - está na navegação, não só no endereço digitado', () => {
    // Abaixo de 820px a barra some; se o link da conversa existisse só nela, a
    // tela de confirmação só seria alcançável digitando a URL.
    expect(render()).toContain(`href="${ASSISTANT_PATH}"`)
  })

  it('marca a tela aberta para quem usa leitor de tela', () => {
    expect(render({ active: 'assistant' })).toContain('aria-current="page"')
    expect(render({ active: null })).not.toContain('aria-current')
  })

  it('a gaveta só fica aberta quando a pessoa abre, e tem como fechar', () => {
    expect(render({ open: false })).toContain('class="sidebar"')
    const open = render({ open: true })
    expect(open).toContain('class="sidebar open"')
    expect(open).toContain('Fechar menu')
    expect(open).toContain(`id="${NAV_MENU_ID}"`)
  })

  it('reconhece a tela aberta pelo endereço', () => {
    expect(activeNavId('/studio/')).toBe('home')
    expect(activeNavId('/studio')).toBe('home')
    expect(activeNavId(ASSISTANT_PATH)).toBe('assistant')
    expect(activeNavId(HUB_PATH)).toBe('hub')
    expect(activeNavId('/algo/que/nao/e/do/studio')).toBe(null)
  })
})

/** O bloco de celular da folha, onde a barra lateral é escondida. */
function phoneBlock(): string {
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  const blocks = [...styles.matchAll(/@media\(max-width:820px\)\{((?:[^{}]|\{[^{}]*\})*)\}/gu)].map(match => match[1] ?? '')
  if (blocks.length === 0) throw new Error('a folha não tem mais o bloco de celular')
  return blocks.join('\n')
}

describe('a barra lateral no celular', () => {
  it('some por padrão mas pode ser aberta - senão o produto fica sem navegação no telefone', () => {
    const phone = phoneBlock()
    // Este era o defeito: `.sidebar{display:none}` sem nenhuma regra que a
    // trouxesse de volta, e um botão de menu sem ação.
    expect(phone).toMatch(/(?:^|[};])\.sidebar\{[^}]*display:none/u)
    const open = /\.sidebar\.open\{([^}]*)\}/u.exec(phone)
    expect(open, 'sem regra para a gaveta aberta').not.toBe(null)
    expect(open?.[1]).toMatch(/display:(?!none)/u)
    expect(open?.[1]).toMatch(/position:fixed/u)
    // O botão de fechar precisa aparecer junto com a gaveta.
    expect(phone).toMatch(/\.drawer-close\{[^}]*display:(?!none)/u)
  })

  it('o botão do menu abre a gaveta de verdade', () => {
    // Sem `onClick` o botão fica mudo. Foi assim que ele nasceu.
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const button = /<button[^>]*className="mobile-menu"[^>]*>/u.exec(app)?.[0] ?? ''
    expect(button).toContain('onClick=')
    expect(button).toContain('aria-expanded=')
    expect(button).toContain(`aria-controls={NAV_MENU_ID}`)
  })
})
