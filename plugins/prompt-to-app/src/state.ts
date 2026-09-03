import type { ProjectState } from './model.js'

export const PROJECT_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  DRAFT: ['SPEC_READY'],
  SPEC_READY: ['PLAN_PROPOSED'],
  PLAN_PROPOSED: ['PLAN_APPROVED'],
  PLAN_APPROVED: ['GENERATING'],
  GENERATING: ['BUILD_OK', 'BUILD_FAILED'],
  BUILD_OK: ['TESTS_OK', 'TESTS_FAILED'],
  BUILD_FAILED: ['GENERATING'],
  TESTS_OK: ['VERIFIED_PROTOTYPE'],
  TESTS_FAILED: ['GENERATING'],
  VERIFIED_PROTOTYPE: [],
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(readonly from: ProjectState, readonly to: ProjectState) {
    super(`Transição não permitida: ${from} → ${to}`)
  }
}

export function assertProjectTransition(from: ProjectState, to: ProjectState): void {
  if (!PROJECT_TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to)
}
