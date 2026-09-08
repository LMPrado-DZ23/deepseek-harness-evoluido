import type { ProjectState } from './model.js'
import { t } from './i18n.js'

export const PROJECT_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  DRAFT: ['SPEC_READY'],
  SPEC_READY: ['PLAN_PROPOSED'],
  PLAN_PROPOSED: ['PLAN_APPROVED'],
  PLAN_APPROVED: ['GENERATING'],
  GENERATING: ['BUILD_OK', 'BUILD_FAILED', 'CANCELLED', 'INTERRUPTED'],
  BUILD_OK: ['TESTS_OK', 'TESTS_FAILED', 'INTERRUPTED'],
  BUILD_FAILED: ['GENERATING'],
  TESTS_OK: ['VERIFIED_PROTOTYPE', 'TESTS_FAILED', 'INTERRUPTED'],
  TESTS_FAILED: ['GENERATING'],
  CANCELLED: ['GENERATING'],
  INTERRUPTED: ['GENERATING'],
  VERIFIED_PROTOTYPE: [],
}

/**
 * Para onde DESFAZER pode levar, e só ele.
 *
 * É um mapa SEPARADO de propósito. `PROJECT_TRANSITIONS` descreve o caminho
 * normal da criação, e alargá-lo para caber o desfazer deixaria o pipeline
 * capaz de saltar de uma falha para "protótipo verificado" sem passar por
 * build e testes - exatamente o verde artificial que E-08 proíbe. Aqui a
 * navegação é outra coisa: ela só é permitida quando existe uma tentativa
 * PROVADA (ver `checkpoint.ts`), e o serviço confere a prova antes de chamar.
 *
 * `GENERATING` não aparece: desfazer no meio de uma criação em andamento
 * disputaria o estado com o pipeline que ainda está escrevendo nele. E o
 * destino é sempre `VERIFIED_PROTOTYPE` porque é o único estado que um ponto
 * seguro pode ter provado.
 */
export const UNDO_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  DRAFT: [],
  SPEC_READY: [],
  PLAN_PROPOSED: [],
  PLAN_APPROVED: [],
  GENERATING: [],
  BUILD_OK: [],
  BUILD_FAILED: ['VERIFIED_PROTOTYPE'],
  TESTS_OK: [],
  TESTS_FAILED: ['VERIFIED_PROTOTYPE'],
  CANCELLED: ['VERIFIED_PROTOTYPE'],
  INTERRUPTED: ['VERIFIED_PROTOTYPE'],
  // Trocar de um ponto seguro para outro continua sendo navegação entre pontos
  // provados, e é o caso de quem voltou uma tentativa e quer voltar mais.
  VERIFIED_PROTOTYPE: ['VERIFIED_PROTOTYPE'],
}

export function canUndoFrom(state: ProjectState): boolean {
  return UNDO_TRANSITIONS[state].length > 0
}

const GENERATION_START_STATES: readonly ProjectState[] = ['PLAN_APPROVED', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED']

export function canStartGeneration(state: ProjectState): boolean {
  return GENERATION_START_STATES.includes(state)
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(readonly from: ProjectState, readonly to: ProjectState) {
    super(t('errors.transition', { from, to }))
  }
}

export function assertProjectTransition(from: ProjectState, to: ProjectState): void {
  if (!PROJECT_TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to)
}

export class UndoNotAvailableError extends Error {
  readonly code = 'UNDO_NOT_AVAILABLE'
  constructor(readonly from: ProjectState, readonly to: ProjectState) {
    super(t('errors.undoUnavailable', { from }))
  }
}

/**
 * Recusa um desfazer que sairia do mapa de navegação.
 * @param from - o estado atual do projeto.
 * @param to - o estado que o ponto seguro provou.
 */
export function assertUndoTransition(from: ProjectState, to: ProjectState): void {
  if (!UNDO_TRANSITIONS[from].includes(to)) throw new UndoNotAvailableError(from, to)
}
