/**
 * E-03 — as regras que a tela do plano usa, sem React.
 */
import { describe, expect, it } from 'vitest'
import { criteriaFromText, criteriaToText, moveRequest, removeRequest, sliceEditRequest, viewRevision, type PlanView } from './planEdit'

function plan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    revision: 3,
    slices: [
      { slice_id: 's1', title: 'Agenda', description: 'Marcar horário', acceptance_criteria: ['dá para marcar'] },
      { slice_id: 's2', title: 'Contato', description: 'Falar com a loja', acceptance_criteria: ['tem telefone'] },
      { slice_id: 's3', title: 'Sobre', description: 'Quem somos', acceptance_criteria: ['tem texto'] },
    ],
    ...overrides,
  }
}

describe('E-03 critérios digitados por uma pessoa', () => {
  it('uma linha por critério, e linha em branco não vira critério vazio', () => {
    expect(criteriaFromText('dá para marcar\n\n  chega e-mail  \n')).toEqual(['dá para marcar', 'chega e-mail'])
    expect(criteriaFromText('   \n \n')).toEqual([])
    expect(criteriaToText(['a', 'b'])).toBe('a\nb')
  })
})

describe('E-03 mover', () => {
  it('troca com a vizinha e manda a ordem inteira', () => {
    expect(moveRequest(plan(), 's2', 'up')).toEqual({ base_revision: 3, order: ['s2', 's1', 's3'] })
    expect(moveRequest(plan(), 's2', 'down')).toEqual({ base_revision: 3, order: ['s1', 's3', 's2'] })
  })
  it('a primeira não sobe e a última não desce: o botão fica apagado em vez de mentir', () => {
    expect(moveRequest(plan(), 's1', 'up')).toBeUndefined()
    expect(moveRequest(plan(), 's3', 'down')).toBeUndefined()
    expect(moveRequest(plan(), 'inexistente', 'up')).toBeUndefined()
  })
})

describe('E-03 tirar', () => {
  it('tira pelo id', () => {
    expect(removeRequest(plan(), 's2')).toEqual({ base_revision: 3, removed: ['s2'] })
  })
  it('a última que sobrou não pode ser tirada: um plano vazio não é um plano', () => {
    expect(removeRequest(plan({ slices: [{ slice_id: 's1', title: 'A', description: 'B', acceptance_criteria: ['c'] }] }), 's1')).toBeUndefined()
  })
})

describe('E-03 gravar a edição de uma parte', () => {
  it('manda SÓ o que mudou', () => {
    expect(sliceEditRequest(plan(), 's1', { title: 'Agendamento', description: 'Marcar horário', criteriaText: 'dá para marcar' }))
      .toEqual({ base_revision: 3, slices: [{ slice_id: 's1', title: 'Agendamento' }] })
  })
  it('nada mudou: nada é enviado — um pedido vazio gastaria uma revisão e faria a outra aba receber um conflito à toa', () => {
    expect(sliceEditRequest(plan(), 's1', { title: 'Agenda', description: 'Marcar horário', criteriaText: 'dá para marcar' })).toBeUndefined()
    // Espaço em volta não é mudança.
    expect(sliceEditRequest(plan(), 's1', { title: '  Agenda  ', description: 'Marcar horário', criteriaText: 'dá para marcar\n' })).toBeUndefined()
  })
  it('esvaziar um campo NÃO apaga o que estava lá', () => {
    // Apagar o título porque a caixa ficou vazia transformaria um deslize em perda.
    expect(sliceEditRequest(plan(), 's1', { title: '', description: '', criteriaText: '' })).toBeUndefined()
  })
  it('critérios reescritos chegam como lista', () => {
    expect(sliceEditRequest(plan(), 's2', { title: 'Contato', description: 'Falar com a loja', criteriaText: 'tem telefone\ntem e-mail' }))
      .toEqual({ base_revision: 3, slices: [{ slice_id: 's2', acceptance_criteria: ['tem telefone', 'tem e-mail'] }] })
  })
  it('fatia que não existe não vira pedido', () => {
    expect(sliceEditRequest(plan(), 'nao-existe', { title: 'x', description: 'y', criteriaText: 'z' })).toBeUndefined()
  })
  it('toda alteração carrega a revisão que a pessoa estava vendo', () => {
    const { revision: _revision, ...rest } = plan()
    const legacy: PlanView = rest
    expect(viewRevision(legacy)).toBe(1)
    expect(moveRequest(legacy, 's2', 'up')?.base_revision).toBe(1)
    expect(removeRequest(legacy, 's2')?.base_revision).toBe(1)
  })
})
