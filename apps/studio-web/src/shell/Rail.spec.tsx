import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Rail } from './Rail'
import { RAIL_ID, railAtivo, railItens } from './Rail-utils'
import { ASSISTANT_PATH } from '../assistant/AssistantEntry'
import { AGENDADO_PATH, BIBLIOTECA_PATH, DISPONIBILIDADE, HABILIDADES_PATH, PLUGINS_PATH } from '../destinos/destinos'
import rail from '../i18n/rail.pt-BR.json'

/*
  ESTE ARQUIVO SUBSTITUI `Navigation.spec.tsx`, que cobria a barra lateral
  anterior. A decisão de produto autoriza trocar a estrutura de apresentação e
  pede, com razão, que a cobertura não desapareça junto com a tela. O que cada
  teste de lá cobria e onde ele está aqui:

  | comportamento coberto antes            | onde está agora                        |
  | -------------------------------------- | -------------------------------------- |
  | itens levam a telas que existem        | "leva às telas que existem de verdade" |
  | nenhum item morto, nenhum "em breve"   | "não tem item morto"                   |
  | a conversa está na navegação           | "leva às telas que existem de verdade" |
  | `aria-current` na tela aberta          | "marca a tela aberta"                  |
  | gaveta abre/fecha e tem botão de fechar| "a gaveta só fica aberta…"             |
  | `activeNavId` pelo endereço            | "reconhece a tela aberta pelo endereço"|
  | barra some no celular e volta na gaveta| "a gaveta no celular"                  |
  | botão do menu com `onClick`/`aria-*`   | "o botão do menu abre a gaveta"        |

  Nada foi afrouxado no caminho: o que mudou foram os seletores e o corte do
  celular (820px → 1024px), porque o trilho novo é mais largo e a decisão manda
  cortar pelo conteúdo.

  SEGUNDA ATUALIZAÇÃO, pela decisão `DZ23-VISUAL-VIDEO-20260916-R1`. Três testes
  aqui afirmavam a decisão ANTERIOR sobre as ausências — que Agendado e
  Biblioteca ficassem fora do trilho, e que Habilidades e Plugins fossem uma
  linha só. A decisão nova inverte a regra: "Ausência de função significa
  implementar e manter a pendência; não remover o requisito". O mapa de
  equivalência:

  | o que era afirmado antes                  | o que é afirmado agora                      |
  | ----------------------------------------- | ------------------------------------------- |
  | `integracoes` aponta para o Hub           | `habilidades` e `plugins`, destinos próprios|
  | "Agendado" NÃO aparece no trilho          | aparece, com destino real e pendência declarada |
  | "Biblioteca" NÃO aparece no trilho        | aparece, com destino próprio ≠ Projetos     |
  | nenhum item morto                         | idem, e agora sobre SEIS itens              |

  A garantia que importava — nenhum clique sem resultado — não foi reduzida: ela
  continua sendo conferida item por item, sobre o dobro de itens, e ganhou uma
  conferência que antes não existia (a pendência de Agendado precisa estar
  DECLARADA, e não escondida atrás de um rótulo na tela).
*/
const render = (props: Partial<Parameters<typeof Rail>[0]> = {}) =>
  renderToStaticMarkup(createElement(Rail, { ativo: 'nova', aberto: false, aoFechar: () => {}, ...props }))

describe('o trilho do workspace', () => {
  it('leva às telas que existem de verdade', () => {
    const hrefs = new Map(railItens().map(item => [item.id, item.href]))
    expect(hrefs.get('nova')).toBe('/studio/')
    expect(hrefs.get('agente')).toBe(ASSISTANT_PATH)
    expect(hrefs.get('habilidades')).toBe(HABILIDADES_PATH)
    expect(hrefs.get('plugins')).toBe(PLUGINS_PATH)
    expect(hrefs.get('agendado')).toBe(AGENDADO_PATH)
    expect(hrefs.get('biblioteca')).toBe(BIBLIOTECA_PATH)
    // A conversa (e portanto as confirmações) tem link: no celular o trilho
    // vira gaveta, e um destino que só existisse lá dentro dependeria de
    // alguém digitar o endereço.
    expect(render()).toContain(`href="${ASSISTANT_PATH}"`)
  })

  it('os SEIS destinos da referência estão no trilho, e cada um é distinto', () => {
    // A referência desenha Nova tarefa, Agente, Habilidades, Plugins, Agendado
    // e Biblioteca. Dois deles eram omitidos porque a capacidade não existia;
    // agora todos têm endereço, e nenhum endereço se repete.
    const hrefs = railItens().map(item => item.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    const html = render()
    for (const rotulo of [rail.novaTarefa, rail.agente, rail.habilidades, rail.plugins, rail.agendado, rail.biblioteca]) {
      expect(html).toContain(rotulo)
    }
  })

  it('a pendência de Agendado é DECLARADA, e não um rótulo na tela', () => {
    // "Em breve" no trilho é o que já foi removido daqui uma vez, e continua
    // proibido. O lugar da pendência é o registro que um teste alcança — a
    // tela do destino diz o que falta, com todas as letras, quando alguém abre.
    expect(DISPONIBILIDADE.agendado).toBe('pendente')
    expect(render()).not.toContain('em breve')
  })

  it('não tem item morto: nenhum "em breve", nenhum botão desabilitado', () => {
    const html = render()
    expect(railItens().every(item => item.href.startsWith('/'))).toBe(true)
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('em breve')
    /*
      Cada item é um <a> com DESTINO — e não um <button>, que não abre em outra
      aba e não anuncia navegação para quem usa leitor de tela.

      A afirmação era uma CONTAGEM (`<a href="/` tantas vezes quantos itens), e
      ela quebrou quando o trilho ganhou links legítimos que não são itens de
      navegação: o "+" de Projetos, "Ver todas", "Novo projeto" e a ajuda no
      rodapé. Contar âncoras media a coisa errada. Agora a conferência é
      direta: o destino de CADA item está no documento, e nenhuma âncora do
      trilho aponta para lugar nenhum.
    */
    for (const item of railItens()) expect(html).toContain(`href="${item.href}"`)
    expect(html).not.toContain('href="#"')
    expect(html).not.toMatch(/<a(?![^>]*href=)/u)
    // E a marca também é link para a home, como na referência.
    expect(html).toContain('class="dz-marca" href="/studio/"')
  })

  it('marca a tela aberta para quem usa leitor de tela', () => {
    // A cor de fundo diz onde a pessoa está para quem enxerga; sem
    // `aria-current` quem ouve a tela fica sem essa informação.
    expect(render({ ativo: 'agente' })).toContain('aria-current="page"')
    expect(render({ ativo: null })).not.toContain('aria-current')
  })

  it('a gaveta só fica aberta quando a pessoa abre, e tem como fechar', () => {
    expect(render({ aberto: false })).toContain('class="dz-rail"')
    const aberta = render({ aberto: true })
    expect(aberta).toContain('class="dz-rail aberto"')
    expect(aberta).toContain('Fechar menu')
    expect(aberta).toContain(`id="${RAIL_ID}"`)
  })

  it('reconhece a tela aberta pelo endereço', () => {
    expect(railAtivo('/studio/')).toBe('nova')
    expect(railAtivo('/studio')).toBe('nova')
    expect(railAtivo(ASSISTANT_PATH)).toBe('agente')
    expect(railAtivo(HABILIDADES_PATH)).toBe('habilidades')
    expect(railAtivo(PLUGINS_PATH)).toBe('plugins')
    expect(railAtivo(AGENDADO_PATH)).toBe('agendado')
    expect(railAtivo(BIBLIOTECA_PATH)).toBe('biblioteca')
    expect(railAtivo('/algo/que/nao/e/do/studio')).toBe(null)
  })
})

/** O bloco da folha onde o trilho vira gaveta. */
function blocoEstreito(): string {
  const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8')
  const blocos = [...css.matchAll(/@media\s*\(max-width:\s*1024px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gu)].map(m => m[1] ?? '')
  if (blocos.length === 0) throw new Error('a folha não tem mais o bloco estreito')
  return blocos.join('\n')
}

describe('a gaveta no celular', () => {
  it('sai do fluxo mas pode ser aberta — senão o produto fica sem navegação no telefone', () => {
    // O defeito que este teste guarda: a lateral escondida sem nenhuma regra
    // que a trouxesse de volta, e um botão de menu sem ação.
    const estreito = blocoEstreito()
    expect(estreito).toMatch(/\.dz-rail\s*\{[^}]*position:\s*fixed/u)
    expect(estreito).toMatch(/\.dz-rail\s*\{[^}]*transform:\s*translateX\(-/u)
    const aberta = /\.dz-rail\.aberto\s*\{([^}]*)\}/u.exec(estreito)
    expect(aberta, 'sem regra para a gaveta aberta').not.toBe(null)
    expect(aberta?.[1]).toMatch(/transform:\s*translateX\(0\)/u)
    // O botão de fechar precisa aparecer junto com a gaveta.
    expect(estreito).toMatch(/\.dz-rail-fechar\s*\{[^}]*display:\s*(?!none)/u)
    // E o de abrir, que fora daqui não existe.
    expect(estreito).toMatch(/\.dz-menu\s*\{[^}]*display:\s*inline-flex/u)
  })

  it('o botão do menu abre a gaveta de verdade', () => {
    // Sem `onClick` o botão fica mudo. Foi assim que ele nasceu, na casca
    // anterior.
    const casca = readFileSync(new URL('./WorkspaceShell.tsx', import.meta.url), 'utf8')
    const botao = /<button[^>]*className="dz-menu"[^>]*>/su.exec(casca)?.[0] ?? ''
    expect(botao).toContain('onClick=')
    expect(botao).toContain('aria-expanded=')
    expect(botao).toContain('aria-controls={RAIL_ID}')
  })
})
