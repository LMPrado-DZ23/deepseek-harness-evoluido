/**
 * E-03 — o que a tela precisa saber para editar um plano, sem React no meio.
 *
 * A tela envia UMA operação por vez e adota o plano que voltou. A alternativa —
 * acumular alterações na tela e mandar tudo no fim — parece mais barata e é
 * pior: enquanto a pessoa acumula, o plano no servidor pode ter mudado, e o
 * envio final decidiria sozinho quem ganha. Aqui cada alteração leva a revisão
 * que a pessoa estava vendo, e o servidor recusa a que chegou atrasada.
 */
export interface PlanSliceView {
  readonly slice_id: string
  readonly title: string
  readonly description: string
  readonly acceptance_criteria: readonly string[]
}

export interface PlanView {
  readonly revision?: number
  readonly edited_by_person?: boolean
  readonly slices: readonly PlanSliceView[]
}

export interface PlanEditRequest {
  readonly base_revision: number
  readonly slices?: readonly { readonly slice_id: string; readonly title?: string; readonly description?: string; readonly acceptance_criteria?: readonly string[] }[]
  readonly removed?: readonly string[]
  readonly order?: readonly string[]
}

/** A revisão que a tela está vendo. Plano antigo sem o campo vale como 1, igual ao servidor. */
export function viewRevision(plan: PlanView): number {
  return plan.revision ?? 1
}

/**
 * Os critérios como a pessoa os digita: uma linha por item.
 *
 * Linha em branco é DESCARTADA, não vira critério vazio: quem aperta Enter duas
 * vezes está separando itens, não pedindo um critério sem texto.
 * @param text - o conteúdo da caixa.
 * @returns os critérios, sem linhas vazias.
 */
export function criteriaFromText(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/** O texto da caixa a partir dos critérios guardados. */
export function criteriaToText(criteria: readonly string[]): string {
  return criteria.join('\n')
}

/**
 * O pedido de reordenação que move uma fatia uma posição para cima ou para baixo.
 *
 * Devolve `undefined` quando o movimento não existe (a primeira não sobe, a
 * última não desce). A tela usa isso para DESABILITAR o botão em vez de mandar
 * um pedido que não muda nada — um botão que parece funcionar e não faz nada é
 * pior do que um botão apagado.
 * @param plan - o plano visível.
 * @param sliceId - a fatia movida.
 * @param direction - para onde.
 * @returns a ordem completa pedida, ou `undefined` quando não há movimento.
 */
export function moveRequest(plan: PlanView, sliceId: string, direction: 'up' | 'down'): PlanEditRequest | undefined {
  const ids = plan.slices.map(slice => slice.slice_id)
  const from = ids.indexOf(sliceId)
  if (from < 0) return undefined
  const to = direction === 'up' ? from - 1 : from + 1
  if (to < 0 || to >= ids.length) return undefined
  const order = [...ids]
  order[from] = ids[to]!
  order[to] = ids[from]!
  return { base_revision: viewRevision(plan), order }
}

/**
 * O pedido que tira uma fatia — ou `undefined` quando ela é a última que
 * sobrou, porque um plano vazio não é um plano e o servidor recusaria.
 */
export function removeRequest(plan: PlanView, sliceId: string): PlanEditRequest | undefined {
  if (plan.slices.length <= 1) return undefined
  if (!plan.slices.some(slice => slice.slice_id === sliceId)) return undefined
  return { base_revision: viewRevision(plan), removed: [sliceId] }
}

/**
 * O pedido que grava a edição de uma fatia, com só o que REALMENTE mudou.
 *
 * Mandar campo igual ao que já estava não é inofensivo: a gravação de um campo
 * inalterado por cima do trabalho de outra pessoa é como uma edição concorrente
 * some sem ninguém ver.
 * @returns o pedido, ou `undefined` quando nada mudou.
 */
export function sliceEditRequest(plan: PlanView, sliceId: string, draft: { readonly title: string; readonly description: string; readonly criteriaText: string }): PlanEditRequest | undefined {
  const current = plan.slices.find(slice => slice.slice_id === sliceId)
  if (current === undefined) return undefined
  const title = draft.title.trim()
  const description = draft.description.trim()
  const criteria = criteriaFromText(draft.criteriaText)
  const change: { slice_id: string; title?: string; description?: string; acceptance_criteria?: string[] } = { slice_id: sliceId }
  if (title !== '' && title !== current.title) change.title = title
  if (description !== '' && description !== current.description) change.description = description
  if (criteria.length > 0 && criteriaToText(criteria) !== criteriaToText(current.acceptance_criteria)) change.acceptance_criteria = criteria
  if (Object.keys(change).length === 1) return undefined
  return { base_revision: viewRevision(plan), slices: [change] }
}
