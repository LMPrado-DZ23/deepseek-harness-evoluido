export type ProjectUiState =
  | 'DRAFT' | 'SPEC_READY' | 'PLAN_PROPOSED' | 'PLAN_APPROVED' | 'GENERATING'
  | 'BUILD_OK' | 'BUILD_FAILED' | 'TESTS_OK' | 'TESTS_FAILED' | 'CANCELLED' | 'INTERRUPTED' | 'VERIFIED_PROTOTYPE'

export type PermanentTruthKind = 'creation' | 'verified' | null

export function currentStepIndex(state: ProjectUiState | null): number {
  if (state === null) return 0
  if (state === 'DRAFT') return 1
  if (state === 'SPEC_READY' || state === 'PLAN_PROPOSED') return 2
  if (state === 'PLAN_APPROVED' || state === 'GENERATING' || state === 'BUILD_OK' || state === 'BUILD_FAILED' || state === 'INTERRUPTED') return 3
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

/** Os estados que a criação pode terminar. */
export type PipelineResultState =
  | 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'CANCELLED' | 'INTERRUPTED'

export interface ResultMessages {
  readonly success: string
  readonly failure: string
  readonly cancelled: string
  readonly interrupted: string
  readonly blockedExternal: string
}

/**
 * A frase que a pessoa lê sobre o fim da criação.
 *
 * O código cru (`VERIFIED_PROTOTYPE`, `BUILD_FAILED`) aparecia direto na tela,
 * em inglês e em caixa alta, para alguém que não programa. Ele continua
 * existindo — é o que se cola num pedido de ajuda — mas em "Detalhes técnicos",
 * e nunca no lugar da explicação.
 * @param state - o estado final.
 * @param messages - o catálogo pt-BR.
 * @returns a frase pronta.
 */
export function resultSentence(state: PipelineResultState, messages: ResultMessages): string {
  if (state === 'VERIFIED_PROTOTYPE') return messages.success
  if (state === 'CANCELLED') return messages.cancelled
  if (state === 'INTERRUPTED') return messages.interrupted
  if (state === 'BLOCKED_EXTERNAL') return messages.blockedExternal
  return messages.failure
}
