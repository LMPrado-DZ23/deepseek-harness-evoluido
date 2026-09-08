/**
 * E-03 — o plano editável antes da geração.
 *
 * O teste mais importante deste arquivo é o que garante que `planned_files`
 * NÃO vem do pedido. Essa lista é a autorização de escrita do gerador (E-09):
 * se um campo de formulário conseguisse acrescentar um caminho ali, o editor
 * de plano viraria escrita arbitrária no espaço de trabalho e desfaria a
 * garantia mais bem provada do produto.
 */
import { describe, expect, it } from 'vitest'
import { applyPlanEdit, planEditSchema, PlanEditError, planRevision } from '../src/plan-edit.ts'
import type { StudioPlan } from '../src/model.ts'

const NOW = '2026-09-08T12:00:00.000Z'

function plan(overrides: Partial<StudioPlan> = {}): StudioPlan {
  return {
    plan_id: 'plan-1', spec_id: 'spec-1', project_id: 'proj-1', org_id: 'org-1', tenant_id: 'ten-1',
    revision: 1, status: 'PROPOSED',
    slices: [
      { slice_id: 's1', title: 'Agenda', description: 'Marcar horário', acceptance_criteria: ['dá para marcar'], planned_files: ['src/agenda.tsx'] },
      { slice_id: 's2', title: 'Contato', description: 'Falar com a loja', acceptance_criteria: ['tem telefone'], planned_files: ['src/contato.tsx'] },
      { slice_id: 's3', title: 'Sobre', description: 'Quem somos', acceptance_criteria: ['tem texto'], planned_files: ['src/sobre.tsx'] },
    ],
    created_at: '2026-09-08T11:00:00.000Z', updated_at: '2026-09-08T11:00:00.000Z',
    ...overrides,
  } as StudioPlan
}
function edit(overrides: Record<string, unknown> = {}) {
  return planEditSchema.parse({ base_revision: 1, ...overrides })
}

describe('E-03 o que a pessoa pode mexer', () => {
  it('muda título, descrição e critérios de uma fatia e deixa as outras intactas', () => {
    const before = plan()
    const after = applyPlanEdit(before, edit({ slices: [{ slice_id: 's2', title: 'Fale conosco', description: 'Telefone e e-mail', acceptance_criteria: ['tem telefone', 'tem e-mail'] }] }), NOW)
    expect(after.slices[1]).toMatchObject({ slice_id: 's2', title: 'Fale conosco', description: 'Telefone e e-mail', acceptance_criteria: ['tem telefone', 'tem e-mail'] })
    expect(after.slices[0]).toEqual(before.slices[0])
    expect(after.slices[2]).toEqual(before.slices[2])
  })

  it('campo omitido não é campo apagado: quem só corrigiu o título mantém o resto', () => {
    // Sem isto, um cliente que reenviasse só o que mudou apagaria o trabalho de quem editou antes.
    const after = applyPlanEdit(plan(), edit({ slices: [{ slice_id: 's1', title: 'Agendamento' }] }), NOW)
    expect(after.slices[0]).toEqual({ slice_id: 's1', title: 'Agendamento', description: 'Marcar horário', acceptance_criteria: ['dá para marcar'], planned_files: ['src/agenda.tsx'] })
  })

  it('tira uma fatia que a pessoa não quer', () => {
    const after = applyPlanEdit(plan(), edit({ removed: ['s2'] }), NOW)
    expect(after.slices.map(slice => slice.slice_id)).toEqual(['s1', 's3'])
  })

  it('reordena as fatias', () => {
    const after = applyPlanEdit(plan(), edit({ order: ['s3', 's1', 's2'] }), NOW)
    expect(after.slices.map(slice => slice.slice_id)).toEqual(['s3', 's1', 's2'])
  })

  it('tirar e reordenar na mesma edição: a ordem cita o que sobrou', () => {
    const after = applyPlanEdit(plan(), edit({ removed: ['s1'], order: ['s3', 's2'] }), NOW)
    expect(after.slices.map(slice => slice.slice_id)).toEqual(['s3', 's2'])
  })

  it('a edição avança a revisão, marca a autoria e continua PROPOSED', () => {
    const after = applyPlanEdit(plan(), edit({ removed: ['s3'] }), NOW)
    expect(after.revision).toBe(2)
    expect(after.status).toBe('PROPOSED')
    expect(after.edited_by_person).toBe(true)
    expect(after.updated_at).toBe(NOW)
    // Aprovar continua sendo um ato separado: editar não aprova nada.
    expect(after.status).not.toBe('APPROVED')
  })

  it('limpa o pedido de mudança em texto livre: ele pertencia à revisão anterior', () => {
    const after = applyPlanEdit(plan({ change_request: 'quero um formulário' }), edit({ removed: ['s3'] }), NOW)
    expect(after.change_request).toBeNull()
  })

  it('plano antigo sem revisão vale como revisão 1', () => {
    const { revision: _revision, ...withoutRevision } = plan()
    const legacy = withoutRevision as StudioPlan
    expect(planRevision(legacy)).toBe(1)
    expect(applyPlanEdit(legacy, edit({ removed: ['s2'] }), NOW).revision).toBe(2)
  })
})

describe('E-03 o que a pessoa NÃO pode mexer', () => {
  it('planned_files NUNCA vem do pedido: é a autorização de escrita do gerador', () => {
    // O schema recusa o campo…
    expect(planEditSchema.safeParse({ base_revision: 1, slices: [{ slice_id: 's1', planned_files: ['../../.ssh/authorized_keys'] }] }).success).toBe(false)
    // …e mesmo se ele atravessasse o schema, a aplicação copia da fatia existente.
    const smuggled = { base_revision: 1, slices: [{ slice_id: 's1', title: 'Agenda', planned_files: ['/etc/passwd'] }], removed: [] } as never
    const after = applyPlanEdit(plan(), smuggled, NOW)
    expect(after.slices[0]!.planned_files).toEqual(['src/agenda.tsx'])
  })

  it('não dá para acrescentar fatia nova: uma fatia nova precisaria de planned_files', () => {
    expect(() => applyPlanEdit(plan(), edit({ slices: [{ slice_id: 's9', title: 'Nova' }] }), NOW)).toThrow(PlanEditError)
    try { applyPlanEdit(plan(), edit({ slices: [{ slice_id: 's9', title: 'Nova' }] }), NOW) } catch (error) {
      expect((error as PlanEditError).code).toBe('NOT_FOUND')
    }
  })

  it('não dá para tirar uma fatia que não existe', () => {
    expect(() => applyPlanEdit(plan(), edit({ removed: ['s9'] }), NOW)).toThrow(PlanEditError)
  })

  it('não dá para esvaziar o plano: gerar nada não é um plano', () => {
    try { applyPlanEdit(plan(), edit({ removed: ['s1', 's2', 's3'] }), NOW); expect.unreachable() } catch (error) {
      expect((error as PlanEditError).code).toBe('INVALID')
    }
  })

  it('tirar e alterar a mesma fatia é contraditório e é recusado, não resolvido em silêncio', () => {
    try { applyPlanEdit(plan(), edit({ removed: ['s2'], slices: [{ slice_id: 's2', title: 'x' }] }), NOW); expect.unreachable() } catch (error) {
      expect((error as PlanEditError).code).toBe('INVALID')
    }
  })

  it('uma ordem parcial é recusada: inventar onde ficam as outras seria decidir pela pessoa', () => {
    for (const order of [['s1'], ['s1', 's2'], ['s1', 's2', 's3', 's3'], ['s1', 's2', 's9']]) {
      expect(() => applyPlanEdit(plan(), edit({ order }), NOW)).toThrow(PlanEditError)
    }
  })

  it('não dá para editar depois de aprovado: o construído deixaria de ser o aprovado', () => {
    for (const status of ['APPROVED', 'CHANGE_REQUESTED'] as const) {
      try { applyPlanEdit(plan({ status }), edit({ removed: ['s3'] }), NOW); expect.unreachable() } catch (error) {
        expect((error as PlanEditError).code).toBe('UNAVAILABLE')
      }
    }
  })

  it('duas abas abertas: a segunda gravação é RECUSADA, não vence por ser a segunda', () => {
    const first = applyPlanEdit(plan(), edit({ removed: ['s3'] }), NOW)
    expect(first.revision).toBe(2)
    // A segunda aba ainda achava que estava na revisão 1.
    try { applyPlanEdit(first, edit({ base_revision: 1, removed: ['s2'] }), NOW); expect.unreachable() } catch (error) {
      expect((error as PlanEditError).code).toBe('STALE')
    }
  })

  it('o schema recusa texto vazio, critério de uma letra e listas absurdas', () => {
    expect(planEditSchema.safeParse({ base_revision: 1, slices: [{ slice_id: 's1', title: '   ' }] }).success).toBe(false)
    expect(planEditSchema.safeParse({ base_revision: 1, slices: [{ slice_id: 's1', acceptance_criteria: [] }] }).success).toBe(false)
    expect(planEditSchema.safeParse({ base_revision: 1, slices: [{ slice_id: 's1', acceptance_criteria: ['x'] }] }).success).toBe(false)
    expect(planEditSchema.safeParse({ base_revision: 1, slices: [{ slice_id: 's1', description: 'a'.repeat(2_001) }] }).success).toBe(false)
    expect(planEditSchema.safeParse({ base_revision: 0 }).success).toBe(false)
    expect(planEditSchema.safeParse({}).success).toBe(false)
    expect(planEditSchema.safeParse({ base_revision: 1, campo_desconhecido: 1 }).success).toBe(false)
  })

  it('o plano editado continua válido para o schema que o guarda', async () => {
    // Uma edição que produzisse um plano irregular só falharia na gravação, e a
    // pessoa veria um erro de banco no lugar de um erro sobre o que ela escreveu.
    const { studioPlanSchema } = await import('../src/model.ts')
    const after = applyPlanEdit(plan(), edit({ removed: ['s2'], slices: [{ slice_id: 's1', title: 'Agendamento' }], order: ['s3', 's1'] }), NOW)
    expect(studioPlanSchema.safeParse(after).success).toBe(true)
  })
})
