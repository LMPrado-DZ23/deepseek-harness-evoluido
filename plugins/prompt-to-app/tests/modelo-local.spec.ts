import { describe, expect, it } from 'vitest'
import { MODELO_LOCAL_PADRAO, modeloLocal } from '../src/index.ts'

/*
  O DEFEITO QUE ISTO FECHA é de DUAS VERDADES, e ele era silencioso.

  O perfil registra o modelo do provedor local a partir de `DZ23_OLLAMA_MODEL`.
  Este lado — o que escolhe QUAL modelo o pedido nomeia — estava fixo em
  `qwen2.5-coder:7b`. Quem configurasse a variável fazia o provedor registrar um
  modelo e o plugin pedir outro: o pedido nomeia um modelo que o provedor não
  tem, e a falha aparece na geração, longe da causa.
*/
describe('o modelo da rota local', () => {
  it('sai da variavel que o perfil tambem le', () => {
    expect(modeloLocal({ DZ23_OLLAMA_MODEL: 'qwen2.5-coder:3b' })).toBe('qwen2.5-coder:3b')
  })

  it('sem variavel, e o padrao do produto', () => {
    expect(modeloLocal({})).toBe(MODELO_LOCAL_PADRAO)
    expect(MODELO_LOCAL_PADRAO).toBe('qwen2.5-coder:7b')
  })

  it('variavel em branco e ausencia, e nao um modelo sem nome', () => {
    // Variável vazia é a forma mais comum de "não configurei": exportada e não
    // preenchida. Aceitá-la faria o pedido nomear string vazia.
    for (const branco of ['', '   ', '\t']) {
      expect(modeloLocal({ DZ23_OLLAMA_MODEL: branco }), JSON.stringify(branco)).toBe(MODELO_LOCAL_PADRAO)
    }
  })

  it('espaco em volta nao vira parte do nome', () => {
    expect(modeloLocal({ DZ23_OLLAMA_MODEL: '  qwen3-coder  ' })).toBe('qwen3-coder')
  })
})
