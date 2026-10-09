import { describe, expect, it } from 'vitest'
import { ASSISTANT_REQUEST_PARAM, MAX_ASSISTANT_REQUEST_CHARS, assistantRequestAddress, assistantRequestFrom } from './assistantRequest'
import { ASSISTANT_PATH } from './AssistantEntry'

describe('o pedido preparado que uma tela manda para a conversa', () => {
  it('leva o texto no endereço, escapado', () => {
    const address = assistantRequestAddress('quero dividir em etapas & começar')
    expect(address.startsWith(`${ASSISTANT_PATH}?${ASSISTANT_REQUEST_PARAM}=`)).toBe(true)
    expect(address).not.toContain(' ')
    expect(assistantRequestFrom(new URL(address, 'http://x').search)).toBe('quero dividir em etapas & começar')
  })

  it('pedido vazio não vira endereço com parâmetro vazio', () => {
    // Um `?pedido=` sem nada abriria a conversa anunciando um pedido que não
    // existe, e a tela mostraria o aviso sobre um campo em branco.
    expect(assistantRequestAddress('   ')).toBe(ASSISTANT_PATH)
    expect(assistantRequestFrom('?pedido=')).toBeNull()
    expect(assistantRequestFrom('')).toBeNull()
  })

  it('corta no teto: um endereço colado não enche a caixa com uma parede', () => {
    // O texto vem da BARRA DE ENDEREÇO, que qualquer pessoa edita e qualquer
    // link de fora monta. Ele é tratado como hostil — e nunca é enviado
    // sozinho: só preenche o campo, à vista, para ser lido antes de ir.
    const wall = 'a'.repeat(MAX_ASSISTANT_REQUEST_CHARS + 500)
    expect(assistantRequestFrom(`?pedido=${wall}`)).toHaveLength(MAX_ASSISTANT_REQUEST_CHARS)
    expect(new URL(assistantRequestAddress(wall), 'http://x').searchParams.get('pedido')).toHaveLength(MAX_ASSISTANT_REQUEST_CHARS)
  })

  it('outro parâmetro no endereço não vira pedido', () => {
    expect(assistantRequestFrom('?outra=coisa')).toBeNull()
  })
})
