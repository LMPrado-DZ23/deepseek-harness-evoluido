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

describe('modelosPorRota', () => {
  it('as rotas da linha de comando usam o modelo da própria ferramenta', async () => {
    const { modelosPorRota } = await import('../src/index.ts')
    expect(modelosPorRota({ DZ23_OLLAMA_MODEL: 'm' }, ['ollama', 'cli-claude', 'deepseek-official'])).toEqual({
      ollama: 'm', omniroute: 'deepseek-v3.2', 'deepseek-official': 'deepseek-chat', 'cli-claude': 'padrao',
    })
  })

  it('as rotas por chave usam o primeiro modelo que o perfil declarou; sem modelo, ficam de fora', async () => {
    const { modelosPorRota } = await import('../src/index.ts')
    const modelos = [
      { provider: 'ollama', id: 'x' }, { provider: 'chave-mistral', id: 'codestral-latest' },
      { provider: 'chave-mistral', id: 'outro' }, { provider: 'chave-groq', id: 'openai/gpt-oss-120b' },
    ]
    expect(modelosPorRota({}, ['ollama', 'chave-mistral', 'chave-groq', 'chave-vazia'], modelos)).toEqual({
      ollama: 'qwen2.5-coder:7b', omniroute: 'deepseek-v3.2', 'deepseek-official': 'deepseek-chat',
      'chave-mistral': 'codestral-latest', 'chave-groq': 'openai/gpt-oss-120b',
    })
  })
})

describe('modelosDasRotasPorChave', () => {
  it('lê só as rotas por chave, e uma que falha fica sem modelo', async () => {
    const { modelosDasRotasPorChave } = await import('../src/index.ts')
    const pedidas: string[] = []
    const llm = {
      async listModels(rota: string) {
        pedidas.push(rota)
        if (rota === 'chave-quebrada') throw new Error('fora do ar')
        return [{ provider: rota, id: `${rota}-m` }]
      },
    }
    expect(await modelosDasRotasPorChave(llm, ['ollama', 'chave-a', 'chave-quebrada', 'cli-x'])).toEqual([{ provider: 'chave-a', id: 'chave-a-m' }])
    expect(pedidas).toEqual(['chave-a', 'chave-quebrada'])
  })
})

describe('nomeDaRotaEmUso', () => {
  it('a pessoa lê o nome, e não o identificador', async () => {
    const { nomeDaRotaEmUso } = await import('../src/index.ts')
    const provedores = [{ id: 'chave-mistral', name: 'Mistral (chave)' }]
    expect(nomeDaRotaEmUso('chave-mistral', provedores)).toBe('Mistral (chave)')
    expect(nomeDaRotaEmUso('outra', provedores)).toBe('outra')
    expect(nomeDaRotaEmUso(null, provedores)).toBeNull()
  })
})
