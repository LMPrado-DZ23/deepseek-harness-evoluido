export type ProjectUiState =
  | 'DRAFT' | 'SPEC_READY' | 'PLAN_PROPOSED' | 'PLAN_APPROVED' | 'GENERATING'
  | 'BUILD_OK' | 'BUILD_FAILED' | 'TESTS_OK' | 'TESTS_FAILED' | 'VERIFIED_PROTOTYPE'

export type PermanentTruthKind = 'creation' | 'verified' | null

export function currentStepIndex(state: ProjectUiState | null): number {
  if (state === null) return 0
  if (state === 'DRAFT') return 1
  if (state === 'SPEC_READY' || state === 'PLAN_PROPOSED') return 2
  if (state === 'PLAN_APPROVED' || state === 'GENERATING' || state === 'BUILD_OK' || state === 'BUILD_FAILED') return 3
  return 4
}

export function permanentTruthKind(state: ProjectUiState | null): PermanentTruthKind {
  const step = currentStepIndex(state)
  if (step === 3) return 'creation'
  if (step === 4) return 'verified'
  return null
}

export interface PrivacyMessages {
  readonly localNotice: string
  readonly routeNoticeStart: string
  readonly routeNoticeEnd: string
  readonly routeUnavailable: string
}

export function privacyNotice(mode: 'local-only' | 'any', route: string | null, messages: PrivacyMessages): string {
  if (mode === 'local-only') return messages.localNotice
  if (route === null) return messages.routeUnavailable
  return `${messages.routeNoticeStart} ${route}. ${messages.routeNoticeEnd}`
}
