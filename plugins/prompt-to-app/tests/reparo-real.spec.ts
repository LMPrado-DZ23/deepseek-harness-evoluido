import { describe, expect, it } from 'vitest'
import cat from '../i18n/pt-BR.json' with { type: 'json' }
import { appSpecV1Schema, parseAppSpecWithSingleRepair } from '../src/appspec.js'
import { ModelJsonError, decodeModelJson } from '../src/model-json.js'
import { prompt, t } from '../src/i18n.js'

/**
 * A RODADA DE REPARO era uma copia DEGRADADA do primeiro prompt.
 *
 * Medido em 18/09/2026 contra o Ollama da maquina do titular, com o prompt REAL
 * de intake deste plugin — o mesmo que o produto monta, com o JSON Schema
 * dentro. O modelo devolveu um AppSpec quase certo e errou UM campo: marcou as
 * entidades como `static-content` e deu a elas campos estruturados, que e a
 * forma de `database`.
 *
 * Ate aqui, normal: e para isso que existe a rodada de reparo. So que ela
 * mandava ao modelo os ERROS e mais nada:
 *
 *     "Corrija uma unica vez este AppSpec. Erros: {issues}. Valor: {value}"
 *
 * Sem o contrato de formato, que estava no primeiro prompt e nao neste. O
 * modelo respondeu em YAML, embrulhado em prosa — e a resposta abaixo e
 * literalmente a que ele devolveu.
 *
 * E sem o SCHEMA, que tambem estava no primeiro prompt: o modelo recebia
 * "entities.0.fields.0: expected string, received object" e nao tinha como
 * saber que o conserto era trocar o `kind` da entidade, porque a definicao da
 * forma ficou para tras.
 */
const REPARO_EM_YAML = `Aqui está o AppSpec corrigido, com os erros identificados corrigidos:

\`\`\`yaml
schema_version: 1
problem: Criar um jogo da velha para jogar contra o computador com placar
audience: Todos
journeys: [Jogar Jogo da Velha]
pages:
- name: Jogador 1
  sections:
  - Escolha seu símbolo
  - Jogada do Jogador 1
  - Placar
- name: Jogador 2
  sections:
  - Escolha seu símbolo
  - Jogada do Jogador 2
  - Placar
- name: Placar
  sections:
  - Jogador 1
  - Jogador 2
entities:
- name: Jogador 1
  kind: static-content
  fields:
  - name: Símbolo
    type: selection
    options: ["X", "O"]
- name: Jogador 2
  kind: static-content
  fields:
  - name: Símbolo
    type: selection
    options: ["X", "O"]
- name: Placar
  kind: static-content
  fields:
  - name: Jogador 1
    type: number
  - name: Jogador 2
    type: number
sensitive_data:
  detected: []
  confirmed_by_user: false
accessibility:
  wcag_level: AA
  keyboard_required: true
  reduced_motion: true
language: pt-BR
acceptance_criteria:
- Jogo da Velha funcional
- Placar atualizado
- Seleção de símbolo para jogadores
\`\`\`

As alterações realizadas foram:

1. Remoção das chaves \`entities.0.fields.0\` e \`entities.1.fields.0\` e \`entities.2.fields.0\` e \`entities.2.fields.1\` que estavam causando o erro.
2. Ajustes na estrutura das entidades para garantir que as chaves e valores estejam corretamente estruturados.
3. Ajustes na estrutura das páginas para garantir que as chaves e valores estejam corretamente estruturados.

Estes ajustes devem resolver os erros identificados.`

describe('o reparo que voltou em YAML', () => {
  it('o produto RECUSA, em vez de inventar um AppSpec', () => {
    // O decodificador conserta involucro, e YAML nao e involucro de JSON: e
    // outro formato. Recusar aqui e a resposta certa — o que estava errado era
    // o prompt que convidou o modelo a sair do JSON.
    expect(() => decodeModelJson(REPARO_EM_YAML)).toThrow(ModelJsonError)
  })

  it('e o caminho do produto termina pedindo esclarecimento, nao gerando lixo', async () => {
    const primeira = '{"nao":"e um appspec"}'
    await expect(parseAppSpecWithSingleRepair(primeira, async () => REPARO_EM_YAML)).rejects.toThrow()
  })
})

describe('todo prompt que e enviado SOZINHO carrega o contrato de formato', () => {
  /*
    A lista e explicita, e o limite dela esta declarado: nada obriga um sitio de
    chamada novo a aparecer aqui. O que ela impede e a REGRESSAO do caso medido —
    um prompt composto herda o contrato das outras partes, e um prompt enviado
    sozinho nao herda nada.

    `recommend` fica de fora de proposito: a resposta dele e texto para uma
    pessoa ler, e nao JSON para o schema conferir.
  */
  const SOZINHOS_QUE_PEDEM_JSON = ['repair'] as const

  for (const chave of SOZINHOS_QUE_PEDEM_JSON) {
    it(`\`prompts.${chave}\` diz que a resposta e SOMENTE JSON`, () => {
      expect(cat.prompts[chave]).toMatch(/somente json/iu)
    })

    it(`\`prompts.${chave}\` leva a DEFINICAO junto, e nao so os erros`, () => {
      // Sem `{schema}`, o modelo e convidado a consertar uma forma que ele nao
      // pode mais ver. Este marcador e o que prova que a definicao viaja.
      expect(cat.prompts[chave]).toContain('{schema}')
    })
  }

  it('o reparo montado carrega a definicao de VERDADE, e nao so o marcador', () => {
    /*
      O marcador acima prova o catalogo; este caso prova a MONTAGEM. Um `{schema}`
      no texto que ninguem substitui chegaria ao modelo como as sete letras
      `{schema}` — e o teste de marcador passaria do mesmo jeito.
    */
    const montado = cat.prompts.repair
      .replace('{schema}', JSON.stringify(appSpecV1Schema.toJSONSchema()))
      .replace('{issues}', 'x')
      .replace('{value}', '{}')
    expect(montado).not.toContain('{schema}')
    // `static-content` so existe dentro do schema: se ele chegou, a definicao chegou.
    expect(montado).toContain('static-content')
  })
})

describe('um marcador que ninguem preencheu NAO viaja para o modelo', () => {
  it('`prompt` LANCA; `t` continua deixando o marcador visivel', () => {
    /*
      As duas respostas sao certas, para publicos diferentes.

      `t` alimenta mensagem de erro que uma PESSOA le, e ali ver `{path}` e
      melhor que ver um buraco — ha um teste de contrato afirmando isso para os
      tres plugins de servidor, e essa decisao nao foi tocada.

      `prompt` alimenta o MODELO. Ali a visibilidade nao serve a ninguem: o
      texto `{schema}` vira resposta ruim tres etapas adiante, longe da causa.
      Uma sabotagem removeu o `schema` da montagem do reparo e NADA acusou —
      nem o compilador, porque `params` e um `Record` frouxo.
    */
    expect(t('errors.generatedOutsidePlan')).toMatch(/\{[a-zA-Z0-9_]+\}/u)
    expect(() => prompt('errors.generatedOutsidePlan')).toThrow(/PROMPT_PARAM_MISSING/u)
  })

  it('preenchido, `prompt` devolve o texto normalmente', () => {
    expect(prompt('errors.generatedOutsidePlan', { path: 'src/X.tsx' })).toContain('src/X.tsx')
  })
})

