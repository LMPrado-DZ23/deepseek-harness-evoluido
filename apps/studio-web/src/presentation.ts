export type ProjectUiState =
  | 'DRAFT' | 'SPEC_READY' | 'PLAN_PROPOSED' | 'PLAN_APPROVED' | 'GENERATING'
  | 'BUILD_OK' | 'BUILD_FAILED' | 'TESTS_OK' | 'TESTS_FAILED' | 'CANCELLED' | 'INTERRUPTED' | 'VERIFIED_PROTOTYPE'

export type PermanentTruthKind = 'creation' | 'unverified' | 'verified' | null

/**
 * Em quais estados voltar a um ponto seguro é uma operação POSSÍVEL.
 *
 * A tabela espelha `UNDO_TRANSITIONS` de `plugins/prompt-to-app/src/state.ts`,
 * que é a autoridade — o servidor recusa com `UNDO_NOT_AVAILABLE` de qualquer
 * jeito. O motivo de existir uma cópia na tela é outro: sem ela, o botão
 * "Voltar para este ponto" aparecia para uma tentativa verde mesmo enquanto a
 * criação estava RODANDO, e a pessoa só descobria pelo erro depois de
 * confirmar. Um controle que parece funcionar e não funciona é pior que um
 * controle ausente, porque gasta a confiança de quem clicou.
 *
 * É `Record` EXAUSTIVO de propósito: estado novo não compila sem uma resposta
 * aqui, e a resposta é justamente o que decide se o botão aparece.
 */
export const UNDO_AVAILABLE_BY_STATE: Readonly<Record<ProjectUiState, boolean>> = {
  // Antes de existir uma tentativa não há para onde voltar.
  DRAFT: false, SPEC_READY: false, PLAN_PROPOSED: false, PLAN_APPROVED: false,
  // Durante a criação o pipeline ainda escreve no estado; voltar agora
  // disputaria o registro com quem está escrevendo nele.
  GENERATING: false, BUILD_OK: false, TESTS_OK: false,
  // Depois de parar — por falha, cancelamento ou interrupção — voltar é
  // exatamente a saída honesta.
  BUILD_FAILED: true, TESTS_FAILED: true, CANCELLED: true, INTERRUPTED: true,
  // Trocar de um ponto provado para outro continua sendo navegação entre
  // pontos provados.
  VERIFIED_PROTOTYPE: true,
}

/**
 * Voltar a um ponto seguro é possível a partir deste estado?
 * @param state - o estado atual do projeto, ou `null` antes de haver projeto.
 * @returns verdadeiro quando a operação existe para este estado.
 */
export function undoAvailable(state: ProjectUiState | null): boolean {
  return state === null ? false : UNDO_AVAILABLE_BY_STATE[state]
}

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
  // Estourar o teto de GASTO não é uma verificação que reprovou. Sem este
  // estado aqui, ele caía no último ramo de `resultSentence` e a pessoa lia
  // "uma verificação encontrou um problema": ia procurar defeito no aplicativo
  // dela quando o que acabou foi o limite de gasto, que ela pode mudar.
  | 'BUDGET_EXCEEDED'

export interface ResultMessages {
  readonly success: string
  readonly failure: string
  readonly cancelled: string
  readonly interrupted: string
  readonly blockedExternal: string
  readonly budgetExceeded: string
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
  if (state === 'BUDGET_EXCEEDED') return messages.budgetExceeded
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
  reasonCode: string | null | undefined,
  reasons: Readonly<Record<string, string>>,
): string | null {
  if (privacyProfileOf(mode) === 'privado-local') return null
  if (typeof reasonCode !== 'string' || reasonCode.trim() === '') return null
  // Sem frase para este código, a tela CALA. A versão anterior mostrava o texto
  // de operação como veio — "Meia-abertura: uma chamada decide se o circuito
  // fecha ou reabre." — na primeira tela do produto, para quem não programa.
  // Um código que ninguém traduziu ainda é uma tradução faltando, e não um
  // convite para despejar vocabulário interno na tela.
  return reasons[reasonCode.trim()] ?? null
}

/** Uma capacidade como o servidor a manda (T-22). */
export type CapabilityReport = {
  id: string
  state: 'UNKNOWN' | 'ABSENT' | 'PRESENT' | 'CONFIGURED' | 'OPERATIONAL'
  reason?: string
  blocked_by?: string
}

export type CapabilityLine = {
  id: string
  /** `sim` so quando foi EXERCITADO; `nao-sei` nunca vira `sim`. */
  tone: 'sim' | 'nao' | 'nao-sei'
  reason?: string
  blockedBy?: string
}

/**
 * Os motivos que dizem NINGUEM OLHOU, e nao NAO FUNCIONOU.
 *
 * A distincao decide o que a pessoa le, e ela NAO e cosmetica. Uma instalacao
 * com tudo configurado que nunca criou nada esta em `CONFIGURED` com
 * `NEVER_PROBED`: dizer "nao da agora" ali e uma negativa FALSA, e uma negativa
 * falsa impede a pessoa de tentar exatamente aquilo que teria dado certo.
 *
 * `PROBE_STALE` esta aqui pelo mesmo argumento, e a revisao adversarial pegou a
 * omissao: a frase do registro e "funcionou, mas faz tempo demais para afirmar
 * que continua funcionando" — isso e um NAO SEI. Sem ele nesta lista, alguem
 * que criou um aplicativo as 9h voltava as 10h30 e lia "nao da agora" sobre uma
 * instalacao que acabara de funcionar.
 */
const UNMEASURED_REASONS = new Set(['NEVER_PROBED', 'NO_PROBE', 'PROBE_STALE'])

/**
 * Traduz as capacidades em tres tons, e o terceiro e o que impede a tela de
 * mentir — nos DOIS sentidos.
 *
 * `nao-sei` existe porque o servidor distingue "nao deu certo" de "ninguem
 * exercitou". Com dois tons a tela teria de escolher um: escolher verde faria a
 * pessoa ler como operante o que ninguem conferiu, e escolher vermelho a
 * impediria de tentar o que teria dado certo. Os dois erros sao ruins, e e por
 * isso que o terceiro tom nao e enfeite.
 *
 * `AUSENTE` e dependencia quebrada saem como `nao`: nao ter o codigo instalado
 * ou ter o modelo caido sao respostas certas e definitivas, e nao duvidas.
 */
export function capabilityLines(capabilities: readonly CapabilityReport[] | undefined): readonly CapabilityLine[] {
  if (capabilities === undefined) return []
  return capabilities.map(capability => ({
    id: capability.id,
    tone: capability.state === 'OPERATIONAL' ? 'sim'
      : capability.state === 'UNKNOWN' || (capability.reason !== undefined && UNMEASURED_REASONS.has(capability.reason)) ? 'nao-sei'
      : 'nao',
    ...(capability.reason === undefined ? {} : { reason: capability.reason }),
    ...(capability.blocked_by === undefined ? {} : { blockedBy: capability.blocked_by }),
  }))
}

/**
 * A capacidade que a pessoa veio perguntar.
 *
 * Das quatro, tres sao pecas — modelo, armazenamento, construtor — e so uma e
 * o que ela quer fazer. Mostrar as quatro com o mesmo peso faria a resposta
 * ficar escondida entre as causas dela.
 */
export const HEADLINE_CAPABILITY = 'criar-aplicativo'

/**
 * O nome de cada peca COMO A TELA JA A CHAMA.
 *
 * O identificador interno (`construtor`, `modelo`) era interpolado cru na frase
 * "O que esta segurando: construtor." — a oito pixels de uma lista que chama a
 * mesma coisa de "Ambiente isolado de criacao". Duas palavras para a mesma
 * coisa, na mesma tela, no mesmo instante, sem nada ligando uma a outra.
 *
 * Um identificador que a lista nao conhece devolve `undefined`, e quem chama
 * decide o que fazer — inventar um nome a partir do id seria mostrar o id com
 * outra roupa.
 */
export function capabilityName(id: string, names: Readonly<Record<string, string>>): string | undefined {
  return Object.prototype.hasOwnProperty.call(names, id) ? names[id] : undefined
}
