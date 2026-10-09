import { describe, expect, it } from 'vitest'
import { atalhoEnvia, atalhosDoStudio, pedeEnvio, type TeclaObservada } from './atalhos'

function tecla(extra: Partial<TeclaObservada> = {}): TeclaObservada {
  return { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra }
}

describe('quando o teclado pede ENVIO', () => {
  it('Ctrl+Enter envia', () => {
    expect(pedeEnvio(tecla({ ctrlKey: true }))).toBe(true)
  })

  it('Cmd+Enter também envia, porque no Mac é ela que ocupa o lugar do Ctrl', () => {
    // Exigir Ctrl faria o atalho existir só para metade das pessoas.
    expect(pedeEnvio(tecla({ metaKey: true }))).toBe(true)
  })

  it('Enter SOZINHO não envia — ele quebra linha, e é o que se espera dele', () => {
    /*
      Sequestrar o Enter faria quem escreve dois parágrafos enviar o primeiro
      sem querer, e não há desfazer para uma tarefa criada.
    */
    expect(pedeEnvio(tecla())).toBe(false)
  })

  it('Shift+Ctrl+Enter e Alt+Ctrl+Enter NÃO enviam', () => {
    // Combinações com modificador a mais pertencem a outras ferramentas e ao
    // sistema; engoli-las faria o Studio responder no lugar de quem deveria.
    expect(pedeEnvio(tecla({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(pedeEnvio(tecla({ ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('outra tecla com Ctrl não envia', () => {
    expect(pedeEnvio(tecla({ key: 'k', ctrlKey: true }))).toBe(false)
  })
})

describe('o atalho não é uma segunda porta', () => {
  it('ele passa pela MESMA condição do botão', () => {
    /*
      Sem isto, o teclado enviaria o que o botão recusa — e a recusa do botão é
      onde moram "tem texto", "a rota permite" e "já está enviando".
    */
    expect(atalhoEnvia(tecla({ ctrlKey: true }), false)).toBe(false)
    expect(atalhoEnvia(tecla({ ctrlKey: true }), true)).toBe(true)
  })

  it('com o botão liberado, Enter sozinho continua não enviando', () => {
    expect(atalhoEnvia(tecla(), true)).toBe(false)
  })
})

describe('a lista de atalhos', () => {
  it('lista o ENVIO, que é o atalho que esta fatia acrescentou', () => {
    const enviar = atalhosDoStudio().find(atalho => atalho.id === 'enviar')
    expect(enviar?.teclas).toEqual(['Ctrl', 'Enter'])
    expect(enviar?.escopo).toBe('compositor')
  })

  it('todo atalho listado TEM teclas e escopo — nenhum entra como enfeite', () => {
    for (const atalho of atalhosDoStudio()) {
      expect(atalho.teclas.length).toBeGreaterThan(0)
      expect(['global', 'compositor']).toContain(atalho.escopo)
    }
  })

  it('o Esc está na lista, porque ele existe e ninguém sabia', () => {
    // Um atalho que ninguém sabe que existe não é um atalho.
    expect(atalhosDoStudio().some(atalho => atalho.teclas.includes('Esc'))).toBe(true)
  })
})
