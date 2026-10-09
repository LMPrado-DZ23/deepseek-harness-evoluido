import { describe, expect, it } from 'vitest'
import { appSpecV1Schema } from '../src/appspec.js'
import { generatedOutputSchema } from '../src/pipeline.js'
import { ModelJsonAmbiguoError, ModelJsonError, corpoDoBlocoCercado, decodeModelJson, primeiroBlocoBalanceado } from '../src/model-json.js'

/**
 * O QUE UM MODELO DE VERDADE DEVOLVE, e o que o produto fazia com isso.
 *
 * Isto nao e fixture escolhida por mim. E a resposta LITERAL do `qwen2.5:3b`
 * rodando no Ollama da maquina do titular, em 18/09/2026, ao prompt REAL de
 * geracao deste plugin — as mesmas quatro instrucoes que `ModelCodeGenerator`
 * monta, com um AppSpec e um plano de verdade.
 *
 * O JSON que veio e VALIDO e bate com `generatedOutputSchema` campo por campo.
 * O que impedia a geracao de acontecer eram TRES CRASES: o produto fazia
 * `JSON.parse` direto, lancava, e as tres tentativas queimavam do mesmo jeito,
 * porque a causa nao era aleatoria — era o formato normal de resposta daquele
 * modelo.
 *
 * Nenhum teste podia pegar isto antes: o dorme dublê nunca cerca.
 */
const RESPOSTA_LITERAL_QWEN_3B = `\`\`\`json
{
  "files": [
    {
      "path": "src/GeneratedApp.tsx",
      "content": "<div>\\n  <h1>Padaria da Esquina</h1>\\n</div>\\n"
    },
    {
      "path": "content/app.json",
      "content": "{\\"name\\":\\"Padaria da Esquina\\",\\"language\\":\\"pt-BR\\",\\"pages\\":[{\\"name\\":\\"Inicio\\",\\"sections\\":[\\"Destaque\\",\\"Beneficios\\",\\"Contato\\"]}],\\"entities\\":[],\\"acceptance_criteria\\":[\\"A página mostra o título \\\\\\"Padaria da Esquina\\\\\\"\\"]}"
    }
  ]
}
\`\`\`
`

describe('a resposta REAL do modelo, contra o decodificador', () => {
  it('o produto ANTIGO morria nela: `JSON.parse` direto lanca', () => {
    // Este caso guarda a causa. Se um dia alguem "simplificar" o decodificador
    // de volta para `JSON.parse`, e esta linha que diz o que volta a quebrar.
    expect(() => JSON.parse(RESPOSTA_LITERAL_QWEN_3B)).toThrow()
  })

  it('o decodificador le a resposta real, com cerca e com BOM', () => {
    const decodificado = decodeModelJson(`\uFEFF${RESPOSTA_LITERAL_QWEN_3B}`)
    expect(generatedOutputSchema.parse(decodificado).files).toHaveLength(2)
  })

  it('o conteudo veio como JSON dentro de string JSON, e o acento sobreviveu', () => {
    const saida = generatedOutputSchema.parse(decodeModelJson(RESPOSTA_LITERAL_QWEN_3B))
    const appJson = saida.files.find(arquivo => arquivo.path === 'content/app.json')
    expect(appJson).toBeDefined()
    /*
      O `content/app.json` e JSON DENTRO de string JSON. E por causa dele que o
      balanceamento respeita aspas e escapes: uma contagem ingenua de chaves
      fecharia no `}` que esta dentro da string e devolveria um pedaco cortado
      que ainda assim parece JSON.
    */
    const conteudo = JSON.parse(appJson!.content) as { language?: unknown }
    expect(conteudo.language).toBe('pt-BR')
    // O acento atravessou o caminho inteiro: modelo, HTTP, arquivo, leitura.
    expect(appJson!.content).toContain('página')
  })

  it('e o que ele devolveu NAO era um AppSpec completo — e isso fica dito', () => {
    /*
      LIMITE DECLARADO, e ele importa mais que o caso acima.

      Este `content/app.json` NAO passa em `appSpecV1Schema`: faltam
      `schema_version` e `problem`. Mas a culpa aqui nao e do modelo — o AppSpec
      que ESTA MEDICAO mandou no prompt era uma versao simplificada, escrita a
      mao para reproduzir o caminho, e o modelo devolveu fielmente o que recebeu.

      Ou seja: esta medicao prova que o ENVELOPE chega legivel, e NAO prova que
      um modelo pequeno preenche o AppSpec inteiro. Sao duas perguntas, e
      colapsa-las seria transformar "nao medi" em "passou". A segunda continua
      aberta em `EB-04`.
    */
    const saida = generatedOutputSchema.parse(decodeModelJson(RESPOSTA_LITERAL_QWEN_3B))
    const appJson = saida.files.find(arquivo => arquivo.path === 'content/app.json')!
    expect(appSpecV1Schema.safeParse(JSON.parse(appJson.content)).success).toBe(false)
  })
})

describe('as formas que um modelo usa para embrulhar JSON', () => {
  it('sem embrulho nenhum continua funcionando', () => {
    expect(decodeModelJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('valor ja decodificado passa direto', () => {
    const objeto = { a: 1 }
    expect(decodeModelJson(objeto)).toBe(objeto)
  })

  it('cerca sem etiqueta de linguagem', () => {
    expect(decodeModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('cerca que o limite de tokens cortou, e nunca fechou', () => {
    expect(decodeModelJson('```json\n{"a":1}')).toEqual({ a: 1 })
  })

  it('frase antes do JSON, sem cerca', () => {
    expect(decodeModelJson('Claro! Aqui esta:\n{"a":1}')).toEqual({ a: 1 })
  })

  it('chave DENTRO de texto nao fecha o bloco cedo', () => {
    /*
      A chave de fechamento DESACOMPANHADA dentro da string e o que discrimina.

      A primeira versao deste caso usava `"{ nao fecha aqui }"` — com chave
      aberta E fechada dentro do texto —, e uma contagem cega a aspas acertava
      por acaso: as duas se anulavam. A sabotagem que cega o balanceamento
      SOBREVIVEU a esse caso, e foi ela que mostrou que o teste nao media nada.
      Com so a de fechar, a contagem cega fecha o bloco cedo e devolve lixo.
    */
    expect(decodeModelJson('texto {"a":"fecha } cedo","b":2} fim'))
      .toEqual({ a: 'fecha } cedo', b: 2 })
  })

  it('objeto DECOY antes da resposta faz o leitor RECUSAR, e nao escolher', () => {
    /*
      Este caso ja afirmou o contrario, e a mudanca foi deliberada.

      A versao anterior dizia que a cerca "vence" o objeto que aparece antes
      dela. Isso e uma politica de ESCOLHA, e uma revisao externa apontou o
      problema: quando a resposta traz um exemplo e depois a resposta, escolher
      um dos dois e adivinhar — e a escolha errada constroi o aplicativo inteiro
      a partir do exemplo, sem que ninguem saiba por que.

      Recusar custa uma rodada de reparo. Escolher errado custa um aplicativo.
    */
    expect(() => decodeModelJson('Aqui vai {"errado":1}\n```json\n{"certo":2}'))
      .toThrow(ModelJsonAmbiguoError)
  })

  it('dois blocos IGUAIS nao sao ambiguidade', () => {
    // O texto inteiro e o corpo da cerca sao o mesmo JSON visto de dois jeitos.
    // Tratar isso como ambiguo faria o leitor recusar toda resposta cercada.
    expect(decodeModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('lista tambem, e nao so objeto', () => {
    expect(decodeModelJson('```json\n[1,2]\n```')).toEqual([1, 2])
  })

  it('resposta vazia LANCA, em vez de virar objeto vazio', () => {
    expect(() => decodeModelJson('   ')).toThrow(ModelJsonError)
  })

  it('prosa sem JSON nenhum LANCA', () => {
    // "Nao consegui" nao pode virar "{}": o schema adiante reclamaria de campo
    // faltando, e quem lesse o erro procuraria o defeito no lugar errado.
    expect(() => decodeModelJson('Desculpe, nao consegui gerar o codigo.')).toThrow(ModelJsonError)
  })

  it('JSON QUEBRADO lanca: o decodificador nao conserta conteudo', () => {
    expect(() => decodeModelJson('```json\n{"a": \n```')).toThrow(ModelJsonError)
  })

  it('a mensagem de erro NAO carrega o texto do modelo', () => {
    // O que o modelo devolve pode trazer o que a pessoa escreveu no pedido, e a
    // mensagem viaja para registro, trace e tela.
    const segredo = 'sk-jamais-deveria-vazar-daqui'
    try {
      decodeModelJson(`nao consegui, ${segredo}`)
      throw new Error('deveria ter lancado')
    } catch (erro) {
      expect((erro as Error).message).not.toContain(segredo)
    }
  })
})

describe('as duas partes, separadas', () => {
  it('o corpo do bloco cercado', () => {
    expect(corpoDoBlocoCercado('```json\n{"a":1}\n```')?.trim()).toBe('{"a":1}')
    expect(corpoDoBlocoCercado('sem cerca')).toBeNull()
  })

  it('o primeiro bloco balanceado', () => {
    expect(primeiroBlocoBalanceado('antes {"a":{"b":1}} depois')).toBe('{"a":{"b":1}}')
    expect(primeiroBlocoBalanceado('{"a":1')).toBeNull()
    expect(primeiroBlocoBalanceado('nada aqui')).toBeNull()
  })
})

/**
 * A SEGUNDA amostra real, da mesma maquina e do mesmo modelo, minutos depois.
 *
 * Esta veio SEM cerca — JSON puro, so com a marca de ordem de bytes na frente.
 * O mesmo `qwen2.5:3b` cercou a resposta de geracao e nao cercou a de intake.
 *
 * E isso que torna o decodificador tolerante obrigatorio, e nao conveniencia:
 * o formato do involucro nao e estavel nem dentro do MESMO modelo, entao nao ha
 * prompt que garanta a forma. Tratar a cerca como excecao rara seria apostar
 * numa estabilidade que a medicao mostra que nao existe.
 */
const RESPOSTA_INTAKE_SEM_CERCA = `{
  "schema_version": 1,
  "problem": "",
  "name": "PadariaDaEsquina",
  "language": "Português",
  "pages": [
    {
      "name": "Pães",
      "sections": [
        {
          "title": "Lista de Pães",
          "content": "Esta seção lista todos os pães disponíveis na padaria."
        },
        {
          "title": "Contato",
          "content": "Você pode nos encontrar no número 123-456-7890."
        }
      ]
    }
  ],
  "entities": [
    {
      "name": "Paes",
      "attributes": [
        {
          "name": "nome_do_pa",
          "content": "Exemplo de pão"
        },
        {
          "name": "preco_do_pa",
          "content": "R$ 10.00"
        }
      ]
    },
    {
      "name": "Contato",
      "attributes": [
        {
          "name": "telefone",
          "content": "123-456-7890"
        }
      ]
    }
  ],
  "acceptance_criteria": [
    "A página de Pães lista todos os pães disponíveis",
    "O telefone é exibido na página de contato"
  ]
}
`

describe('a segunda amostra real: o mesmo modelo, outro involucro', () => {
  it('sem cerca, com BOM — e o decodificador le as duas formas', () => {
    const semCerca = decodeModelJson(`\uFEFF${RESPOSTA_INTAKE_SEM_CERCA}`) as { schema_version?: unknown }
    expect(semCerca.schema_version).toBe(1)
    // E a outra, com cerca, continua lida pelo MESMO caminho.
    expect(generatedOutputSchema.parse(decodeModelJson(RESPOSTA_LITERAL_QWEN_3B)).files).toHaveLength(2)
  })

  it('o involucro chegou legivel, e o CONTEUDO nao satisfez o schema — duas coisas', () => {
    /*
      LIMITE DECLARADO. Este AppSpec NAO passa: `language` veio "Português" em
      vez de uma etiqueta, e `sections` veio como objetos onde o schema pede
      texto.

      Isso NAO diz que o modelo nao serve. O prompt desta medicao foi escrito a
      mao e NAO levava o JSON Schema junto; o produto de verdade manda
      `appSpecV1Schema.toJSONSchema()` no prompt e ainda tem uma rodada de
      reparo. Ou seja: o que esta medido e o INVOLUCRO. Se o modelo preenche o
      AppSpec inteiro com o prompt real continua NAO MEDIDO, e continua em
      `EB-04` — dizer o contrario seria trocar "nao medi" por "passou".
    */
    expect(appSpecV1Schema.safeParse(decodeModelJson(RESPOSTA_INTAKE_SEM_CERCA)).success).toBe(false)
  })
})
