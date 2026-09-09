export type ProjectUiState =
  | 'DRAFT' | 'SPEC_READY' | 'PLAN_PROPOSED' | 'PLAN_APPROVED' | 'GENERATING'
  | 'BUILD_OK' | 'BUILD_FAILED' | 'TESTS_OK' | 'TESTS_FAILED' | 'CANCELLED' | 'INTERRUPTED' | 'VERIFIED_PROTOTYPE'

export type PermanentTruthKind = 'creation' | 'unverified' | 'verified' | null

export function currentStepIndex(state: ProjectUiState | null): number {
  if (state === null) return 0
  if (state === 'DRAFT') return 1
  if (state === 'SPEC_READY' || state === 'PLAN_PROPOSED') return 2
  if (state === 'PLAN_APPROVED' || state === 'GENERATING' || state === 'BUILD_OK' || state === 'BUILD_FAILED' || state === 'INTERRUPTED') return 3
  return 4
}

/**
 * A frase permanente sob as etapas — e ela responde pelo ESTADO, não pela etapa.
 *
 * Antes ela vinha do índice da etapa, e a etapa 4 é "Verificação": chegar lá
 * bastava para a tela escrever "Protótipo verificado". `TESTS_FAILED` e
 * `CANCELLED` também chegam à etapa 4. Ou seja: o teste reprovou, ou a pessoa
 * cancelou, e a tela dizia que o protótipo estava verificado. Era a única
 * afirmação permanente da tela, e era falsa exatamente quando mais importava.
 *
 * Verificado é só `VERIFIED_PROTOTYPE`, que é o estado que tem atestação.
 * `TESTS_OK` ainda está a caminho dela. O que falhou ou foi cancelado diz o que
 * é: não verificado.
 *
 * A tabela é exaustiva de propósito: um estado novo no tipo não compila até
 * alguém dizer o que ele afirma para a pessoa.
 */
const TRUTH_BY_STATE: Readonly<Record<ProjectUiState, PermanentTruthKind>> = {
  DRAFT: null, SPEC_READY: null, PLAN_PROPOSED: null,
  PLAN_APPROVED: 'creation', GENERATING: 'creation', BUILD_OK: 'creation',
  BUILD_FAILED: 'creation', INTERRUPTED: 'creation', TESTS_OK: 'creation',
  TESTS_FAILED: 'unverified', CANCELLED: 'unverified',
  VERIFIED_PROTOTYPE: 'verified',
}

export function permanentTruthKind(state: ProjectUiState | null): PermanentTruthKind {
  return state === null ? null : TRUTH_BY_STATE[state]
}

/**
 * Os três perfis, e os dois valores do binário anterior.
 *
 * A tela aceita os antigos porque um projeto gravado antes dos nomes continua
 * abrindo: `local-only` é `privado-local` e `any` é `melhor-qualidade`.
 */
export type PrivacyProfile = 'privado-local' | 'equilibrado' | 'melhor-qualidade'
export type PrivacyChoice = PrivacyProfile | 'local-only' | 'any'

/** A mesma tradução que o servidor faz, para a tela nunca discordar dele. */
export function privacyProfileOf(mode: PrivacyChoice): PrivacyProfile {
  if (mode === 'local-only') return 'privado-local'
  if (mode === 'any') return 'melhor-qualidade'
  return mode
}

export interface PrivacyMessages {
  readonly localNotice: string
  readonly localBlocked: string
  readonly balancedNoticeStart: string
  readonly routeNoticeStart: string
  readonly routeNoticeEnd: string
  readonly routeUnavailable: string
}

/**
 * Se a criação está barrada AGORA pelo perfil escolhido.
 *
 * `privado-local` não cai para rota externa: sem IA local não há criação. Sem
 * esta resposta a tela deixava a pessoa escrever a ideia inteira, apertar
 * "continuar" e só então receber um erro - a informação existia antes e foi
 * escondida dela.
 *
 * `undefined` é "o servidor não respondeu isso", e não vira bloqueio: inventar
 * um bloqueio a partir de silêncio é tão errado quanto esconder um de verdade.
 * @param mode - o perfil escolhido.
 * @param localRoute - a rota local utilizável, `null` quando não há, `undefined` quando não se sabe.
 * @returns `true` quando a criação está bloqueada.
 */
export function creationBlocked(mode: PrivacyChoice, localRoute: string | null | undefined): boolean {
  return privacyProfileOf(mode) === 'privado-local' && localRoute === null
}

/**
 * A frase que diz o que cada perfil faz com os dados da pessoa.
 * @param mode - o perfil escolhido.
 * @param route - a rota externa que seria usada, ou `null`.
 * @param messages - o catálogo pt-BR.
 * @param localRoute - a rota local utilizável, `null` quando não há.
 * @returns a frase pronta.
 */
export function privacyNotice(
  mode: PrivacyChoice,
  route: string | null,
  messages: PrivacyMessages,
  localRoute?: string | null,
): string {
  const profile = privacyProfileOf(mode)
  if (profile === 'privado-local') return creationBlocked(mode, localRoute) ? messages.localBlocked : messages.localNotice
  if (route === null) return messages.routeUnavailable
  const start = profile === 'equilibrado' ? messages.balancedNoticeStart : messages.routeNoticeStart
  return `${start} ${route}. ${messages.routeNoticeEnd}`
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

/**
 * A frase que explica a escolha da rota, ou `null` quando não há o que
 * explicar.
 *
 * No perfil local a frase de privacidade já diz tudo, e repetir o motivo
 * técnico ao lado dela só acrescenta ruído para quem não programa. Sem rota,
 * também não há escolha a explicar - o que existe é um bloqueio, e quem conta
 * isso é `privacyNotice`.
 * @param mode - o perfil de privacidade escolhido.
 * @param reason - o motivo que o servidor calculou.
 * @returns a frase, ou `null`.
 */
export function routeReasonNotice(
  mode: PrivacyChoice,
  reason: string | null | undefined,
): string | null {
  if (privacyProfileOf(mode) === 'privado-local') return null
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null
}
