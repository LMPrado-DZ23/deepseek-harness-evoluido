import { describe, expect, it } from 'vitest'
import { appSpecV1Schema } from '../src/appspec.js'
import { decodeModelJson } from '../src/model-json.js'
import { CATEGORY_REQUIRES_DATA_MODEL, assertCategoryCanGenerate } from '../src/planner.js'

/**
 * O ESTADO DO APLICATIVO, e a cerca que ele derruba.
 *
 * Esta e a resposta LITERAL do `qwen2.5:3b` da maquina do titular, em
 * 18/09/2026, ao prompt REAL de intake deste plugin — o mesmo que o
 * `IntakeEngine` monta, com `appSpecV1Schema.toJSONSchema()` dentro. O pedido
 * foi "um jogo da velha para jogar contra o computador, com placar".
 *
 * O modelo descreveu o tabuleiro e o placar como `static-content` com campos
 * ESTRUTURADOS — nome, tipo, opcoes —, que e a forma de `database`. O schema
 * recusou, a rodada de reparo nao consertou nem com o schema na mao, e a
 * jornada parou ali.
 *
 * Ele nao errou por ignorancia. Um tabuleiro NAO E conteudo estatico nem tabela
 * de banco, e existiam so essas duas caixas: ele escolheu a menos errada. A
 * cerca estava no produto, e nao no modelo.
 */
const RESPOSTA_JOGO_DA_VELHA = `{
  "schema_version": 1,
  "problem": "Criar um jogo da velha para jogar contra o computador com placar",
  "audience": "Todos",
  "journeys": [
    "Jogar Jogo da Velha"
  ],
  "pages": [
    {
      "name": "Jogador 1",
      "sections": [
        "Escolha seu símbolo",
        "Jogada do Jogador 1",
        "Placar"
      ]
    },
    {
      "name": "Jogador 2",
      "sections": [
        "Escolha seu símbolo",
        "Jogada do Jogador 2",
        "Placar"
      ]
    },
    {
      "name": "Placar",
      "sections": [
        "Jogador 1",
        "Jogador 2"
      ]
    }
  ],
  "entities": [
    {
      "name": "Jogador 1",
      "kind": "static-content",
      "fields": [
        {
          "name": "Símbolo",
          "type": "selection",
          "options": [
            "X",
            "O"
          ]
        }
      ]
    },
    {
      "name": "Jogador 2",
      "kind": "static-content",
      "fields": [
        {
          "name": "Símbolo",
          "type": "selection",
          "options": [
            "X",
            "O"
          ]
        }
      ]
    },
    {
      "name": "Placar",
      "kind": "static-content",
      "fields": [
        {
          "name": "Jogador 1",
          "type": "number"
        },
        {
          "name": "Jogador 2",
          "type": "number"
        }
      ]
    }
  ],
  "sensitive_data": {
    "detected": [],
    "confirmed_by_user": false
  },
  "accessibility": {
    "wcag_level": "AA",
    "keyboard_required": true,
    "reduced_motion": true
  },
  "language": "pt-BR",
  "acceptance_criteria": [
    "Jogo da Velha funcional",
    "Placar atualizado",
    "Seleção de símbolo para jogadores"
  ]
}`

/**
 * A mesma resposta, trocando SO o discriminante.
 * @returns o valor decodificado.
 */
function comKind(kind: string): unknown {
  const valor = decodeModelJson(RESPOSTA_JOGO_DA_VELHA) as { entities: { kind: string }[] }
  for (const entidade of valor.entities) entidade.kind = kind
  return valor
}

describe('o jogo da velha que o produto recusava', () => {
  it('como o modelo respondeu, o schema RECUSA — e este e o defeito medido', () => {
    const r = appSpecV1Schema.safeParse(decodeModelJson(RESPOSTA_JOGO_DA_VELHA))
    expect(r.success).toBe(false)
  })

  it('com `app-state`, a MESMA resposta vale — so o discriminante mudou', () => {
    // Nenhum outro campo foi tocado: nem pagina, nem criterio, nem campo de
    // entidade. O que faltava era a caixa existir.
    const r = appSpecV1Schema.safeParse(comKind('app-state'))
    expect(r.success).toBe(true)
  })
})

describe('o que `app-state` e, e o que ele nao e', () => {
  it('NAO conta como modelo de dados: um tabuleiro nao e banco', () => {
    /*
      Se contasse, um jogo passaria a exigir banco para ser gerado, e as
      categorias que pedem modelo de dados aceitariam estado no lugar de tabela
      — as duas coisas erradas, em direcoes opostas.
    */
    const spec = appSpecV1Schema.parse(comKind('app-state'))
    expect(CATEGORY_REQUIRES_DATA_MODEL['form-database']).toBe(true)
    expect(() => assertCategoryCanGenerate('form-database', spec)).toThrow()
    // E numa categoria que nao pede banco, ele passa.
    expect(() => assertCategoryCanGenerate('landing-page', spec)).not.toThrow()
  })

  it('NAO guarda referencia a registro', () => {
    // Uma chave estrangeira promete que o outro lado continua existindo, e
    // estado nao sobrevive ao recarregamento: a promessa seria falsa no
    // instante seguinte.
    const base = appSpecV1Schema.parse(comKind('app-state')) as unknown as {
      entities: { kind: string; fields: unknown[] }[]
    }
    base.entities[0]!.fields = [{ name: 'dono', type: 'reference', required: true, reference_entity: 'Jogador 1' }]
    const r = appSpecV1Schema.safeParse(base)
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.success ? [] : r.error.issues)).toContain('recarregamento')
  })
})
