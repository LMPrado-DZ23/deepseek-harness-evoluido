import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { t } from './i18n.js'
import { emergencyScopeId, type EmergencyStopRecord } from './model.js'

export interface EmergencyScope { readonly orgId: string; readonly tenantId: string }

export interface EmergencyActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  /** A sessão de identidade que agiu. Ausente = sem identidade forte possível (falha fechada). */
  readonly sessionId?: string
}

export class EmergencyStopError extends Error {
  constructor(
    readonly code: 'STOPPED' | 'FORBIDDEN' | 'STRONG_IDENTITY_REQUIRED' | 'REASON_REQUIRED' | 'INVALID',
    message: string,
  ) { super(message) }
}

export interface EmergencyStopRepository {
  stops(): readonly EmergencyStopRecord[]
  putStop(record: EmergencyStopRecord): Promise<void>
}

/** Identidade forte lida do SERVIDOR, pela sessão que ele mesmo autenticou - nunca do que o cliente afirma. */
export interface StrongIdentityPort {
  strongIdentityVerified(sessionId: string): boolean
}

/** O que não pôde ser provado morto, e por quê. Isto vai para a tela em vez de silêncio. */
export interface UnprovenStop {
  readonly what: string
  readonly why: string
}

/**
 * O resultado de pedir parada a UMA parte do Studio.
 *
 * São dois campos e não um número porque "pedi para parar" e "parou" são
 * coisas diferentes. Um botão que somasse os dois em `cancelled` mentiria
 * exatamente na hora em que a pessoa mais precisa da verdade.
 */
export interface StopSurfaceOutcome {
  readonly surface: string
  readonly cancelled: number
  readonly unproven: readonly UnprovenStop[]
}

/** Uma parte do Studio que tem trabalho em voo e sabe pedir que ele pare. */
export interface StopSurface {
  readonly id: string
  cancel(scope: EmergencyScope): Promise<StopSurfaceOutcome>
}

export interface EmergencyStopState {
  readonly org_id: string
  readonly tenant_id: string
  readonly stopped: boolean
  readonly engaged_by: string | null
  readonly engaged_at: string | null
  readonly reason: string | null
  readonly released_by: string | null
  readonly released_at: string | null
  readonly release_reason: string | null
}

export interface EmergencyStopEngaged {
  readonly state: EmergencyStopState
  readonly surfaces: readonly StopSurfaceOutcome[]
}

/**
 * Tamanho mínimo do motivo da RETOMADA.
 *
 * Não é burocracia: é a única prova de que alguém pensou antes de religar. Um
 * campo que aceitasse "ok" não seria um motivo, seria um clique a mais.
 */
export const MIN_RELEASE_REASON_LENGTH = 10
const MAX_REASON_LENGTH = 500

export interface EmergencyStopOptions {
  readonly repository: EmergencyStopRepository
  readonly identity: StrongIdentityPort
  /**
   * As partes a interromper, resolvidas A CADA acionamento.
   *
   * É uma função, e não uma lista, de propósito: um plugin que monta DEPOIS
   * deste precisa entrar no alcance do botão. Capturar a lista na composição
   * deixaria o botão morto para tudo que subiu depois - e um botão de
   * emergência que só alcança metade do Studio é pior que nenhum, porque
   * anuncia uma parada que não aconteceu.
   */
  readonly surfaces?: () => readonly StopSurface[]
  readonly now?: () => Date
}

/**
 * O botão de emergência: para tudo de um escopo, e só devolve o Studio a quem
 * se identifica de verdade e escreve o motivo.
 *
 * A assimetria é o desenho inteiro. PARAR pede `project.write` e nada mais -
 * em uma emergência ninguém deve procurar a chave de acesso para apagar o
 * incêndio. RETOMAR pede identidade forte verificada NESTA sessão e um motivo
 * escrito, porque religar o Studio é assumir que o incêndio acabou.
 *
 * O estado é persistido antes de qualquer cancelamento. Um reinício no meio da
 * emergência não pode religar tudo em silêncio: é isso que separa um botão de
 * verdade de um botão de mentira.
 */
export class StudioEmergencyStopService {
  readonly #now: () => Date

  constructor(private readonly options: EmergencyStopOptions) {
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * O estado do escopo: parado ou rodando, com quem parou, quando e por quê.
   * @param scope - a organização e o inquilino.
   * @returns o estado atual; escopo que nunca foi parado está rodando.
   */
  state(scope: EmergencyScope): EmergencyStopState {
    const record = this.#record(scope)
    if (record === undefined) {
      return {
        org_id: scope.orgId, tenant_id: scope.tenantId, stopped: false,
        engaged_by: null, engaged_at: null, reason: null,
        released_by: null, released_at: null, release_reason: null,
      }
    }
    const { scope_id: _scopeId, updated_at: _updatedAt, ...state } = record
    return state
  }

  /**
   * Interrompe tudo deste escopo.
   *
   * @param actor - quem está parando; o escopo é o DELE, nunca um pedido do cliente.
   * @param reason - o motivo, quando a pessoa teve tempo de escrever um.
   * @returns o estado gravado e o que cada parte conseguiu (ou não) interromper.
   */
  async engage(actor: EmergencyActor, reason?: string): Promise<EmergencyStopEngaged> {
    this.#authorize(actor)
    const trimmed = normalizeReason(reason)
    const scope: EmergencyScope = { orgId: actor.orgId, tenantId: actor.tenantId }
    const existing = this.#record(scope)
    const now = this.#now().toISOString()
    // Quem parou PRIMEIRO continua sendo quem parou. Um segundo aperto do botão
    // não reescreve a autoria da parada - mas ainda varre as partes de novo,
    // porque algo pode ter começado entre o primeiro aperto e este.
    const alreadyStopped = existing?.stopped === true
    await this.options.repository.putStop({
      scope_id: emergencyScopeId(scope),
      org_id: scope.orgId, tenant_id: scope.tenantId,
      stopped: true,
      engaged_by: alreadyStopped ? existing.engaged_by : actor.userId,
      engaged_at: alreadyStopped ? existing.engaged_at : now,
      reason: alreadyStopped ? existing.reason : trimmed,
      released_by: null, released_at: null, release_reason: null,
      updated_at: now,
    })
    // A gravação vem ANTES do cancelamento, e a ordem é a garantia: se o
    // processo morrer no meio da varredura, o Studio volta parado. Cancelar
    // primeiro e gravar depois deixaria a janela em que tudo foi interrompido
    // e nada impede o próximo trabalho de começar.
    const surfaces = await this.#cancelEverything(scope)
    return { state: this.state(scope), surfaces }
  }

  /**
   * Volta a permitir trabalho neste escopo.
   *
   * Aqui mora o lado difícil da assimetria: identidade forte verificada nesta
   * sessão e um motivo escrito. Sem os dois, o Studio continua parado.
   * @param actor - quem está retomando.
   * @param reason - o motivo escrito da retomada.
   * @returns o estado depois da retomada.
   */
  async release(actor: EmergencyActor, reason: string): Promise<EmergencyStopState> {
    this.#authorize(actor)
    const scope: EmergencyScope = { orgId: actor.orgId, tenantId: actor.tenantId }
    const existing = this.#record(scope)
    if (existing === undefined || !existing.stopped) throw new EmergencyStopError('INVALID', t('errors.notStopped'))
    // Sessão ausente é falha FECHADA: sem sessão não há como verificar chave de
    // acesso, e "não consegui verificar" nunca pode valer como "verifiquei".
    if (actor.sessionId === undefined || actor.sessionId === '' || !this.options.identity.strongIdentityVerified(actor.sessionId)) {
      throw new EmergencyStopError('STRONG_IDENTITY_REQUIRED', t('errors.strongIdentityRequired'))
    }
    const written = normalizeReason(reason)
    if (written === null || written.length < MIN_RELEASE_REASON_LENGTH) {
      throw new EmergencyStopError('REASON_REQUIRED', t('errors.releaseReasonRequired', { min: MIN_RELEASE_REASON_LENGTH }))
    }
    const now = this.#now().toISOString()
    await this.options.repository.putStop({
      ...existing, stopped: false,
      released_by: actor.userId, released_at: now, release_reason: written,
      updated_at: now,
    })
    return this.state(scope)
  }

  /**
   * A pergunta que todo trabalho novo faz antes de começar.
   *
   * Lança quando o escopo está parado. Um escopo parado NUNCA alcança outro:
   * a parada da organização A não segura o trabalho da organização B.
   * @param scope - o escopo do trabalho que quer começar.
   */
  assertRunning(scope: EmergencyScope): void {
    if (this.#record(scope)?.stopped === true) throw new EmergencyStopError('STOPPED', t('errors.stopped'))
  }

  /** Todo escopo que já foi parado alguma vez, para diagnóstico do operador. */
  records(): readonly EmergencyStopRecord[] {
    return this.options.repository.stops()
  }

  #record(scope: EmergencyScope): EmergencyStopRecord | undefined {
    const id = emergencyScopeId(scope)
    return this.options.repository.stops().find(candidate => candidate.scope_id === id)
  }

  #authorize(actor: EmergencyActor): void {
    if (!roleAllows(actor.role, 'project.write')) throw new EmergencyStopError('FORBIDDEN', t('errors.forbidden'))
  }

  async #cancelEverything(scope: EmergencyScope): Promise<readonly StopSurfaceOutcome[]> {
    const outcomes: StopSurfaceOutcome[] = []
    for (const surface of this.options.surfaces?.() ?? []) {
      try {
        outcomes.push(await surface.cancel(scope))
      } catch {
        // Uma parte que explode ao ser interrompida não pode derrubar a parada
        // das outras nem sumir do relato: ela vira exatamente o que é - algo
        // que o Studio não conseguiu provar que parou.
        outcomes.push({ surface: surface.id, cancelled: 0, unproven: [{ what: surface.id, why: t('surfaces.failed') }] })
      }
    }
    return outcomes
  }
}

function normalizeReason(reason: string | undefined): string | null {
  if (reason === undefined) return null
  const trimmed = reason.trim()
  if (trimmed === '') return null
  if (trimmed.length > MAX_REASON_LENGTH) throw new EmergencyStopError('INVALID', t('errors.reasonTooLong'))
  return trimmed
}
