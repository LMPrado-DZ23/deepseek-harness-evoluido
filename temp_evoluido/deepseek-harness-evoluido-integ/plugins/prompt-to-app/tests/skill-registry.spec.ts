import { describe, expect, it, vi } from 'vitest'
import { assembleContext } from '../src/context.ts'
import {
  MAX_SKILL_FRACTION, hubSkillLoader, loadSkills, matchesRequest, selectSkills, skillCardsFrom,
  type SkillCard, type SkillIntegrationShape,
} from '../src/skill-registry.ts'

function card(over: Partial<SkillCard> = {}): SkillCard {
  return {
    skill_id: 'formularios', name: 'Formulários acessíveis',
    trigger: 'formulario cadastro campos acessibilidade',
    body_chars: 100, source: 'integration:hub-1 manifest:abc', enabled: true,
    ...over,
  }
}

describe('a escolha acontece sobre a FICHA, e nao sobre o corpo', () => {
  it('nenhum corpo e buscado para decidir', async () => {
    // Este e o coracao do carregamento progressivo: se a escolha precisasse do
    // corpo, nao haveria progressividade nenhuma — so carregar e torcer.
    const load = vi.fn(async () => 'x'.repeat(100))
    const escolha = selectSkills([card()], 'preciso de um formulario de cadastro', 10_000)
    expect(load).not.toHaveBeenCalled()
    expect(escolha.chosen.map(item => item.skill_id)).toEqual(['formularios'])
    await loadSkills(escolha.chosen, { load })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('o custo declarado sai da escolha, sem nenhuma ida de rede', () => {
    const escolha = selectSkills([card({ body_chars: 250 })], 'formulario', 10_000)
    expect(escolha.declared_chars).toBe(250)
  })
})

describe('o casamento e por PALAVRA, e nao por trecho', () => {
  it('uma palavra DENTRO de outra nao casa', () => {
    // Uma habilidade escolhida por coincidencia de letras nao e um erro de
    // relevancia: e uma REGRA que ninguem escolheu, seguida por um agente.
    // `forma` esta dentro de `formulario`, e `data` dentro de `database`: as
    // duas casariam numa comparacao por trecho, e nenhuma delas e a mesma
    // palavra.
    expect(matchesRequest(card({ trigger: 'forma geometrica' }), 'preciso de um formulario')).toBe(false)
    expect(matchesRequest(card({ trigger: 'database postgres' }), 'onde guardo a data de nascimento')).toBe(false)
    // E o casamento de verdade continua acontecendo.
    expect(matchesRequest(card({ trigger: 'calendario agenda' }), 'quero um calendario')).toBe(true)
  })

  it('acento e caixa nao decidem nada', () => {
    expect(matchesRequest(card({ trigger: 'FORMULÁRIO' }), 'preciso de formulario')).toBe(true)
  })

  it('palavra de ligacao nao casa: `para` casaria com quase tudo', () => {
    expect(matchesRequest(card({ trigger: 'para com que uma' }), 'para o meu site')).toBe(false)
  })

  it('pedido vazio nao casa com nada, e nao casa com tudo', () => {
    // O caso perigoso e o inverso do intuitivo: um pedido vazio que casasse
    // com tudo carregaria TODA instrucao de terceiro do registro.
    expect(matchesRequest(card(), '')).toBe(false)
    expect(matchesRequest(card(), '   !!!   ')).toBe(false)
  })
})

describe('o que NAO entra, e por que', () => {
  it('integracao desligada e DISABLED, e nao "nao casou"', () => {
    // As duas mandam a pessoa fazer coisas diferentes: uma pede ligar, a outra
    // pede escrever o pedido de outro jeito.
    const escolha = selectSkills([card({ enabled: false })], 'formulario de cadastro', 10_000)
    expect(escolha.chosen).toEqual([])
    expect(escolha.skipped).toEqual([{ skill_id: 'formularios', reason: 'DISABLED' }])
  })

  it('a conferencia de desligada vem ANTES da de casamento', () => {
    const escolha = selectSkills([card({ enabled: false })], 'nada a ver', 10_000)
    expect(escolha.skipped[0]!.reason).toBe('DISABLED')
  })

  it('habilidade grande demais e OVERSIZED, mesmo com teto sobrando', () => {
    // Uma habilidade que ocupa o contexto inteiro nao deixa espaco para o
    // pedido da pessoa: o agente segue a instrucao de terceiro e ignora quem
    // pediu.
    const teto = 10_000
    const grande = Math.floor(teto * MAX_SKILL_FRACTION) + 1
    const escolha = selectSkills([card({ body_chars: grande })], 'formulario', teto)
    expect(escolha.skipped).toEqual([{ skill_id: 'formularios', reason: 'OVERSIZED' }])
  })

  it('exatamente no limite CABE: o teto e inclusivo', () => {
    const teto = 10_000
    const noLimite = Math.floor(teto * MAX_SKILL_FRACTION)
    expect(selectSkills([card({ body_chars: noLimite })], 'formulario', teto).chosen).toHaveLength(1)
  })

  it('estourar o teto NAO interrompe o laco: a pequena depois da grande ainda cabe', () => {
    // Parar no primeiro estouro descartaria por POSICAO o que deveria ser
    // descartado por tamanho.
    // Sao precisas CINCO habilidades para chegar aqui, e isso e consequencia do
    // desenho, nao do teste: com o limite por habilidade em um quarto do teto,
    // duas nunca estouram, e quatro sao o maximo que cabe.
    const escolha = selectSkills([
      card({ skill_id: 'a', body_chars: 900 }),
      card({ skill_id: 'b', body_chars: 900 }),
      card({ skill_id: 'c', body_chars: 900 }),
      card({ skill_id: 'd', body_chars: 900 }),
      card({ skill_id: 'nao-cabe', body_chars: 900 }),
      card({ skill_id: 'pequena', body_chars: 100 }),
    ], 'formulario', 4_000)
    expect(escolha.chosen.map(item => item.skill_id)).toEqual(['a', 'b', 'c', 'd', 'pequena'])
    expect(escolha.skipped).toEqual([{ skill_id: 'nao-cabe', reason: 'BUDGET' }])
    expect(escolha.declared_chars).toBe(3_700)
  })

  it('a mesma habilidade duas vezes entra uma vez so', () => {
    const escolha = selectSkills([card(), card()], 'formulario', 10_000)
    expect(escolha.chosen).toHaveLength(1)
    expect(escolha.skipped).toEqual([{ skill_id: 'formularios', reason: 'DUPLICATE' }])
  })

  it('a ordem de entrada e a ordem de preferencia, e a escolha e reproduzivel', () => {
    // Duas montagens do mesmo pedido tem de produzir o MESMO contexto, ou
    // ninguem consegue explicar uma resposta ruim.
    const lista = Array.from({ length: 5 }, (_, index) =>
      card({ skill_id: `s${String(index)}`, body_chars: 700 }))
    const uma = selectSkills(lista, 'formulario', 3_000)
    const outra = selectSkills(lista, 'formulario', 3_000)
    expect(uma.chosen.map(item => item.skill_id)).toEqual(['s0', 's1', 's2', 's3'])
    expect(uma.skipped).toEqual([{ skill_id: 's4', reason: 'BUDGET' }])
    expect(uma).toEqual(outra)
  })
})

describe('o corpo e CONFERIDO contra o que a ficha prometeu', () => {
  it('corpo maior que o declarado e RECUSADO, e nao truncado', () => {
    // Truncar instrucao e pior que recusar: meia regra se le como regra
    // inteira, e o agente segue a metade.
    const load = vi.fn(async () => 'x'.repeat(500))
    return loadSkills([card({ body_chars: 100 })], { load }).then(saida => {
      expect(saida.sections).toEqual([])
      expect(saida.refused).toEqual([{ skill_id: 'formularios', reason: 'SIZE_MISMATCH', declared: 100, actual: 500 }])
    })
  })

  it('corpo MENOR que o declarado tambem e recusado', () => {
    // O registro descreveu uma coisa e entregou outra. Que a outra seja menor
    // nao a torna a mesma coisa.
    const load = vi.fn(async () => 'x'.repeat(10))
    return loadSkills([card({ body_chars: 100 })], { load })
      .then(saida => { expect(saida.refused).toHaveLength(1) })
  })

  it('a recusa e POR HABILIDADE: a que mentiu nao derruba as outras', async () => {
    const load = vi.fn(async (id: string) => id === 'mentirosa' ? 'x'.repeat(999) : 'y'.repeat(100))
    const saida = await loadSkills([
      card({ skill_id: 'mentirosa' }), card({ skill_id: 'honesta' }),
    ], { load })
    expect(saida.sections.map(section => section.id)).toEqual(['skill:honesta'])
    expect(saida.refused.map(item => item.skill_id)).toEqual(['mentirosa'])
  })

  it('a parte carregada entra como INSTRUCAO, e nao como evidencia', async () => {
    // Como evidencia ela seria cortavel pelo teto, e uma instrucao cortada
    // pela metade se le como uma instrucao inteira.
    const saida = await loadSkills([card()], { load: async () => 'x'.repeat(100) })
    expect(saida.sections[0]!.kind).toBe('instruction')
  })

  it('a procedencia atravessa ate o contexto montado', async () => {
    // "De onde saiu essa regra?" e a primeira pergunta depois de uma resposta
    // estranha, e ela precisa ter resposta.
    const saida = await loadSkills([card()], { load: async () => 'x'.repeat(100) })
    const montado = assembleContext([
      { id: 'sistema', kind: 'instruction', priority: 0, text: 'instrucao base', source: 'studio' },
      ...saida.sections,
    ], { budgetChars: 10_000 })
    const linha = montado.ledger.included.find(item => item.id === 'skill:formularios')
    expect(linha?.source).toBe('integration:hub-1 manifest:abc')
    expect(montado.prompt).toContain('x'.repeat(100))
  })
})

describe('as fichas saem do registro de integracoes', () => {
  function integracao(over: Partial<SkillIntegrationShape> = {}): SkillIntegrationShape {
    return {
      integration_id: 'hub-1', kind: 'skill', enabled: true,
      manifest: {
        name: 'Formularios acessiveis',
        skill: { trigger: 'formulario cadastro campos', body_chars: 400 },
        provenance: { artifact_sha256: 'a'.repeat(64) },
      },
      ...over,
    }
  }

  it('integracao que nao e habilidade nao vira ficha nem vira lacuna', () => {
    // Ela nao e uma habilidade com problema: ela nao e uma habilidade. Listar
    // como lacuna encheria a lista de coisas que ninguem precisa resolver.
    const saida = skillCardsFrom([integracao({ kind: 'mcp' }), integracao({ kind: 'smtp' })])
    expect(saida.cards).toEqual([])
    expect(saida.gaps).toEqual([])
  })

  it('habilidade SEM tamanho declarado nao vira ficha, e a ausencia e DEVOLVIDA', () => {
    // Sem o tamanho nao existe carregamento progressivo. Ela fica registrada,
    // aparece na lista, e nunca e escolhida — e alguem vai perguntar por que.
    const saida = skillCardsFrom([integracao({
      manifest: { name: 'Sem tamanho', provenance: { artifact_sha256: 'b'.repeat(64) } },
    })])
    expect(saida.cards).toEqual([])
    expect(saida.gaps).toEqual([{ integration_id: 'hub-1', gap: 'NO_DECLARED_SIZE' }])
  })

  it('habilidade sem manifesto tem lacuna PROPRIA, diferente da de sem tamanho', () => {
    const saida = skillCardsFrom([integracao({ manifest: null })])
    expect(saida.gaps).toEqual([{ integration_id: 'hub-1', gap: 'NO_MANIFEST' }])
  })

  it('a procedencia carrega a impressao do ARTEFATO, e nao so a linha do registro', () => {
    // O identificador diz qual linha; a impressao diz quais BYTES.
    const saida = skillCardsFrom([integracao()])
    expect(saida.cards[0]!.source).toBe(`integration:hub-1 artifact:${'a'.repeat(64)}`)
  })

  it('sem procedencia, a ficha ainda diz de onde veio — o que da para dizer', () => {
    const saida = skillCardsFrom([integracao({
      manifest: { name: 'Sem procedencia', skill: { trigger: 'formulario cadastro', body_chars: 100 } },
    })])
    expect(saida.cards[0]!.source).toBe('integration:hub-1')
  })

  it('o estado LIGADO atravessa ate a ficha, e nao e presumido', () => {
    // Presumir ligado carregaria instrucao de terceiro de uma integracao que
    // alguem desligou de proposito.
    expect(skillCardsFrom([integracao({ enabled: false })]).cards[0]!.enabled).toBe(false)
    expect(skillCardsFrom([integracao({ enabled: true })]).cards[0]!.enabled).toBe(true)
  })

  it('a ficha desligada chega a escolha e e recusada la, com o motivo certo', () => {
    const { cards } = skillCardsFrom([integracao({ enabled: false })])
    expect(selectSkills(cards, 'preciso de um formulario', 10_000).skipped)
      .toEqual([{ skill_id: 'hub-1', reason: 'DISABLED' }])
  })
})

describe('o carregador ligado ao registro de integracoes', () => {
  it('passa o identificador adiante sem mexer', async () => {
    const skillBody = vi.fn(async () => 'x'.repeat(100))
    await hubSkillLoader({ skillBody }).load('hub-1')
    expect(skillBody).toHaveBeenCalledWith('hub-1')
  })

  it('a recusa do registro SOBE, e nao vira texto vazio', async () => {
    // "Desligada", "sem texto" e "texto trocado depois de instalado" mandam
    // fazer coisas diferentes, e a ultima e um incidente.
    const skillBody = vi.fn(async () => { throw new Error('Esta habilidade esta desligada.') })
    await expect(hubSkillLoader({ skillBody }).load('hub-1')).rejects.toThrow('desligada')
  })

  it('a recusa derruba SO aquela habilidade, e nao o pedido da pessoa', async () => {
    // Uma habilidade desligada nao pode levar junto o trabalho de quem pediu.
    const loader = hubSkillLoader({
      skillBody: async id => { if (id === 'quebrada') throw new Error('Esta habilidade esta desligada.'); return 'y'.repeat(100) },
    })
    const saida = await loadSkills([card({ skill_id: 'quebrada' }), card({ skill_id: 'boa' })], loader)
    expect(saida.sections.map(section => section.id)).toEqual(['skill:boa'])
    expect(saida.refused).toEqual([{ skill_id: 'quebrada', reason: 'LOAD_FAILED', detail: 'Esta habilidade esta desligada.' }])
  })

  it('o MOTIVO da recusa distingue tamanho de recusa do registro', async () => {
    // Juntar os dois apagaria o que importa: um e o registro tendo entregue
    // outra coisa, o outro e o registro tendo recusado entregar.
    const saida = await loadSkills([
      card({ skill_id: 'mentiu', body_chars: 10 }),
      card({ skill_id: 'recusou', body_chars: 100 }),
    ], hubSkillLoader({
      skillBody: async id => { if (id === 'recusou') throw new Error('Esta habilidade esta desligada.'); return 'z'.repeat(100) },
    }))
    expect(saida.refused.map(item => item.reason)).toEqual(['SIZE_MISMATCH', 'LOAD_FAILED'])
  })
})
