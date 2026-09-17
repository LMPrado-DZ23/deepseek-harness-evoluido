import { describe, expect, it } from 'vitest'
import { ITENS_NO_MENU, alemDoMenu, destinoDoMenu, itensDoMenu, ligadasNoMenu, tiposDoMenu, type IntegracaoDoMenu } from './menusDoCompositor'
import { ESCOPO } from '../destinos/destinos'

function integracao(id: string, kind: string, enabled = true, name = id): IntegracaoDoMenu {
  return { integration_id: id, name, kind, enabled }
}

describe('os menus ancorados no compositor', () => {
  it('cada menu mostra SÓ os tipos do destino dele', () => {
    const tudo = [integracao('a', 'skill'), integracao('b', 'mcp'), integracao('c', 'smtp'), integracao('d', 'webhook')]
    expect(itensDoMenu(tudo, 'habilidades').map(item => item.id)).toEqual(['a'])
    expect(itensDoMenu(tudo, 'plugins').map(item => item.id).sort()).toEqual(['b', 'c', 'd'])
  })

  it('o escopo vem da autoridade dos destinos, e não de uma segunda lista', () => {
    // Duas listas para o mesmo fato divergem no primeiro tipo novo.
    expect(tiposDoMenu('habilidades')).toBe(ESCOPO.habilidades)
    expect(tiposDoMenu('plugins')).toBe(ESCOPO.plugins)
  })

  it('as LIGADAS vêm primeiro, porque é o que vale no envio', () => {
    const lista = [integracao('z', 'skill', false), integracao('a', 'skill', false), integracao('m', 'skill', true)]
    expect(itensDoMenu(lista, 'habilidades').map(item => item.id)).toEqual(['m', 'a', 'z'])
  })

  it('corta no limite, e diz quantas ficaram de fora', () => {
    const muitas = Array.from({ length: ITENS_NO_MENU + 3 }, (_, indice) => integracao(`s${indice}`, 'skill'))
    expect(itensDoMenu(muitas, 'habilidades')).toHaveLength(ITENS_NO_MENU)
    expect(alemDoMenu(muitas, 'habilidades')).toBe(3)
  })

  it('o número ao lado do botão conta TODAS as ligadas, e não só as que cabem', () => {
    // Mostrar 6 e dizer "6" para quem tem 9 ligadas seria mentir sobre o envio.
    const muitas = Array.from({ length: ITENS_NO_MENU + 3 }, (_, indice) => integracao(`s${indice}`, 'skill'))
    expect(ligadasNoMenu(muitas, 'habilidades')).toBe(ITENS_NO_MENU + 3)
  })

  it('desligada não conta como ligada', () => {
    const lista = [integracao('a', 'skill', true), integracao('b', 'skill', false)]
    expect(ligadasNoMenu(lista, 'habilidades')).toBe(1)
  })

  it('lista vazia é lista vazia — nenhuma integração de exemplo', () => {
    expect(itensDoMenu([], 'plugins')).toEqual([])
    expect(ligadasNoMenu([], 'plugins')).toBe(0)
    expect(alemDoMenu([], 'plugins')).toBe(0)
  })

  it('cada menu aponta para o destino real onde ele é administrado', () => {
    expect(destinoDoMenu('habilidades')).toBe('/studio/habilidades')
    expect(destinoDoMenu('plugins')).toBe('/studio/plugins')
  })

  it('um tipo que não pertence a menu nenhum não aparece em nenhum dos dois', () => {
    const estranha = [integracao('x', 'tipo-que-nao-existe')]
    expect(itensDoMenu(estranha, 'habilidades')).toEqual([])
    expect(itensDoMenu(estranha, 'plugins')).toEqual([])
  })
})
