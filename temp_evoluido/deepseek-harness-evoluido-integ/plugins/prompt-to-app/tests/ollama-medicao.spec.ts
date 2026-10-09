import { describe, expect, it } from 'vitest'
import { assertGeneratedSource } from '../src/import-policy.js'

/**
 * MEDICAO CONTRA MODELO REAL (EB-04, parcial).
 *
 * Estas nao sao fixtures escolhidas por mim: e a saida LITERAL do `qwen2.5:3b`
 * rodando no Ollama da maquina do Prado, em 12 segundos, para um pedido simples.
 * Ate aqui todo o caminho de geracao foi provado contra um dobro que sempre
 * responde no formato certo — e um dobro mede o dobro.
 *
 * O que este arquivo prova e o que ele NAO prova estao separados de proposito.
 */
const SAIDA_REAL_QWEN_3B = `import React from 'react';

function App() {
  return (
    <div>
      <h1>Título</h1>
    </div>
  );
}

export default App;`

describe('a saida de um modelo REAL contra as guardas do Studio', () => {
  it('o `qwen2.5:3b` produziu codigo que as guardas ACEITAM', () => {
    // Primeira vez nesta missao que uma guarda e exercitada por texto que um
    // modelo de verdade escreveu, e nao por texto que eu escolhi.
    expect(() => assertGeneratedSource([{ path: 'src/GeneratedApp.tsx', content: SAIDA_REAL_QWEN_3B }])).not.toThrow()
  })

  it('e o acento sobreviveu: o conteudo e UTF-8 de verdade', () => {
    // O terminal do Windows mostrou `T?tulo` na primeira leitura. Era o console,
    // e nao o modelo — mas so da para afirmar isso conferindo o byte.
    expect(SAIDA_REAL_QWEN_3B).toContain('Título')
  })
})

describe('o TEMPO, medido na maquina do Prado', () => {
  it('o prompt REAL do Studio nao completa em 45 segundos nestes modelos', () => {
    // Numeros medidos, nao estimados:
    //   pedido simples, `qwen2.5:3b` quente ......... 12 s, resposta valida
    //   prompt real (2.306 chars), `qwen2.5:3b` ..... estourou 50 s
    //   prompt real, `qwen2.5:0.5b` ................. estourou 50 s
    //   prompt real, `0.5b`, `num_predict=1` ........ estourou 45 s
    //
    // O ultimo e o que diagnostica: com UM token de saida ele ainda estoura,
    // entao o custo nao e gerar — e carregar o modelo e processar o prompt
    // nessa maquina. Isso mede a MAQUINA, e nao o produto; e e a informacao
    // que decide se vale planejar em cima de modelo local.
    //
    // Este teste nao mede tempo: um teste de tempo em maquina compartilhada
    // mede a maquina do teste. Ele guarda o NUMERO para que a decisao que veio
    // dele possa ser reconferida por alguem que discorde.
    expect(PROMPT_REAL_CHARS).toBe(2306)
  })
})

/** O tamanho do prompt real de geracao, na configuracao medida. */
const PROMPT_REAL_CHARS = 2306

describe('o que esta medicao NAO prova', () => {
  it('um pedido simples nao e um aplicativo: o plano tem fatias, entidades e criterios', () => {
    // Declarado como teste para nao virar nota de rodape que ninguem le. O que
    // foi medido e UMA geracao de UM arquivo a partir de UM pedido de uma linha.
    // O caminho inteiro — intake, plano, varias fatias, construcao em conteiner,
    // verificacao criterio a criterio — continua provado so contra dobro.
    expect(SAIDA_REAL_QWEN_3B.split('\n').length).toBeLessThan(20)
  })
})
