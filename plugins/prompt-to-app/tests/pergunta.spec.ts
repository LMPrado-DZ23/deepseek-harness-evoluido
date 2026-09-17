import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERGUNTA_QUESTION_ID, MAX_PERGUNTA, MIN_PERGUNTA, perguntaNormalizada, respostaEmTexto, respostaSobreATarefa, respostasDoQuestionario, type FatosDaTarefa } from '../src/pergunta.js'
import { projectStateSchema, studioIntakeTurnSchema, studioRunSchema } from '../src/model.js'
import type { StudioIntakeTurn } from '../src/model.js'

const FATOS: FatosDaTarefa = {
  estado: 'VERIFIED_PROTOTYPE', tentativasFeitas: 1, tentativa: 1,
  etapa: 'verify', estadoDaTentativa: 'PASSED', criterios: 3, provas: 2, custoEstimadoUsd: 0.1234,
}

describe('o texto da pergunta', () => {
  it('perde espaço repetido e das pontas', () => {
    expect(perguntaNormalizada('  por que   falhou?  ')).toBe('por que falhou?')
  })

  it('NÃO perde maiúscula nem acento — o texto é da pessoa', () => {
    expect(perguntaNormalizada('Por que o Botão não é Verde?')).toBe('Por que o Botão não é Verde?')
  })

  it('recusa o que é curto demais e o que é longo demais', () => {
    expect(perguntaNormalizada('a'.repeat(MIN_PERGUNTA - 1))).toBeNull()
    expect(perguntaNormalizada('a'.repeat(MAX_PERGUNTA + 1))).toBeNull()
    expect(perguntaNormalizada('a'.repeat(MAX_PERGUNTA))).toHaveLength(MAX_PERGUNTA)
  })

  it('só espaço é nada, e nada não é pergunta', () => {
    expect(perguntaNormalizada('      ')).toBeNull()
  })
})

describe('a resposta sobre a tarefa', () => {
  it('diz onde a tarefa está, em português de quem não programa', () => {
    const linhas = respostaSobreATarefa(FATOS)
    expect(linhas[0]!.valor).toBe('há um protótipo conferido para você abrir')
  })

  it('custo NÃO registrado não vira zero', () => {
    // Um custo desconhecido mostrado como US$ 0,00 é a mentira mais barata que
    // um painel de consumo consegue contar.
    const linhas = respostaSobreATarefa({ ...FATOS, custoEstimadoUsd: null })
    const custo = linhas.find(linha => linha.rotulo.includes('Custo'))!
    expect(custo.valor).toContain('não registrado')
    expect(custo.valor).not.toContain('0')
  })

  it('custo registrado aparece como número, inclusive quando é zero DE VERDADE', () => {
    const linhas = respostaSobreATarefa({ ...FATOS, custoEstimadoUsd: 0 })
    expect(linhas.find(linha => linha.rotulo.includes('Custo'))!.valor).toBe('US$ 0.0000')
  })

  it('sem tentativa nenhuma, não inventa uma', () => {
    const linhas = respostaSobreATarefa({ ...FATOS, tentativasFeitas: 0, tentativa: null, etapa: null, estadoDaTentativa: null })
    expect(linhas.some(linha => linha.rotulo === 'A última tentativa')).toBe(false)
  })

  it('DIZ que não é um assistente, em vez de deixar a pessoa achar que é', () => {
    const texto = respostaEmTexto(respostaSobreATarefa(FATOS))
    expect(texto).toContain('não passa por nenhum modelo')
  })

  it('TODO estado de tarefa tem tradução — nenhum cai num rótulo cru', () => {
    // Se o domínio ganhar um estado e ninguém escrever o que ele quer dizer, é
    // aqui que aparece, e não na frente da pessoa.
    for (const estado of projectStateSchema.options) {
      const valor = respostaSobreATarefa({ ...FATOS, estado }).at(0)!.valor
      expect(valor).not.toContain(estado)
      expect(valor.length).toBeGreaterThan(3)
    }
  })

  it('TODA etapa e TODO estado de tentativa também têm tradução', () => {
    const etapas = studioRunSchema.shape.stage.options
    const estados = studioRunSchema.shape.state.options
    for (const etapa of etapas) {
      for (const estadoDaTentativa of estados) {
        const linha = respostaSobreATarefa({ ...FATOS, etapa, estadoDaTentativa })
          .find(item => item.rotulo === 'A última tentativa')!
        // `t` lança `I18N_KEY_MISSING` quando a chave não existe, então
        // chegar aqui já prova que as duas foram traduzidas. O que se confere
        // é que o identificador cru não vazou para a frase — e a conferência é
        // pelo estado, que é maiúsculo e não casa com palavra em português.
        // ("testando" CONTÉM "test": conferir a etapa por substring reprovaria
        // uma tradução correta, e essa asserção ingênua já reprovou aqui.)
        expect(linha.valor).not.toContain(estadoDaTentativa)
        expect(linha.valor.length).toBeGreaterThan(etapa.length + estadoDaTentativa.length)
      }
    }
  })

  it('o texto guardado tem uma linha por fato, para ser relido daqui a um ano', () => {
    const linhas = respostaSobreATarefa(FATOS)
    expect(respostaEmTexto(linhas).split('\n')).toHaveLength(linhas.length)
  })
})

function turno(question_id: StudioIntakeTurn['question_id'], question: string, answer: string): StudioIntakeTurn {
  return {
    turn_id: `t-${question_id}-${answer}`, project_id: 'proj-1', org_id: 'org-a', tenant_id: 'tenant-a',
    question_id, question, answer, recommended: false, route: null, model: null,
    created_at: '2026-09-17T12:00:00.000Z',
  }
}

describe('as respostas do questionário', () => {
  it('a PERGUNTA da pessoa não é resposta do questionário', () => {
    /*
      Este é o teste que faltava. A escolha era uma lista NEGADA dentro da
      montagem do corpo da rota, e a sabotagem que a restaurava SOBREVIVEU:
      nenhum teste olhava para ela. Sem isto, a resposta que o Studio dá a uma
      pergunta entra em `answers` — que é lido para escolher a próxima
      pergunta, para detectar dado sensível e para MONTAR A ESPECIFICAÇÃO do
      aplicativo.
    */
    const respostas = respostasDoQuestionario([
      turno('audience', 'para quem é?', 'clientes locais'),
      turno('pergunta-da-pessoa', 'por que falhou?', 'Onde esta tarefa está: não passou'),
    ])
    expect(respostas).toEqual({ audience: 'clientes locais' })
  })

  it('a confirmação de dado sensível também fica de fora, e quem a quer lê pelo id dela', () => {
    const respostas = respostasDoQuestionario([
      turno('goal', 'qual o objetivo?', 'receber contatos'),
      turno('sensitive-confirmation', 'confirma?', 'confirmado'),
    ])
    expect(Object.keys(respostas)).toEqual(['goal'])
  })

  it('TODO `question_id` do domínio está decidido — nenhum entra por descuido', () => {
    // Um `question_id` novo no esquema cai aqui até alguém dizer se ele é
    // resposta do questionário. Lista negada não faz essa pergunta a ninguém.
    const decididos = new Set(['audience', 'goal', 'content', 'sensitive-confirmation', 'pergunta-da-pessoa'])
    expect(new Set(studioIntakeTurnSchema.shape.question_id.options)).toEqual(decididos)
    const dentro = respostasDoQuestionario(
      studioIntakeTurnSchema.shape.question_id.options.map(id => turno(id, 'p', `resposta-${id}`)),
    )
    expect(Object.keys(dentro).sort()).toEqual(['audience', 'content', 'goal'])
  })

  it('a resposta mais recente do mesmo `question_id` é a que vale', () => {
    const respostas = respostasDoQuestionario([
      turno('content', 'o que tem?', 'primeira'),
      turno('content', 'o que tem?', 'segunda'),
    ])
    expect(respostas.content).toBe('segunda')
  })
})

describe('o contrato entre o servidor e a tela', () => {
  it('a tela compara o MESMO `question_id` que o servidor grava', () => {
    /*
      A tela não pode importar este plugin — são dois projetos TypeScript e dois
      pacotes —, então ela repete o valor. Repetir é a segunda verdade mais
      barata que existe: os dois lados discordariam no primeiro conserto de um
      deles, e o sintoma seria a pergunta da pessoa aparecendo como fala do
      Studio, sem erro nenhum em lugar nenhum.

      Este teste lê o arquivo da tela e compara. Não é elegante; é o que pega.
    */
    const fonte = readFileSync(new URL('../../../apps/studio-web/src/tarefa/transcricao.ts', import.meta.url), 'utf8')
    const achado = /export const PERGUNTA_DA_PESSOA = '([^']+)'/u.exec(fonte)
    expect(achado?.[1]).toBe(PERGUNTA_QUESTION_ID)
  })
})
