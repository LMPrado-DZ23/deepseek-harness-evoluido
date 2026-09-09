import { describe, expect, it } from 'vitest'
import { projectAddress, savedProjectOf } from './App'

/**
 * O endereço é o único lugar onde o projeto aberto sobrevive a uma recarga.
 *
 * Antes ele vivia só na memória da tela: recarregar, ou clicar em qualquer item
 * do menu (que navega de verdade, com recarga), apagava o trabalho da vista — e
 * não existe "Meus projetos" para reencontrá-lo.
 */
describe('C-3: o projeto no endereço', () => {
  it('guarda o projeto sem derrubar o que já estava no endereço', () => {
    const address = projectAddress('https://studio.local/?tema=escuro', 'projeto-1')
    expect(savedProjectOf(address)).toBe('projeto-1')
    expect(new URL(address).searchParams.get('tema')).toBe('escuro')
  })

  it('tira o projeto quando ele não pode mais ser retomado', () => {
    const address = projectAddress('https://studio.local/?projeto=projeto-1&tema=escuro', null)
    expect(savedProjectOf(address)).toBeNull()
    expect(new URL(address).searchParams.get('tema')).toBe('escuro')
  })

  it('trata endereço sem projeto e projeto vazio como ausência', () => {
    expect(savedProjectOf('https://studio.local/')).toBeNull()
    // Um `?projeto=` vazio é ausência, e não um projeto de nome vazio: sem
    // isso a tela pediria `/projects/` ao servidor a cada abertura.
    expect(savedProjectOf('https://studio.local/?projeto=')).toBeNull()
    expect(savedProjectOf(projectAddress('https://studio.local/', ''))).toBeNull()
  })

  it('substitui o projeto anterior em vez de acumular', () => {
    const first = projectAddress('https://studio.local/', 'projeto-1')
    const second = projectAddress(first, 'projeto-2')
    expect(new URL(second).searchParams.getAll('projeto')).toEqual(['projeto-2'])
  })
})
