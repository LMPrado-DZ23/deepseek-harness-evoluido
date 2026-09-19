import { describe, expect, it } from 'vitest'
import { LIMITE_DO_PEDIDO, anexarAoPedido } from './anexo'

describe('anexarAoPedido', () => {
  it('o conteúdo entra visível, marcado com o nome do arquivo', () => {
    const r = anexarAoPedido('Quero um site', 'lista.txt', 'item 1\r\nitem 2\n')
    expect(r).toEqual({ texto: 'Quero um site\n\n[Anexo: lista.txt]\nitem 1\nitem 2', cortados: 0 })
  })

  it('pedido vazio não ganha linha em branco no começo', () => {
    expect(anexarAoPedido('', 'a.md', 'x').texto).toBe('[Anexo: a.md]\nx')
  })

  it('o que não cabe é cortado, e a conta diz quanto', () => {
    const r = anexarAoPedido('abc', 'grande.txt', 'y'.repeat(20_000))
    expect(r.texto.length).toBe(LIMITE_DO_PEDIDO)
    expect(r.cortados).toBe(20_000 - (LIMITE_DO_PEDIDO - 'abc\n\n[Anexo: grande.txt]\n'.length))
  })

  it('pedido já cheio não muda', () => {
    const cheio = 'z'.repeat(LIMITE_DO_PEDIDO)
    expect(anexarAoPedido(cheio, 'a.txt', 'abc')).toEqual({ texto: cheio, cortados: 3 })
  })

  it('o nome não quebra a marca', () => {
    expect(anexarAoPedido('', 'a]\n[b.txt', 'x').texto.split('\n')[0]).toBe('[Anexo: a   b.txt]')
  })
})
