/**
 * E-03 — o plano EDITÁVEL antes da geração.
 *
 * Até aqui a pessoa via o plano e podia pedir mudança em texto livre: o
 * planejador reescrevia tudo e ela conferia de novo. Isso não é editar, é
 * negociar — e quem só quer tirar uma fatia ou consertar uma frase paga uma
 * rodada inteira de planejamento para isso.
 *
 * Editar aqui é mexer no que a PESSOA é dona:
 *
 * - o título e a descrição de uma fatia (o nome que ela vai ler depois);
 * - os critérios de aceite (é contra eles que o aplicativo vai ser julgado —
 *   é a coisa que mais precisa ser dela);
 * - tirar uma fatia que ela não quer;
 * - a ordem em que as fatias aparecem.
 *
 * E NÃO é mexer em `planned_files`. Essa lista não é texto: é a autorização de
 * escrita do gerador (E-09 — nunca escrever fora do plano aprovado). Aceitar
 * caminho vindo do pedido transformaria o editor de plano em uma primitiva de
 * escrita arbitrária no espaço de trabalho, que é exatamente a garantia mais
 * bem provada do produto sendo desfeita por um campo de formulário. Os
 * caminhos são SEMPRE copiados da fatia que já existia.
 *
 * Também NÃO é acrescentar fatia nova. Uma fatia nova precisaria de
 * `planned_files`, e só o planejador pode produzi-los. Quem quer algo que não
 * está no plano continua pedindo mudança em texto livre, e recebe uma revisão
 * inteira e coerente — o que é honesto, e não uma limitação escondida.
 */
import { z } from 'zod'
import { t } from './i18n.js'
import type { StudioPlan, StudioPlanSlice } from './model.js'

/**
 * Por que a edição não pôde ser gravada.
 *
 * Classe própria, e não a do serviço, para este módulo continuar sendo função
 * pura: quem testa a regra de edição não precisa montar um serviço, e o
 * serviço não vira dependência de um arquivo que só sabe transformar um plano
 * em outro. O serviço traduz o código para o dele na fronteira.
 */
export class PlanEditError extends Error {
  constructor(readonly code: 'STALE' | 'UNAVAILABLE' | 'INVALID' | 'NOT_FOUND', message: string) { super(message) }
}

/** O texto que uma pessoa escreve, com teto: acima disto não é plano, é documento. */
const TITLE = z.string().trim().min(1).max(120)
const DESCRIPTION = z.string().trim().min(1).max(2_000)
const CRITERION = z.string().trim().min(3).max(500)

/**
 * A edição de UMA fatia. Todo campo é opcional: quem só corrigiu o título não
 * precisa reenviar os critérios, e reenviar o que não mudou é como um cliente
 * desatualizado apaga o trabalho de outro.
 */
export const planSliceEditSchema = z.object({
  slice_id: z.string().min(1),
  title: TITLE.optional(),
  description: DESCRIPTION.optional(),
  acceptance_criteria: z.array(CRITERION).min(1).max(20).optional(),
}).strict()

export const planEditSchema = z.object({
  /** As fatias mexidas, por id. Uma fatia não citada fica exatamente como estava. */
  slices: z.array(planSliceEditSchema).max(40).default([]),
  /** As fatias que a pessoa tirou, por id. */
  removed: z.array(z.string().min(1)).max(40).default([]),
  /**
   * A ordem final, por id. Ausente = mantém a ordem atual.
   *
   * Quando presente tem que citar EXATAMENTE as fatias que sobraram: uma ordem
   * parcial obrigaria este código a inventar onde ficam as outras, e inventar
   * ordem em cima de uma decisão da pessoa é decidir por ela.
   */
  order: z.array(z.string().min(1)).max(40).optional(),
  /**
   * A revisão que a pessoa estava vendo quando editou.
   *
   * Sem isto, duas abas abertas na mesma tela sobrescrevem uma à outra em
   * silêncio: a segunda gravação venceria por ser a segunda, e ninguém saberia
   * que a primeira existiu.
   */
  base_revision: z.number().int().positive(),
}).strict()

export type PlanEdit = z.infer<typeof planEditSchema>

/** A revisão que o plano ocupa hoje. Planos antigos não têm o campo e valem como 1. */
export function planRevision(plan: StudioPlan): number {
  return plan.revision ?? 1
}

/**
 * O plano depois da edição, como um valor novo.
 *
 * @param plan - o plano tal como está guardado.
 * @param edit - o que a pessoa mexeu.
 * @param now - o instante da gravação.
 * @returns o plano novo, uma revisão à frente e ainda `PROPOSED`.
 * @throws PlanEditError quando a edição não pode ser aplicada como escrita.
 */
export function applyPlanEdit(plan: StudioPlan, edit: PlanEdit, now: string): StudioPlan {
  // Editar depois de aprovado faria o aplicativo construído deixar de ser o que
  // foi aprovado, e a aprovação já está registrada como decisão da pessoa.
  if (plan.status !== 'PROPOSED') throw new PlanEditError('UNAVAILABLE', t('errors.planEditUnavailable'))
  if (edit.base_revision !== planRevision(plan)) throw new PlanEditError('STALE', t('errors.planEditStale'))

  const byId = new Map(plan.slices.map(slice => [slice.slice_id, slice]))
  for (const id of [...edit.removed, ...edit.slices.map(slice => slice.slice_id)]) {
    if (!byId.has(id)) throw new PlanEditError('NOT_FOUND', t('errors.planEditUnknownSlice', { slice: id }))
  }
  const removed = new Set(edit.removed)
  // Tirar e editar a MESMA fatia é um pedido contraditório. Escolher um dos dois
  // em silêncio faria a tela mostrar um resultado que ninguém pediu.
  for (const slice of edit.slices) {
    if (removed.has(slice.slice_id)) throw new PlanEditError('INVALID', t('errors.planEditConflictingSlice', { slice: slice.slice_id }))
  }

  const edits = new Map(edit.slices.map(slice => [slice.slice_id, slice]))
  const kept = plan.slices.filter(slice => !removed.has(slice.slice_id)).map((slice): StudioPlanSlice => {
    const change = edits.get(slice.slice_id)
    if (change === undefined) return slice
    return {
      slice_id: slice.slice_id,
      title: change.title ?? slice.title,
      description: change.description ?? slice.description,
      acceptance_criteria: change.acceptance_criteria === undefined ? slice.acceptance_criteria : [...change.acceptance_criteria],
      // NUNCA do pedido: esta lista é a autorização de escrita do gerador.
      planned_files: slice.planned_files,
    }
  })
  // Um plano sem fatia nenhuma não é um plano vazio: é um pedido de gerar nada,
  // e o passo seguinte aceitaria e produziria um aplicativo sem conteúdo.
  if (kept.length === 0) throw new PlanEditError('INVALID', t('errors.planEditEmpty'))

  const ordered = edit.order === undefined ? kept : reorder(kept, edit.order)

  return {
    ...plan,
    slices: ordered,
    revision: planRevision(plan) + 1,
    status: 'PROPOSED',
    // A mudança pedida em texto livre pertence à revisão que o planejador
    // respondeu. Arrastá-la para uma revisão editada à mão faria a tela mostrar
    // um pedido que já foi atendido como se ainda estivesse aberto.
    change_request: null,
    edited_by_person: true,
    updated_at: now,
  }
}

/** As fatias na ordem pedida. A ordem tem que citar exatamente as que sobraram. */
function reorder(slices: readonly StudioPlanSlice[], order: readonly string[]): StudioPlanSlice[] {
  const wanted = new Set(order)
  if (wanted.size !== order.length || wanted.size !== slices.length || !slices.every(slice => wanted.has(slice.slice_id))) {
    throw new PlanEditError('INVALID', t('errors.planEditOrder'))
  }
  const byId = new Map(slices.map(slice => [slice.slice_id, slice]))
  return order.map(id => byId.get(id)!)
}
