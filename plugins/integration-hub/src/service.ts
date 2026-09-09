import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { roleAllows, type PolicyTier, type StudioPermission, type StudioRole } from '@dz23-studio/policy'
import { z } from 'zod'
import { pageOfIntegrations, type IntegrationPage, type IntegrationQuery } from './catalog.js'
import { ExportError, openChildDirectory, openDirectory, packagePrototype, referenceOf } from './export.js'
import { t } from './i18n.js'
import { canonicalJsonBytes, evaluateManifest, policyFloor, type PublisherKeys } from './manifest.js'
import { integrationKillSwitchSchema, killSwitchId, killSwitchIdsFor, secretRefSchema, type HubEvent, type IntegrationKillSwitch, type IntegrationManifest, type StudioExport, type StudioIntegration } from './model.js'
import {
  DEFAULT_INTEGRATION_CALL_POLICY, IntegrationRateLimiter, integrationCostState, integrationHealth, mayRetry,
  type IntegrationCallPolicy, type IntegrationCostState, type IntegrationHealth,
} from './runtime.js'

export interface HubActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId?: string
  /** Recent passkey confirmation on THIS session, decided by the layer that authenticated it. Absent = not verified (fail closed). */
  readonly strongIdentityVerified?: boolean
}

/** Window a passkey confirmation stays valid for a T3 action; mirrors the identity plugin's own strong-auth window. */
export const STRONG_IDENTITY_TTL_MS = 5 * 60 * 1000

/** Whether a session's last strong confirmation is recent enough for T3. Fail closed on anything missing or unparseable. */
export function strongIdentityFresh(input: { readonly last_strong_auth_method?: string | null; readonly last_strong_auth_at?: string | null }, now: Date): boolean {
  if (input.last_strong_auth_method !== 'passkey' || typeof input.last_strong_auth_at !== 'string') return false
  const at = Date.parse(input.last_strong_auth_at)
  return Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < STRONG_IDENTITY_TTL_MS
}

/**
 * O armazenamento do Hub.
 *
 * As LEITURAS do domínio `studio_integrations` (integrações, exportações e
 * eventos) são assíncronas e recebem o escopo. Assíncronas porque o
 * repositório com isolamento por linha (RLS) consulta o banco: o escopo viaja
 * na consulta e é o PostgreSQL que recusa o que não é do inquilino, em vez de
 * um `filter` deste processo. Escopadas porque uma leitura sem escopo não tem
 * como ser servida por uma credencial escopada — e é exatamente essa a
 * diferença entre "o código separa" e "o banco recusa".
 *
 * Os desligamentos por alcance continuam SÍNCRONOS: eles são lidos em guarda
 * de caminho quente, antes de cada chamada de integração, e trocá-los por
 * leitura de banco é mudança de desenho da guarda, não migração.
 */
export interface HubRepository {
  integrations(scope: HubActor): Promise<readonly StudioIntegration[]>
  integration(scope: HubActor, integrationId: string): Promise<StudioIntegration | undefined>
  putIntegration(value: StudioIntegration): Promise<void>
  /**
   * Apaga o REGISTRO da integração (X-04). Só o registro: os eventos ficam.
   *
   * Apagar a integração junto com o rastro dela seria transformar "remover uma
   * integração" em "apagar a auditoria de tudo que ela fez", que é exatamente
   * o que alguém faria de propósito depois de um incidente.
   */
  deleteIntegration(scope: HubActor, integrationId: string): Promise<void>
  /** Atomic within the repository writer: replace only the security state the caller read. */
  compareAndSwapIntegration(scope: HubActor, integrationId: string, expectedFingerprint: string, value: StudioIntegration): Promise<boolean>
  exports(scope: HubActor, projectId: string): Promise<readonly StudioExport[]>
  export(scope: HubActor, projectId: string, exportId: string): Promise<StudioExport | undefined>
  putExport(value: StudioExport): Promise<void>
  /** Bounded page, already scoped and ordered newest first; never a full-table snapshot. */
  eventPage(scope: HubActor, after: Pick<HubEvent, 'created_at' | 'event_id'> | undefined, limit: number): Promise<readonly HubEvent[]>
  eventCount(scope: HubActor): Promise<number>
  putEvent(value: HubEvent): Promise<void>
  /** Retention happens inside the scoped repository index, not after materialising the domain. */
  pruneEvents(scope: HubActor, keep: number): Promise<number>
  /**
   * Os desligamentos por alcance (X-07).
   *
   * A leitura é por CHAVE e não por escopo do ator: o alcance da organização
   * vale para todos os inquilinos dela, e filtrar pelo inquilino de quem
   * pergunta esconderia justamente o desligamento mais amplo.
   */
  killSwitch(switchId: string): IntegrationKillSwitch | undefined
  putKillSwitch(value: IntegrationKillSwitch): Promise<void>
  killSwitches(orgId: string): readonly IntegrationKillSwitch[]
}

/** Existence and shape of a credential in the vault; the value never crosses this port. */
export interface SecretInspector {
  inspect(ref: string): Promise<{ present: boolean; shapeOk: boolean }>
}

export interface EmailTestPort {
  /** Sends one test message through the referenced credential; only wired when the operator enabled it. */
  sendTest(ref: string, to: string): Promise<void>
}

export interface ProjectsPort {
  project(actor: HubActor, projectId: string): { readonly project_id: string; readonly name: string; readonly state: string }
  runs(actor: HubActor, projectId: string): readonly { readonly run_id: string; readonly state: string; readonly started_at: string; readonly attempt: number; readonly run_directory: string }[]
}

/**
 * What the client presents when it acts: the id of an approval the SERVER
 * issued for exactly this action. It is not the client's word that a person
 * confirmed — that claim was worth nothing, since any page that got past CSRF
 * could simply send `{approved:true}`. The server decides the tier, records the
 * decision before the action, binds it to the actor, the session, the action
 * and the subject, expires it, and burns it on use.
 */
export interface HubApproval {
  readonly approvalId: string
}

/**
 * An approval the server issued and has not yet spent. It names the workspace
 * it belongs to (org + tenant), the action, the subject AND a fingerprint of
 * what is being decided — the alias, the address, the manifest and its
 * signature — so a decision confirmed for one target cannot be spent on
 * another. The fingerprint is a digest: no alias and no address travel in it.
 */
export interface HubApprovalTicket {
  readonly approval_id: string
  readonly org_id: string
  readonly tenant_id: string
  readonly tier: PolicyTier
  readonly action: HubEvent['action']
  readonly subject_id: string
  /** sha256 of what this decision is FOR (payload for the SMTP actions, security fields for a registry record). */
  readonly fingerprint: string
  readonly user_id: string
  readonly session_id: string | undefined
  readonly expires_at: string
  readonly requires_strong_identity: boolean
}

/** How long a confirmation is worth something. Short on purpose: it is a decision about one action, now. */
export const APPROVAL_TTL_MS = 3 * 60 * 1000

/** Ceiling for approvals waiting to be used, PER WORKSPACE: a flood in one tenant never evicts another's. */
export const MAX_LIVE_APPROVALS = 512

/** Ceiling for how many workspaces keep a live approval bucket at once. */
export const MAX_APPROVAL_SCOPES = 256

/** Default and maximum page of the audit history; the whole table never travels in one answer. */
export const EVENTS_PAGE_SIZE = 50
export const EVENTS_PAGE_MAX = 200

/** Retention: how many events one workspace keeps. Older ones leave when a new one is written. */
export const EVENTS_RETAINED_PER_TENANT = 1000

/** Export attempts one workspace may make inside `EXPORT_WINDOW_MS`; packaging is the expensive call here. */
export const MAX_EXPORTS_PER_WINDOW = 12
export const EXPORT_WINDOW_MS = 10 * 60 * 1000

/**
 * How many prototypes this Studio packages at the same time, across every workspace. Packaging
 * walks a whole build, reads every allowed file and hashes it, on Node's single thread: letting
 * four workspaces do that at once makes the Studio unresponsive for all four. Waiting a turn is
 * slower for one person and honest for everybody.
 */
export const MAX_CONCURRENT_PACKAGING = 2
/** Waiting exports are bounded too; overload is refused instead of retaining promises forever. */
export const MAX_PACKAGING_QUEUE = 64

/**
 * Ceiling on how long ONE packaging call may hold a slot. Packaging is bounded work — the walk of
 * one verified build, under `EXPORT_LIMIT_BYTES` — and even on a slow disk that is minutes. Ten
 * minutes is therefore far above any honest run and far below "forever". It exists because a single
 * call that never returns (a named pipe where a file was expected, a network filesystem that stops
 * answering, a device that blocks on read) used to take the slot with it: two of those and no
 * workspace in this Studio could export again until it was restarted.
 *
 * The wedged call is ABANDONED, not killed — Node cannot cancel a pending syscall — so the honest
 * statement is "the Studio stopped waiting", and that is what the person is told and what the
 * history records. Freeing the slot is what keeps one stuck build from becoming everybody's outage.
 *
 * Abandoned means abandoned, though: the call kept running and used to finish its job, writing the
 * `.zip`, the export row and an `export.created / success` line AFTER the person had been told
 * TIMEOUT and after the history had recorded `export.created / failure / packaging-timeout`. One
 * click, two contradictory lines. So the ceiling and the build now share a lease (`PackagingLease`):
 * whichever asks first owns the outcome, and the loser writes nothing at all — the abandoned build
 * takes its own package back off the disk and leaves the history with the single line the person was
 * shown. The in-flight entry lives until the abandoned build really settles, so the next click joins
 * it rather than starting a twin of a build that still owns that package's name.
 *
 * What the ceiling does NOT do is take back a record. Once the build has claimed the outcome — the
 * package is written and the row is about to be — the Studio waits for that to finish instead of
 * telling somebody "it did not happen" about something it may have stored. The slot still goes back
 * on time in that case, because the slot is what protects everybody else.
 */
export const PACKAGING_SLOT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The right to finish ONE packaging call. `PACKAGING_SLOT_TIMEOUT_MS` abandons a call it cannot
 * cancel, so the call has to be able to find out that it was abandoned and give up on its own:
 * `abandoned` says the Studio already stopped waiting, `signal` is the same fact for anything that
 * takes one, and `commit()` claims the outcome for whoever asks first.
 */
interface PackagingLease {
  readonly abandoned: boolean
  readonly signal: AbortSignal
  commit(): boolean
}

/** One build in flight, kept until the BUILD settles — not until the caller's answer does. */
interface ExportInFlight {
  answer: Promise<StudioExport>
}

export interface HubServiceOptions {
  repository: HubRepository
  secrets: SecretInspector
  projects: ProjectsPort
  exportsRoot: string
  publisherKeys: PublisherKeys
  channel: 'stable' | 'dev'
  /**
   * Root the generated runs live under; a `run_directory` outside it is refused
   * before anything is read. Required: an optional boundary is a boundary that
   * is off by accident.
   */
  runsRoot: string
  emailTest?: EmailTestPort | undefined
  /** Only for tests: how long a packaging slot may be held before the caller is refused (default `PACKAGING_SLOT_TIMEOUT_MS`). */
  packagingTimeoutMs?: number
  /**
   * Os limites de UMA chamada de integração (X-08). O que não vier aqui fica
   * com `DEFAULT_INTEGRATION_CALL_POLICY`: um limite ausente vira o padrão da
   * casa, nunca "sem limite".
   */
  callPolicy?: Partial<IntegrationCallPolicy>
  /** Ausente = nenhum botão de emergência montado neste perfil, e nada a perguntar. */
  emergencyStop?: EmergencyStopGuard
  now?: () => Date
  createId?: () => string
}

/**
 * A pergunta que toda chamada de integração faz antes de sair.
 *
 * Interface estrutural: o Hub continua subindo em perfil sem botão de
 * emergência. A recusa vem como `Error` com `code === 'STOPPED'` e uma frase já
 * escrita para uma pessoa.
 */
export interface EmergencyStopGuard {
  assertRunning(scope: { readonly orgId: string; readonly tenantId: string }): void
}

export class HubError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'NOT_EXECUTED' | 'SECRET_DETECTED' | 'TOO_LARGE' | 'RATE_LIMITED' | 'TIMEOUT', message: string) { super(message) }
}

/** Export refusals keep their own class so the HTTP boundary can answer 409/413 instead of a flat 400. */
function exportErrorCode(code: ExportError['code']): HubError['code'] {
  if (code === 'RUN_MISSING') return 'CONFLICT'
  if (code === 'SECRET_DETECTED') return 'SECRET_DETECTED'
  if (code === 'TOO_LARGE') return 'TOO_LARGE'
  return 'INVALID'
}

/** SMTP for generated apps talks to an external provider: T2 by the D16 floor. */
export const SMTP_TIER: PolicyTier = 'T2'

/** The subject an SMTP approval is bound to: the app's e-mail setting itself, not the secret's name. */
export const SMTP_SUBJECT = 'smtp'

const TIER_RANK: Readonly<Record<PolicyTier, number>> = { T0: 0, T1: 1, T2: 2, T3: 3 }

const smtpSecretShape = z.object({ host: z.string().min(1), port: z.number().int(), secure: z.boolean(), user: z.string().min(1), pass: z.string().min(1), from: z.string().min(1) }).strict()
export { smtpSecretShape }

export class IntegrationHubService {
  readonly #now: () => Date
  readonly #createId: () => string
  /**
   * Issued approvals, in memory on purpose: a restart loses them, and losing
   * one only means the person confirms again — the failure is closed. Anything
   * durable here would be a decision that outlives the screen that made it.
   */
  #packaging = 0
  readonly #packagingQueue: Array<{ readonly release: () => void; readonly reject: (error: Error) => void }> = []
  readonly #integrationMutations = new Map<string, Promise<void>>()

  readonly #approvals = new Map<string, Map<string, HubApprovalTicket>>()
  /** Janela de tentativas por integração e por escopo (X-08). Em memória: um reinício só zera o teto, e zerar um teto falha para o lado seguro. */
  readonly #callLimiter: IntegrationRateLimiter
  /**
   * One package per workspace and project at a time: a page that clicks ten
   * times, or ten tabs of the same person, join the SAME build instead of
   * starting ten of them on a single-threaded process.
   */
  readonly #exportsInFlight = new Map<string, ExportInFlight>()
  /** Export attempts per workspace inside the window, so a flood costs the flooder and nobody else. */
  readonly #exportAttempts = new Map<string, number[]>()
  /**
   * Strictly increasing millisecond stamp. `Date.now()` repeats inside one
   * millisecond, and two writes that share a stamp cannot be ordered — the
   * concurrency check that compared `updated_at` could then keep the WRONG
   * version. Every record and every event this service writes gets a stamp
   * that is never equal to, nor earlier than, the previous one.
   */
  #lastStamp = 0
  /**
   * As chamadas que JÁ saíram, por escopo, para que uma parada de emergência
   * possa pedir desistência a cada uma.
   *
   * Pedir desistência não é provar que parou: o outro lado da rede não responde
   * ao Studio. Por isso `cancelScope` devolve a lista do que abandonou, e quem
   * chamou apresenta essas chamadas como não provadas em vez de canceladas.
   */
  readonly #liveCalls = new Map<string, Map<AbortController, string>>()
  /**
   * Quem sabe falar MCP, quando alguém sabe (X-11).
   *
   * Instalado depois da construção, e de propósito: o cliente MCP monta DEPOIS
   * do Hub e é opcional no perfil. Ausente aqui significa uma coisa só, e ela é
   * dita em voz alta na auditoria: nada foi executado.
   */
  #mcpDispatcher: McpDispatchPort | undefined

  constructor(private readonly options: HubServiceOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#callPolicy = { ...DEFAULT_INTEGRATION_CALL_POLICY, ...options.callPolicy }
    this.#callLimiter = new IntegrationRateLimiter(this.#callPolicy)
  }

  /** Os limites em vigor para uma chamada de integração neste Studio. */
  readonly #callPolicy: IntegrationCallPolicy
  get callPolicy(): IntegrationCallPolicy { return this.#callPolicy }

  #stamp(): string {
    const now = this.#now().getTime()
    this.#lastStamp = now > this.#lastStamp ? now : this.#lastStamp + 1
    return new Date(this.#lastStamp).toISOString()
  }

  /** The workspace an approval belongs to. Tickets are never looked up outside their own bucket. */
  #scope(actor: HubActor): string { return `${actor.orgId}\u0000${actor.tenantId}` }

  // ---- registry -------------------------------------------------------------

  async list(actor: HubActor): Promise<readonly StudioIntegration[]> {
    this.#authorize(actor, 'workspace.read')
    return await this.options.repository.integrations(actor)
  }

  /**
   * Uma página do catálogo deste escopo, já buscada, filtrada e ordenada AQUI
   * (X-01).
   *
   * Quem chama recebe uma página e dois totais — quantas integrações existem no
   * escopo e quantas o filtro deixou passar — porque uma lista vazia sozinha não
   * diz se a pessoa procurou algo que não existe ou se ela ainda não registrou
   * nada, e essas duas telas têm de ser diferentes.
   * @param actor - quem pergunta; a leitura do espaço de trabalho é exigida aqui.
   * @param query - busca, filtros, limite e posição.
   * @returns a página e os totais.
   */
  async searchIntegrations(actor: HubActor, query: IntegrationQuery = {}): Promise<IntegrationPage> {
    this.#authorize(actor, 'workspace.read')
    const rows = await this.options.repository.integrations(actor)
    try {
      return pageOfIntegrations(rows, query)
    } catch (error) {
      // Um cursor que não é legível é pedido inválido, não erro interno: ele
      // veio do cliente, e a página que ele pediu não existe.
      if (error instanceof RangeError) throw new HubError('INVALID', t('errors.invalidRequest'))
      throw error
    }
  }

  /**
   * A saúde de uma integração, derivada dos contadores gravados.
   * @param actor - quem pergunta.
   * @param integrationId - a integração.
   * @returns estado, números e o que se sabe do custo.
   */
  async health(actor: HubActor, integrationId: string): Promise<IntegrationHealth> {
    this.#authorize(actor, 'workspace.read')
    return integrationHealth(await this.#integration(actor, integrationId))
  }

  /** Whether the interface may offer "enable" for this record: decided here, the same place that enforces it. */
  canEnable(integration: Pick<StudioIntegration, 'verification' | 'enabled' | 'kind' | 'effective_tier' | 'manifest'>): boolean {
    if (integration.enabled) return false
    // A signature that does not check out is never enabled, on any channel: `dev` relaxes "unsigned", never "wrong signature".
    if (integration.verification === 'invalid') return false
    if (integration.verification === 'verified') return true
    // The dev channel exists so somebody can try an unsigned integration on their own machine — not
    // so an unsigned manifest can ask for the network, e-mail, an external service or the vault.
    // What counts here is what the manifest ASKS FOR (its own policy floor), not the T2 that being
    // unverified adds: otherwise the channel would refuse everything and mean nothing.
    if (this.options.channel !== 'dev') return false
    const asked = integration.manifest === null ? SMTP_TIER : policyFloor(integration.kind, integration.manifest)
    return TIER_RANK[asked] <= TIER_RANK.T1
  }

  /** The confirmation the person has to give before this integration can be turned on. `null` = none needed (T0/T1). */
  requiredApprovalTier(integration: Pick<StudioIntegration, 'kind' | 'effective_tier' | 'manifest'>): PolicyTier | null {
    // The same expression that enforces, so the screen can never show a lower tier than the server demands.
    const tier = this.#enforcedTier(integration)
    return needsApproval(tier) ? tier : null
  }

  get channel(): 'stable' | 'dev' { return this.options.channel }

  async register(actor: HubActor, manifestInput: unknown): Promise<{ integration: StudioIntegration; reasons: readonly string[] }> {
    return this.#exclusiveIntegration(this.#scope(actor), () => this.#register(actor, manifestInput))
  }

  async #register(actor: HubActor, manifestInput: unknown): Promise<{ integration: StudioIntegration; reasons: readonly string[] }> {
    this.#authorize(actor, 'integrations.manage')
    const evaluation = evaluateManifest(manifestInput, this.options.publisherKeys)
    const subject = evaluation.manifest?.id ?? '-'
    if (evaluation.manifest === null) {
      await this.#audit(actor, 'integration.registered', subject, 'failure', `manifest-invalid ${evaluation.reasons.join('; ')}`)
      throw new HubError('INVALID', t('errors.manifestInvalid', { detail: evaluation.reasons.join(' ') }))
    }
    if (evaluation.manifest.kind === 'smtp') {
      await this.#audit(actor, 'integration.registered', subject, 'failure', 'smtp-kind-reserved')
      throw new HubError('INVALID', t('errors.smtpKindReserved'))
    }
    if (evaluation.verification === 'invalid') {
      await this.#audit(actor, 'integration.registered', subject, 'failure', 'signature-invalid')
      throw new HubError('INVALID', t('errors.manifestSignatureInvalid'))
    }
    const now = this.#stamp()
    const existing = (await this.list(actor)).find(value => value.manifest?.id === evaluation.manifest!.id && value.kind === evaluation.manifest!.kind)
    const integration: StudioIntegration = {
      integration_id: existing?.integration_id ?? this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      kind: evaluation.manifest.kind, name: evaluation.manifest.name, manifest: evaluation.manifest,
      effective_tier: evaluation.effectiveTier, verification: evaluation.verification,
      enabled: false, secret_ref: existing?.secret_ref ?? null,
      created_by: existing?.created_by ?? actor.userId, created_at: existing?.created_at ?? now, updated_at: now,
    }
    await this.options.repository.putIntegration(integration)
    await this.#audit(actor, 'integration.registered', integration.integration_id, 'success', `${integration.verification} ${integration.effective_tier}`)
    return { integration, reasons: evaluation.reasons }
  }

  /**
   * The tier this record is enforced at: the most restrictive of what was
   * stored and the floor its kind demands. A row written before a floor
   * existed — or by any other writer of the table — must not be able to lower
   * the confirmation the person has to give.
   */
  #enforcedTier(record: Pick<StudioIntegration, 'kind' | 'effective_tier' | 'manifest'>): PolicyTier {
    const floor = record.kind === 'smtp'
      ? SMTP_TIER
      : record.manifest === null ? SMTP_TIER : policyFloor(record.kind, record.manifest)
    return TIER_RANK[record.effective_tier] >= TIER_RANK[floor] ? record.effective_tier : floor
  }

  /**
   * The server's decision that this person may do this exact thing: which tier
   * it takes, whether a passkey is needed, and until when. Nothing happens yet.
   * The interface shows what it says and, if the person agrees, presents the id.
   */
  async requestApproval(actor: HubActor, action: HubEvent['action'], subjectId: string, payload?: string): Promise<HubApprovalTicket> {
    this.#authorize(actor, 'integrations.manage')
    // The SMTP actions have exactly one subject; accepting a free string there made the number of
    // possible tickets unbounded for no reason. What tells two SMTP decisions apart is the
    // FINGERPRINT of the target below, not the subject.
    const subject = action === 'integration.enabled' ? subjectId : SMTP_SUBJECT
    if (action !== 'integration.enabled' && subjectId !== SMTP_SUBJECT) throw new HubError('INVALID', t('errors.invalidRequest'))
    const tier = await this.#tierForAction(actor, action, subject)
    const ticket: HubApprovalTicket = {
      approval_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      tier, action, subject_id: subject, fingerprint: await this.#fingerprint(actor, action, subject, payload),
      user_id: actor.userId, session_id: actor.sessionId,
      expires_at: new Date(this.#now().getTime() + APPROVAL_TTL_MS).toISOString(),
      requires_strong_identity: tier === 'T3',
    }
    const bucket = this.#sweepApprovals(actor)
    // Re-issuing the SAME decision replaces the previous ticket instead of adding a second one.
    // Asking again is what a person does when the tier changed under them, or when they abandoned
    // the first confirmation: the discarded ticket used to stay usable for its whole TTL, next to
    // the one on the screen — two live confirmations for one decision, only one of them ever seen.
    // The comparison includes the FINGERPRINT, so a confirmation pending for another recipient or
    // another alias is a different decision and is left alone.
    for (const [id, live] of bucket) {
      if (live.action === action && live.subject_id === subject && live.user_id === actor.userId
        && live.session_id === actor.sessionId && live.fingerprint === ticket.fingerprint) bucket.delete(id)
    }
    bucket.set(ticket.approval_id, ticket)
    await this.#audit(actor, 'approval.requested', subject, 'success', `${action} ${tier}`)
    return ticket
  }

  /**
   * What this decision is FOR, as a digest. For the SMTP actions it is the
   * alias or the address the person is confirming (plus the record it lands
   * on); for a registry record it is the security-relevant state of that
   * record. Nothing readable — no alias, no e-mail — travels in the ticket or
   * reaches the history through it.
   */
  async #fingerprint(actor: HubActor, action: HubEvent['action'], subjectId: string, payload: string | undefined): Promise<string> {
    if (action === 'integration.enabled') return securityFingerprint(await this.#integration(actor, subjectId))
    if (action === 'smtp.configured' || action === 'smtp.tested') {
      // A decision with no target is a decision about nothing: refuse to issue it.
      if (payload === undefined || payload.trim() === '') throw new HubError('INVALID', t('errors.invalidRequest'))
      const target = action === 'smtp.configured' ? String(canonicalSecretRef(payload)) : payload.trim()
      const record = await this.#smtpRecord(actor)
      return digest([action, target, record === undefined ? '-' : securityFingerprint(record)])
    }
    throw new HubError('INVALID', t('errors.invalidRequest'))
  }

  /** The tier an action would need right now, decided by the server for the request above. */
  async #tierForAction(actor: HubActor, action: HubEvent['action'], subjectId: string): Promise<PolicyTier> {
    if (action === 'integration.enabled') return this.#enforcedTier(await this.#integration(actor, subjectId))
    if (action === 'smtp.configured' || action === 'smtp.tested') return SMTP_TIER
    throw new HubError('INVALID', t('errors.invalidRequest'))
  }

  /**
   * Expired tickets leave, and the map has a ceiling. Insertion order is expiry order (one clock,
   * one TTL), so the sweep only has to look at the FRONT — walking the whole map on every request
   * made each confirmation slower than the last, and Node has one thread for every tenant.
   */
  #sweepApprovals(actor: HubActor): Map<string, HubApprovalTicket> {
    const now = this.#now().getTime()
    const key = this.#scope(actor)
    let bucket = this.#approvals.get(key)
    if (bucket === undefined) {
      for (const [scope, tickets] of this.#approvals) {
        for (const [id, ticket] of tickets) {
          if (Date.parse(ticket.expires_at) <= now) tickets.delete(id)
        }
        if (tickets.size === 0) this.#approvals.delete(scope)
      }
      if (this.#approvals.size >= MAX_APPROVAL_SCOPES) {
        throw new HubError('RATE_LIMITED', t('errors.approvalCapacity'))
      }
      bucket = new Map<string, HubApprovalTicket>()
      this.#approvals.set(key, bucket)
    }
    for (const [id, ticket] of bucket) {
      if (Date.parse(ticket.expires_at) > now) break
      bucket.delete(id)
    }
    // A person confirms one action at a time; a thousand live tickets is already absurd. The oldest
    // of THIS workspace go first — the map used to be global, so a flood from one tenant threw away
    // the confirmation another tenant's person was in the middle of giving.
    while (bucket.size >= MAX_LIVE_APPROVALS) {
      const oldest = bucket.keys().next()
      if (oldest.done === true) break
      bucket.delete(oldest.value)
    }
    return bucket
  }

  async setEnabled(actor: HubActor, integrationId: string, enabled: boolean, approval?: HubApproval): Promise<StudioIntegration> {
    return this.#exclusiveIntegration(this.#scope(actor), () => this.#setEnabled(actor, integrationId, enabled, approval))
  }

  async #setEnabled(actor: HubActor, integrationId: string, enabled: boolean, approval?: HubApproval): Promise<StudioIntegration> {
    this.#authorize(actor, 'integrations.manage')
    const current = await this.#integration(actor, integrationId)
    let confirmed = false
    if (enabled) {
      // Turning something OFF always reduces exposure and needs no confirmation; turning it ON is the guarded direction.
      if (current.verification === 'invalid') {
        await this.#audit(actor, 'integration.enabled', integrationId, 'failure', 'signature-invalid')
        throw new HubError('FORBIDDEN', t('errors.manifestSignatureInvalid'))
      }
      if (current.verification !== 'verified' && !this.canEnable({ ...current, enabled: false })) {
        await this.#audit(actor, 'integration.enabled', integrationId, 'failure', t('errors.manifestUnverified'))
        throw new HubError('FORBIDDEN', this.options.channel === 'dev' ? t('errors.devChannelCapability') : t('errors.manifestUnverified'))
      }
      confirmed = await this.#requireTier(actor, this.#enforcedTier(current), approval, 'integration.enabled', integrationId, securityFingerprint(current))
    }
    // The record decides the tier, so it must not be written back from a snapshot taken before the
    // confirmation: a concurrent re-registration that RAISED the tier would be silently undone.
    // Compared by FINGERPRINT of the security-relevant fields and not by `updated_at`: two writes
    // inside the same millisecond carried the same stamp, and the check then kept the wrong version.
    const latest = await this.#integration(actor, integrationId)
    if (securityFingerprint(latest) !== securityFingerprint(current)) {
      await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'failure', 'changed-during-approval')
      throw new HubError('CONFLICT', t('errors.integrationChanged'))
    }
    const updated = { ...latest, enabled, updated_at: this.#stamp() }
    if (!await this.options.repository.compareAndSwapIntegration(actor, integrationId, securityFingerprint(latest), updated)) {
      await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'failure', 'changed-during-write')
      throw new HubError('CONFLICT', t('errors.integrationChanged'))
    }
    await this.#recordApproval(actor, confirmed, 'integration.enabled', integrationId)
    await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'success', updated.effective_tier)
    return updated
  }

  /**
   * Remove a integração (X-04). É o fim do ciclo de vida, e é destrutivo.
   *
   * Três regras, e nenhuma delas é conveniência:
   *
   * 1. só remove o que está DESLIGADO. Remover uma integração ligada é
   *    desligá-la e apagá-la no mesmo gesto, sem que ninguém tenha decidido
   *    desligar — e o registro que dizia o que ela podia fazer some junto;
   * 2. exige a MESMA confirmação que ligar exigiria. Remover é a operação que
   *    apaga a prova do que foi autorizado; pedir menos do que se pediu para
   *    autorizar seria pedir menos para desfazer do que para fazer;
   * 3. os EVENTOS ficam. Apagar a integração junto com o rastro dela
   *    transformaria "remover" em "apagar a auditoria", que é justamente o que
   *    alguém faria depois de um incidente.
   *
   * O segredo do cofre NÃO é apagado por aqui: este serviço nunca teve, e não
   * passa a ter, permissão de apagar do cofre. A referência deixa de ser usada;
   * quem cuida do cofre decide o resto.
   * @param actor - quem remove.
   * @param integrationId - a integração.
   * @param approval - a confirmação, quando o nível exigir.
   * @returns o que foi removido, para a tela poder dizer o nome.
   */
  async removeIntegration(actor: HubActor, integrationId: string, approval?: HubApproval): Promise<{ readonly integration_id: string; readonly name: string; readonly secret_ref: string | null }> {
    return this.#exclusiveIntegration(this.#scope(actor), () => this.#removeIntegration(actor, integrationId, approval))
  }

  async #removeIntegration(actor: HubActor, integrationId: string, approval?: HubApproval): Promise<{ readonly integration_id: string; readonly name: string; readonly secret_ref: string | null }> {
    this.#authorize(actor, 'integrations.manage')
    const current = await this.#integration(actor, integrationId)
    if (current.enabled) {
      await this.#audit(actor, 'integration.removed', integrationId, 'failure', 'still-enabled')
      throw new HubError('CONFLICT', t('errors.integrationRemoveEnabled'))
    }
    const confirmed = await this.#requireTier(actor, this.#enforcedTier(current), approval, 'integration.removed', integrationId, securityFingerprint(current))
    // Reler DEPOIS da confirmação: se alguém religou a integração enquanto a
    // pessoa confirmava, apagar agora seria apagar algo ligado.
    const latest = await this.#integration(actor, integrationId)
    if (securityFingerprint(latest) !== securityFingerprint(current) || latest.enabled) {
      await this.#audit(actor, 'integration.removed', integrationId, 'failure', 'changed-during-approval')
      throw new HubError('CONFLICT', t('errors.integrationChanged'))
    }
    await this.options.repository.deleteIntegration(actor, integrationId)
    await this.#recordApproval(actor, confirmed, 'integration.removed', integrationId)
    await this.#audit(actor, 'integration.removed', integrationId, 'success', `${latest.kind} ${latest.effective_tier}`)
    return { integration_id: latest.integration_id, name: latest.name, secret_ref: latest.secret_ref }
  }

  /**
   * Testa a conexão de UMA integração (X-04), pelo que ela é.
   *
   * O ponto deste método é NÃO inventar um "funcionando". Cada tipo tem um
   * teste que realmente fala com alguma coisa, ou diz que não tem:
   *
   * - `mcp`: pede a lista de ferramentas ao servidor, que é a menor conversa
   *   real possível com ele;
   * - `webhook`: continua sem teste até existir uma saída de rede auditada
   *   para ele — bater num endereço de fora sem passar pelos controles de
   *   chamada seria uma saída de rede sem auditoria, criada para "testar";
   * - `skill`: NÃO tem com quem conectar. Devolver "OK" aqui seria dizer que
   *   uma conexão que não existe está boa;
   * - `smtp`: tem porta própria (`testSmtp`), que manda uma mensagem de
   *   verdade e por isso exige destinatário.
   *
   * O desfecho `NOT_APPLICABLE` existe justamente para não ter que escolher
   * entre mentir e falhar.
   * @param actor - quem testa.
   * @param integrationId - a integração.
   * @returns o desfecho e a frase que a pessoa lê.
   */
  async testIntegration(actor: HubActor, integrationId: string): Promise<{ readonly result: 'OK' | 'FAILED' | 'TIMEOUT' | 'NOT_EXECUTED' | 'NOT_APPLICABLE'; readonly message: string }> {
    this.#authorize(actor, 'integrations.manage')
    const current = await this.#integration(actor, integrationId)
    if (current.kind === 'skill') {
      await this.#audit(actor, 'integration.tested', integrationId, 'not-executed', 'skill-has-no-connection')
      return { result: 'NOT_APPLICABLE', message: t('test.skillNoConnection') }
    }
    if (current.kind === 'webhook') {
      await this.#audit(actor, 'integration.tested', integrationId, 'not-executed', 'webhook-test-unavailable')
      return { result: 'NOT_APPLICABLE', message: t('test.webhookUnavailable') }
    }
    if (current.kind === 'smtp') {
      await this.#audit(actor, 'integration.tested', integrationId, 'not-executed', 'smtp-has-own-test')
      return { result: 'NOT_APPLICABLE', message: t('test.smtpElsewhere') }
    }
    if (!current.enabled) {
      await this.#audit(actor, 'integration.tested', integrationId, 'not-executed', 'disabled')
      return { result: 'NOT_EXECUTED', message: t('test.disabled') }
    }
    if (this.#mcpDispatcher === undefined) {
      // Sem despachante montado não há com quem falar. Dizer FAILED culparia o
      // servidor da pessoa por uma peça que o Studio não montou.
      await this.#audit(actor, 'integration.tested', integrationId, 'not-executed', 'no-dispatcher')
      return { result: 'NOT_EXECUTED', message: t('test.noDispatcher') }
    }
    const manifest = current.manifest
    if (manifest === null) {
      await this.#audit(actor, 'integration.tested', integrationId, 'not-executed', 'no-manifest')
      return { result: 'NOT_EXECUTED', message: t('test.noManifest') }
    }
    // Passa pelo MESMO caminho de uma chamada de verdade: parada de emergência,
    // desligamento por alcance, teto e auditoria. Um teste com caminho próprio
    // seria uma saída de rede que os controles não veem.
    // `idempotent: true` porque a sondagem NÃO chama ferramenta nenhuma: repetir
    // um aperto de mão que falhou por rede não pode ter efeito do lado de lá.
    const outcome = await this.callIntegration<McpProbeOutcome>(actor, integrationId, { operation: 'tools/list', idempotent: true },
      async signal => this.#mcpDispatcher!.probe({ integrationId, manifest, signal }))
    if (outcome.state === 'OK') return { result: 'OK', message: t('test.ok', { server: outcome.value.serverName, tools: String(outcome.value.tools.length) }) }
    // A mensagem do provedor NUNCA sai daqui: ela costuma trazer host, banner
    // ou pedaço de credencial. Sai a CLASSE do desfecho, que é o que decide.
    //
    // E TIMEOUT não vira FAILED: "não respondeu a tempo" e "recusou" mandam a
    // pessoa fazer coisas diferentes — esperar e tentar de novo, ou ir mexer na
    // configuração do servidor. Colapsar os dois num só faz ela mexer no que
    // estava certo.
    if (outcome.state === 'TIMEOUT') return { result: 'TIMEOUT', message: t('test.timeout') }
    return { result: 'FAILED', message: outcome.message }
  }

  async #exclusiveIntegration<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#integrationMutations.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolvePromise => { release = resolvePromise })
    this.#integrationMutations.set(key, current)
    await previous
    try { return await work() } finally {
      release()
      if (this.#integrationMutations.get(key) === current) this.#integrationMutations.delete(key)
    }
  }

  // ---- chamada de integração (X-08) ----------------------------------------

  /**
   * Executa UMA chamada de uma integração ligada, com tempo máximo, teto de
   * chamadas, repetição única e auditoria.
   *
   * O que sai daqui é sempre um desfecho, nunca uma exceção do provedor: a
   * mensagem de um provedor costuma trazer host, banner ou pedaço do segredo, e
   * ela nunca chega a quem chamou nem à auditoria — só a CLASSE do erro. As
   * recusas que acontecem ANTES de qualquer coisa sair pela rede (integração
   * desconhecida, desligada, sem assinatura, teto atingido) continuam sendo
   * `HubError`, porque nesses casos nada foi executado e dizer "falhou" seria
   * outra afirmação.
   * @param actor - quem aciona; escrever no projeto é o que se exige.
   * @param integrationId - a integração ligada.
   * @param request - o que está sendo feito, se repetir é seguro e quanto custa.
   * @param invoke - a chamada de verdade; recebe o sinal de desistência do tempo máximo.
   * @returns o desfecho, com quantas tentativas houve e o que se sabe do custo.
   */
  /**
   * Recusa a chamada quando um alcance está desligado.
   *
   * Os dois alcances são conferidos JUNTOS, do mais amplo ao mais fino:
   * desligar a organização desliga também os projetos dela, e religar um
   * projeto não religa a organização. Um desligamento contornável por um nível
   * mais fino não seria um desligamento.
   * @param actor - quem está chamando.
   * @param projectId - o projeto da chamada, quando há um.
   */
  assertScopeEnabled(actor: HubActor, projectId?: string): void {
    for (const switchId of killSwitchIdsFor({ orgId: actor.orgId, tenantId: actor.tenantId, ...(projectId === undefined ? {} : { projectId }) })) {
      const record = this.options.repository.killSwitch(switchId)
      if (record?.disabled === true) throw new HubError('FORBIDDEN', t('errors.scopeDisabled'))
    }
  }

  /**
   * Os desligamentos por alcance desta organização.
   * @param actor - quem está perguntando.
   * @returns os registros, do mais amplo ao mais fino.
   */
  scopeSwitches(actor: HubActor): readonly IntegrationKillSwitch[] {
    this.#authorize(actor, 'project.read')
    return this.options.repository.killSwitches(actor.orgId)
      .filter(record => record.level === 'organization' || record.tenant_id === actor.tenantId)
      .sort((left, right) => left.switch_id.localeCompare(right.switch_id))
  }

  /**
   * Liga ou desliga um alcance.
   *
   * DESLIGAR não exige motivo escrito, e RELIGAR exige — a mesma assimetria do
   * botão de emergência, pelo mesmo motivo: redigir enquanto algo está
   * queimando é o pior momento para pedir texto, e voltar a falar com
   * fornecedores é a decisão que alguém precisa assumir por escrito.
   * @param actor - quem está mexendo no botão.
   * @param scope - o alcance.
   * @param disabled - `true` desliga.
   * @param reason - o motivo; obrigatório para religar.
   * @returns o registro gravado.
   */
  async setScopeDisabled(
    actor: HubActor,
    scope: { readonly level: 'organization' } | { readonly level: 'project', readonly projectId: string },
    disabled: boolean,
    reason?: string,
  ): Promise<IntegrationKillSwitch> {
    // Mexer no botão é escrita, não leitura: quem só acompanha não desliga o
    // trabalho de todo mundo.
    this.#authorize(actor, 'project.write')
    const switchId = scope.level === 'organization'
      ? killSwitchId({ level: 'organization', orgId: actor.orgId })
      : killSwitchId({ level: 'project', orgId: actor.orgId, tenantId: actor.tenantId, projectId: scope.projectId })
    const written = (reason ?? '').trim()
    if (!disabled && written.length < 10) throw new HubError('INVALID', t('errors.scopeEnableReason'))
    if (written.length > 500) throw new HubError('INVALID', t('errors.invalidRequest'))
    const now = this.#now().toISOString()
    const current = this.options.repository.killSwitch(switchId)
    const record = integrationKillSwitchSchema.parse({
      switch_id: switchId,
      level: scope.level,
      org_id: actor.orgId,
      tenant_id: scope.level === 'organization' ? null : actor.tenantId,
      project_id: scope.level === 'organization' ? null : scope.projectId,
      disabled,
      // Os DOIS lados da história ficam guardados: a pergunta depois de um
      // incidente nunca é só "está desligado?", é "quem desligou, quando, por
      // quê, e quem assumiu a volta".
      disabled_by: disabled ? actor.userId : current?.disabled_by ?? null,
      disabled_at: disabled ? now : current?.disabled_at ?? null,
      reason: disabled ? (written === '' ? null : written) : current?.reason ?? null,
      enabled_by: disabled ? current?.enabled_by ?? null : actor.userId,
      enabled_at: disabled ? current?.enabled_at ?? null : now,
      updated_at: now,
    })
    await this.options.repository.putKillSwitch(record)
    await this.#audit(actor, 'integration.enabled', switchId, 'success', `scope ${scope.level} ${disabled ? 'disabled' : 'enabled'}`)
    return record
  }

  async callIntegration<T>(
    actor: HubActor,
    integrationId: string,
    request: IntegrationCallRequest,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<IntegrationCallResult<T>> {
    this.#authorize(actor, 'project.write')
    // Um escopo parado não fala com fornecedor nenhum. A pergunta vem antes do
    // registro e antes do teto: uma chamada barrada pela parada não pode nem
    // gastar a cota de quem ainda vai voltar a trabalhar.
    this.options.emergencyStop?.assertRunning({ orgId: actor.orgId, tenantId: actor.tenantId })
    // E o desligamento por alcance vem junto, pelo mesmo motivo: ele é a
    // resposta a "desliga tudo neste projeto" sem parar o Studio inteiro.
    this.assertScopeEnabled(actor, request.projectId)
    const record = await this.#integration(actor, integrationId)
    const operation = auditOperation(request.operation)
    // Uma integração desligada, ou cuja assinatura não confere, não é chamada por
    // ninguém — nem por um aplicativo gerado que ainda guarde o identificador de
    // quando ela estava ligada. `not-executed` é o desfecho honesto: nada saiu.
    if (!record.enabled || record.verification === 'invalid') {
      await this.#audit(actor, 'integration.called', integrationId, 'not-executed', `${operation} disabled`)
      throw new HubError('FORBIDDEN', t('errors.integrationNotEnabled'))
    }
    const key = `${this.#scope(actor)}\u0000${integrationId}`
    const startedAt = this.#now().getTime()
    this.#callLimiter.sweep(startedAt)
    if (!this.#callLimiter.admit(key, startedAt)) {
      await this.#audit(actor, 'integration.called', integrationId, 'not-executed', `${operation} rate-limited`)
      throw new HubError('RATE_LIMITED', t('errors.integrationCallTooMany'))
    }
    let attempts = 0
    let timeouts = 0
    let retried = false
    let outcome: { readonly state: 'OK'; readonly value: T } | { readonly state: 'FAILED' | 'TIMEOUT'; readonly failure: string }
    for (;;) {
      attempts += 1
      outcome = await this.#attemptCall(invoke, this.#scope(actor), integrationId)
      // Contado por TENTATIVA: duas tentativas que estouraram o tempo são dois
      // estouros, e somar um só esconderia metade da espera que a pessoa pagou.
      if (outcome.state === 'TIMEOUT') timeouts += 1
      if (outcome.state === 'OK') break
      if (!mayRetry(this.#callPolicy, request.idempotent, attempts)) break
      // A repetição também sai pela rede: ela conta no teto como qualquer outra
      // tentativa. Se o teto já não a admite, ela simplesmente não acontece —
      // dobrar a carga em cima de um provedor que está falhando é o pior momento
      // possível para gastar a cota de todo mundo.
      if (!this.#callLimiter.admit(key, this.#now().getTime())) break
      retried = true
    }
    const latencyMs = Math.max(0, this.#now().getTime() - startedAt)
    const cost = await this.#recordCall(actor, integrationId, {
      attempts, retried, latencyMs, timeouts, priceUsd: request.priceUsd,
      failure: outcome.state === 'OK' ? undefined : outcome.failure,
    })
    await this.#audit(actor, 'integration.called', integrationId,
      outcome.state === 'OK' ? 'success' : 'failure',
      `${operation} ${outcome.state} attempts=${String(attempts)} cost=${cost}`)
    if (outcome.state === 'OK') return { state: 'OK', value: outcome.value, attempts, retried, latencyMs, cost }
    return {
      state: outcome.state, attempts, retried, latencyMs, cost,
      message: outcome.state === 'TIMEOUT' ? t('errors.integrationCallTimedOut') : t('errors.integrationCallFailed'),
    }
  }

  /**
   * UMA tentativa, presa ao tempo máximo.
   *
   * O tempo máximo ABANDONA a chamada, não a mata — o Studio pede desistência
   * pelo sinal e para de esperar. Por isso a promessa perdedora recebe um
   * `catch`: uma chamada abandonada que rejeita depois não pode derrubar o
   * processo como rejeição sem dono.
   */
  async #attemptCall<T>(invoke: (signal: AbortSignal) => Promise<T>, scopeKey: string, integrationId: string): Promise<{ readonly state: 'OK'; readonly value: T } | { readonly state: 'FAILED' | 'TIMEOUT'; readonly failure: string }> {
    const abandon = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const running = (async () => invoke(abandon.signal))()
    running.catch(() => undefined)
    const live = this.#liveCalls.get(scopeKey) ?? new Map<AbortController, string>()
    live.set(abandon, integrationId)
    this.#liveCalls.set(scopeKey, live)
    try {
      const value = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abandon.abort()
            reject(new HubError('TIMEOUT', t('errors.integrationCallTimedOut')))
          }, this.#callPolicy.timeoutMs)
          timer.unref?.()
        }),
      ])
      return { state: 'OK', value }
    } catch (error) {
      if (error instanceof HubError && error.code === 'TIMEOUT') return { state: 'TIMEOUT', failure: 'timeout' }
      // Só a CLASSE do erro sobrevive: a mensagem do provedor não entra no
      // registro nem viaja de volta.
      return { state: 'FAILED', failure: error instanceof Error ? error.name : 'Error' }
    } finally {
      clearTimeout(timer)
      // A chamada saiu do registro assim que termina, de qualquer jeito que
      // termine. Sem isto, o mapa cresceria para sempre e a parada de emergência
      // relataria como "em voo" chamadas que acabaram há horas.
      live.delete(abandon)
      if (live.size === 0) this.#liveCalls.delete(scopeKey)
    }
  }

  /**
   * Pede desistência a toda chamada de integração em voo de um escopo.
   *
   * O Studio abandona a espera e avisa o adaptador pelo sinal; o que o
   * fornecedor faz do outro lado da rede ele não controla nem observa. Por isso
   * o retorno é a LISTA do que foi abandonado, e não uma contagem de
   * canceladas: quem chamou apresenta essas chamadas como não provadas.
   * @param scope - a organização e o inquilino parados.
   * @returns os identificadores das integrações cujas chamadas foram abandonadas.
   */
  cancelScope(scope: { readonly orgId: string; readonly tenantId: string }): readonly string[] {
    const key = `${scope.orgId}\u0000${scope.tenantId}`
    const live = this.#liveCalls.get(key)
    if (live === undefined) return []
    const abandoned: string[] = []
    for (const [controller, integrationId] of [...live.entries()]) {
      controller.abort()
      abandoned.push(integrationId)
    }
    return abandoned
  }

  // ---- integração do tipo MCP (X-11) ---------------------------------------

  /**
   * Instala o despachante MCP deste Studio.
   *
   * Um só. Uma segunda instalação é erro e não troca nada: dois clientes MCP
   * montados significariam dois catálogos de servidores e dois conjuntos de
   * tetos, e a chamada acabaria decidida por qual dos dois montou por último —
   * que é justamente a coisa que ninguém consegue depurar.
   * @param port - quem sabe falar MCP.
   * @returns a função que desinstala o despachante (para o `ctx.effect` de quem montou).
   */
  useMcpDispatcher(port: McpDispatchPort): () => void {
    if (this.#mcpDispatcher !== undefined) throw new HubError('CONFLICT', t('errors.mcpDispatcherInstalled'))
    this.#mcpDispatcher = port
    return () => { if (this.#mcpDispatcher === port) this.#mcpDispatcher = undefined }
  }

  /** Se este Studio tem com quem falar MCP agora. A tela pergunta antes de oferecer o botão. */
  get mcpAvailable(): boolean { return this.#mcpDispatcher !== undefined }

  /**
   * Chama UMA ferramenta de uma integração do tipo `mcp`.
   *
   * As três recusas que acontecem ANTES de qualquer processo subir, todas
   * auditadas como `not-executed` porque nada foi executado:
   *
   * 1. A integração não é do tipo `mcp`.
   * 2. O manifesto gravado não tem assinatura VÁLIDA agora. Não basta o campo
   *    `verification` do registro: ele foi decidido no cadastro, e desde então a
   *    linha pode ter sido alterada por qualquer outro escritor da tabela. Por
   *    isso a assinatura é reconferida aqui, sobre os bytes que estão gravados.
   *    Sem assinatura, com assinatura alterada, com manifesto alterado ou de um
   *    publicador sem chave: a conexão não acontece. Uma conexão MCP executa
   *    programa neste computador — `unverified` não é suficiente, ao contrário
   *    do que `callIntegration` aceita para os outros tipos.
   * 3. Não há despachante MCP montado neste perfil.
   *
   * Passadas as três, quem manda é `callIntegration`: parada de emergência,
   * tempo máximo, teto por escopo, repetição única, custo e auditoria. Nenhuma
   * dessas políticas é reescrita aqui.
   * @param actor - quem aciona; escrever no projeto é o que se exige.
   * @param integrationId - a integração ligada, do tipo `mcp`.
   * @param request - a ferramenta, os argumentos, se repetir é seguro e quanto custa.
   * @returns o desfecho da chamada, com o que o servidor real respondeu.
   */
  async callMcpTool(actor: HubActor, integrationId: string, request: McpToolCallRequest): Promise<IntegrationCallResult<McpCallOutcome>> {
    this.#authorize(actor, 'project.write')
    const record = await this.#integration(actor, integrationId)
    const operation = auditOperation(`mcp.${request.tool}`)
    if (record.kind !== 'mcp') {
      await this.#audit(actor, 'integration.called', integrationId, 'not-executed', `${operation} not-mcp`)
      throw new HubError('INVALID', t('errors.integrationNotMcp'))
    }
    const evaluation = evaluateManifest(record.manifest, this.options.publisherKeys)
    if (evaluation.verification !== 'verified' || evaluation.manifest === null) {
      await this.#audit(actor, 'integration.called', integrationId, 'not-executed', `${operation} unsigned`)
      throw new HubError('FORBIDDEN', t('errors.mcpManifestNotVerified'))
    }
    const dispatcher = this.#mcpDispatcher
    if (dispatcher === undefined) {
      await this.#audit(actor, 'integration.called', integrationId, 'not-executed', `${operation} no-dispatcher`)
      throw new HubError('NOT_EXECUTED', t('errors.mcpDispatcherMissing'))
    }
    const manifest = evaluation.manifest
    return this.callIntegration<McpCallOutcome>(
      actor, integrationId,
      { operation, idempotent: request.idempotent, priceUsd: request.priceUsd },
      signal => dispatcher.call({ integrationId, manifest, tool: request.tool, arguments: request.arguments ?? {}, signal }),
    )
  }

  /**
   * Soma esta chamada aos contadores da integração.
   *
   * Escreve por cima do registro MAIS RECENTE, dentro da mesma exclusão que o
   * registro e o ligar/desligar usam: um contador gravado a partir de uma cópia
   * antiga desfaria, calado, um `enable` ou um novo manifesto que chegou no
   * meio da chamada.
   *
   * Sem preço informado, o custo NÃO soma zero: a chamada entra em
   * `unpriced_calls`, e é isso que faz o estado do custo ser `PARTIAL` ou
   * `UNKNOWN` em vez de um "custou zero" que ninguém mediu.
   */
  async #recordCall(actor: HubActor, integrationId: string, call: {
    readonly attempts: number
    readonly retried: boolean
    readonly latencyMs: number
    readonly timeouts: number
    readonly priceUsd: number | undefined
    readonly failure: string | undefined
  }): Promise<IntegrationCostState> {
    return this.#exclusiveIntegration(this.#scope(actor), async () => {
      const latest = await this.options.repository.integration(actor, integrationId)
      // A integração deixou de existir durante a chamada: não há registro para
      // somar. A auditoria acima continua sendo a prova de que ela aconteceu.
      if (latest === undefined) return integrationCostState({ calls: call.attempts, unpriced_calls: call.priceUsd === undefined ? call.attempts : 0 })
      const failed = call.failure !== undefined
      const priced = call.priceUsd !== undefined && Number.isFinite(call.priceUsd)
      const updated: StudioIntegration = {
        ...latest,
        calls: (latest.calls ?? 0) + call.attempts,
        failures: (latest.failures ?? 0) + (failed ? call.attempts : call.attempts - 1),
        // Zera no primeiro sucesso: uma integração que voltou a responder volta a
        // ser `OK` sem esperar nada.
        consecutive_failures: failed ? (latest.consecutive_failures ?? 0) + call.attempts : 0,
        timeouts: (latest.timeouts ?? 0) + call.timeouts,
        retries: (latest.retries ?? 0) + (call.retried ? 1 : 0),
        total_latency_ms: (latest.total_latency_ms ?? 0) + call.latencyMs,
        last_call_at: this.#stamp(),
        last_failure: failed ? call.failure! : latest.last_failure ?? null,
        cost_usd: (latest.cost_usd ?? 0) + (priced ? call.priceUsd! : 0),
        unpriced_calls: (latest.unpriced_calls ?? 0) + (priced ? 0 : call.attempts),
      }
      await this.options.repository.putIntegration(updated)
      return integrationCostState(updated)
    })
  }

  // ---- smtp for generated apps ---------------------------------------------

  async smtp(actor: HubActor): Promise<{ configured: boolean; secret_ref: string | null; tier: PolicyTier }> {
    this.#authorize(actor, 'workspace.read')
    const record = await this.#smtpRecord(actor)
    const configured = record !== undefined && record.enabled && record.secret_ref !== null
    return { configured, secret_ref: configured ? record.secret_ref : null, tier: SMTP_TIER }
  }

  async configureSmtp(actor: HubActor, secretRefInput: unknown, approval?: HubApproval): Promise<StudioIntegration> {
    this.#authorize(actor, 'integrations.manage')
    const parsed = secretRefSchema.safeParse(canonicalSecretRef(secretRefInput))
    if (!parsed.success) throw new HubError('INVALID', t('errors.secretRefInvalid'))
    // The confirmation has to have been given for THIS alias: the fingerprint of the reference is
    // what separates a decision about `DZ23_APP_SMTP` from one about somebody else's credential.
    const confirmed = await this.#requireTier(actor, SMTP_TIER, approval, 'smtp.configured', SMTP_SUBJECT, await this.#fingerprint(actor, 'smtp.configured', SMTP_SUBJECT, parsed.data))
    const inspection = await this.options.secrets.inspect(parsed.data)
    // A refusal is part of the history too: "nothing happened" must be visible, not absent. The
    // subject is the SMTP setting itself — the alias is a name in the vault and never a subject id.
    if (!inspection.present) {
      await this.#audit(actor, 'smtp.configured', SMTP_SUBJECT, 'failure', 'secret-missing')
      throw new HubError('INVALID', t('errors.secretRefMissing'))
    }
    if (!inspection.shapeOk) {
      await this.#audit(actor, 'smtp.configured', SMTP_SUBJECT, 'failure', 'secret-shape')
      throw new HubError('INVALID', t('errors.secretShapeInvalid'))
    }
    const now = this.#stamp()
    const existing = await this.#smtpRecord(actor)
    const record: StudioIntegration = {
      integration_id: existing?.integration_id ?? this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      kind: 'smtp', name: t('smtp.integrationName'), manifest: null, effective_tier: SMTP_TIER, verification: 'verified',
      enabled: true, secret_ref: parsed.data, created_by: existing?.created_by ?? actor.userId, created_at: existing?.created_at ?? now, updated_at: now,
    }
    await this.options.repository.putIntegration(record)
    await this.#recordApproval(actor, confirmed, 'smtp.configured', record.integration_id)
    // Proof that a reference was configured, never the reference: the alias names a credential, and
    // an audit that spells it out hands a reader the shopping list for the vault.
    await this.#audit(actor, 'smtp.configured', record.integration_id, 'success', minimizeSecretRef(parsed.data))
    return record
  }

  async testSmtp(actor: HubActor, to: string, approval?: HubApproval): Promise<{ result: 'SENT' | 'NOT_EXECUTED'; message: string }> {
    this.#authorize(actor, 'integrations.manage')
    const record = await this.#smtpRecord(actor)
    if (record === undefined || record.secret_ref === null || !record.enabled) throw new HubError('NOT_FOUND', t('errors.smtpNotConfigured'))
    // The address is checked BEFORE the confirmation is spent: a typo must not cost the person their
    // confirmation, and the ticket is bound to this exact recipient anyway.
    const recipient = z.string().trim().email().safeParse(to)
    if (!recipient.success) {
      await this.#audit(actor, 'smtp.tested', record.integration_id, 'failure', 'invalid-recipient')
      throw new HubError('INVALID', t('errors.invalidRequest'))
    }
    // Bound to the address the person confirmed: a ticket taken for one recipient cannot send to another.
    const confirmed = await this.#requireTier(actor, this.#enforcedTier(record), approval, 'smtp.tested', SMTP_SUBJECT, await this.#fingerprint(actor, 'smtp.tested', SMTP_SUBJECT, recipient.data))
    if (this.options.emailTest === undefined) {
      await this.#recordApproval(actor, confirmed, 'smtp.tested', record.integration_id)
      await this.#audit(actor, 'smtp.tested', record.integration_id, 'not-executed', t('errors.smtpTestDisabled'))
      return { result: 'NOT_EXECUTED', message: t('errors.smtpTestDisabled') }
    }
    try {
      await this.options.emailTest.sendTest(record.secret_ref, recipient.data)
    } catch (error) {
      // Provider messages can carry hostnames, banners or fragments of the secret: only the error class is kept.
      await this.#audit(actor, 'smtp.tested', record.integration_id, 'failure', error instanceof Error ? error.name : 'Error')
      throw new HubError('INVALID', t('errors.smtpTestFailed'))
    }
    await this.#recordApproval(actor, confirmed, 'smtp.tested', record.integration_id)
    // The audit trail proves a test happened; it does not need to keep somebody's address in the clear.
    await this.#audit(actor, 'smtp.tested', record.integration_id, 'success', minimizeRecipient(recipient.data))
    return { result: 'SENT', message: t('audit.smtpTested') }
  }

  // ---- exports ---------------------------------------------------------------

  async listExports(actor: HubActor, projectId: string): Promise<readonly StudioExport[]> {
    this.#authorize(actor, 'project.read')
    this.options.projects.project(actor, projectId)
    return await this.options.repository.exports(actor, projectId)
  }

  /**
   * Packaging reads a whole run directory, hashes it and writes a file — the
   * most expensive thing this plugin does, on a process with one thread for
   * every workspace. So: one build per workspace and project at a time (a
   * second caller joins the first instead of starting a twin), and a ceiling on
   * how many a workspace may start inside the window.
   */
  async createExport(actor: HubActor, projectId: string): Promise<StudioExport> {
    this.#authorize(actor, 'project.write')
    const key = `${this.#scope(actor)}\u0000${projectId}`
    const running = this.#exportsInFlight.get(key)
    if (running !== undefined) return running.answer
    // Registered SYNCHRONOUSLY, before the first await: ten clicks arriving in the same tick must
    // find the build already in flight, not each other's absence.
    //
    // The entry lives until the BUILD settles, not until the caller's answer does. A build the
    // Studio stopped waiting for is abandoned, not cancelled: it is still walking the run and still
    // holding the name of the package it may write. Deleting the entry when the caller was told
    // TIMEOUT let the next click start a twin of exactly that build, and both twins passed the
    // "same run, same bytes → hand back the existing package" check before either wrote its row.
    const entry: ExportInFlight = { answer: undefined as unknown as Promise<StudioExport> }
    // Nothing can replace this entry while it is there — a second click finds it and joins it — so
    // when the build it stands for is over, it is this one that goes.
    entry.answer = this.#guardedExport(actor, projectId, () => { this.#exportsInFlight.delete(key) })
    this.#exportsInFlight.set(key, entry)
    // The caller below awaits this same promise; the handler is only here so that a rejection which
    // nobody joins is never an unhandled one.
    void entry.answer.catch(() => undefined)
    return entry.answer
  }

  async #guardedExport(actor: HubActor, projectId: string, whenSettled: () => void): Promise<StudioExport> {
    // One build per workspace is not enough on its own: two DIFFERENT workspaces packaging at the
    // same time each walk a whole run and hash it, on the one thread this Studio has. Past this
    // ceiling the caller waits its turn instead of making everybody's Studio slow at once.
    let started = false
    try {
      await this.#throttleExport(actor, projectId)
      // From here the packaging call itself decides when the in-flight entry may go.
      started = true
      return await this.#withPackagingSlot(lease => this.#createExport(actor, projectId, lease), whenSettled)
    } catch (error) {
      if (!started) whenSettled()
      // A refusal nobody can see is not a refusal: the person is told the Studio stopped waiting,
      // and the history says so too, with the project it happened on. It is the ONLY row this
      // attempt writes: the abandoned call may no longer add a second, contradictory one.
      if (error instanceof HubError && error.code === 'TIMEOUT') await this.#audit(actor, 'export.created', projectId, 'failure', 'packaging-timeout')
      throw error
    }
  }

  async #withPackagingSlot<T>(work: (lease: PackagingLease) => Promise<T>, whenSettled: () => void): Promise<T> {
    while (this.#packaging >= MAX_CONCURRENT_PACKAGING) {
      if (this.#packagingQueue.length >= MAX_PACKAGING_QUEUE) throw new HubError('RATE_LIMITED', t('errors.exportQueueFull'))
      await new Promise<void>((release, reject) => {
        let timer: ReturnType<typeof setTimeout>
        const entry = {
          release: () => { clearTimeout(timer); release() },
          reject,
        }
        this.#packagingQueue.push(entry)
        timer = setTimeout(() => {
          const index = this.#packagingQueue.indexOf(entry)
          if (index >= 0) this.#packagingQueue.splice(index, 1)
          reject(new HubError('TIMEOUT', t('errors.exportTimedOut')))
        }, this.options.packagingTimeoutMs ?? PACKAGING_SLOT_TIMEOUT_MS)
        timer.unref?.()
      })
    }
    this.#packaging += 1
    let held = true
    const releaseSlot = (): void => {
      if (!held) return
      held = false
      this.#packaging -= 1
      this.#packagingQueue.shift()?.release()
    }
    let decided = false
    // Assigned by the executor of the deadline below, which runs before anything is awaited.
    let timer!: ReturnType<typeof setTimeout>
    const abandon = new AbortController()
    /**
     * The right to finish, held by exactly one of two parties. `commit()` reads and sets `decided`
     * with NO await in between, so on this one thread either the build claims the outcome or the
     * ceiling does — never both. That is what makes "you were told it timed out" and "it was
     * recorded as done" impossible for the same attempt.
     */
    const lease: PackagingLease = {
      get abandoned(): boolean { return abandon.signal.aborted },
      signal: abandon.signal,
      commit: (): boolean => {
        if (decided) return false
        decided = true
        return true
      },
    }
    const running = work(lease)
    // Whatever the caller is told, the build is only over when THIS promise settles: until then a
    // second click joins it instead of starting a twin of a call that is still running.
    const settled = (): void => { releaseSlot(); whenSettled() }
    running.then(settled, settled)
    try {
      // The slot is bounded in TIME, not only in number. `work()` that outlives the ceiling keeps
      // running (nothing here can cancel a syscall), but it no longer owns a slot, no longer holds
      // the queue behind it, and — since it lost the lease — may no longer write a file, a row or
      // an audit line for an attempt the person was already told had timed out.
      return await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // The slot goes back whatever else is true: a call that has held its turn this long is
            // never allowed to become everybody's outage, and that was the whole point of the ceiling.
            releaseSlot()
            // The build already claimed the outcome and is writing the record down. It is NOT refused
            // here: the Studio cannot tell somebody "it did not happen" about a row it may have
            // written. What the ceiling protects — the slot — has been given back above.
            if (decided) return
            decided = true
            abandon.abort()
            reject(new HubError('TIMEOUT', t('errors.exportTimedOut')))
          }, this.options.packagingTimeoutMs ?? PACKAGING_SLOT_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Attempts per workspace inside the window; a refusal is audited and costs the flooder, not the table. */
  async #throttleExport(actor: HubActor, projectId: string): Promise<void> {
    const now = this.#now().getTime()
    const key = this.#scope(actor)
    const recent = (this.#exportAttempts.get(key) ?? []).filter(at => now - at < EXPORT_WINDOW_MS)
    if (recent.length >= MAX_EXPORTS_PER_WINDOW) {
      this.#exportAttempts.set(key, recent)
      await this.#audit(actor, 'export.created', projectId, 'failure', 'rate-limited')
      throw new HubError('RATE_LIMITED', t('errors.exportTooMany'))
    }
    this.#exportAttempts.set(key, [...recent, now])
    // The map is keyed by a workspace that had to authenticate; the windows themselves are pruned above.
    if (this.#exportAttempts.size > MAX_APPROVAL_SCOPES) {
      for (const [scope, attempts] of this.#exportAttempts) {
        if (scope !== key && attempts.every(at => now - at >= EXPORT_WINDOW_MS)) this.#exportAttempts.delete(scope)
      }
    }
  }

  async #createExport(actor: HubActor, projectId: string, lease: PackagingLease): Promise<StudioExport> {
    /**
     * The build lost the lease: the ceiling already answered the person and already wrote the one
     * row this attempt gets. Nothing more may be written under its name — and whatever it managed
     * to leave on disk goes with it. The error is the same TIMEOUT the caller was handed, so the
     * only place it can ever surface says the same thing.
     */
    const abandoned = (): HubError => new HubError('TIMEOUT', t('errors.exportTimedOut'))
    const project = this.options.projects.project(actor, projectId)
    const refuse = async (detail: string, error: HubError): Promise<never> => {
      // A refusal is an outcome too: it claims the lease, so the ceiling can no longer answer over it.
      if (!lease.commit()) throw abandoned()
      await this.#audit(actor, 'export.created', projectId, 'failure', detail)
      throw error
    }
    if (project.state !== 'VERIFIED_PROTOTYPE') return await refuse(`state ${project.state}`, new HubError('INVALID', t('errors.exportNotVerified')))
    const run = [...this.options.projects.runs(actor, projectId)].filter(value => value.state === 'PASSED')
      .sort((left, right) => (right.started_at < left.started_at ? -1 : right.started_at > left.started_at ? 1 : 0) || right.attempt - left.attempt)[0]
    if (run === undefined) return await refuse('no PASSED run', new HubError('INVALID', t('errors.exportNotVerified')))
    // The run directory arrives as data from another plugin: it is confined to the runs root by real path before anything is read.
    let confinedRun: { handle: FileHandle; path: string }
    try {
      confinedRun = await this.#openConfinedRunDirectory(run.run_directory)
    } catch (error) {
      return await refuse(error instanceof HubError ? `run-directory ${error.code}` : 'run-directory', error instanceof HubError ? error : new HubError('INVALID', t('errors.exportRunMissing')))
    }
    let built
    try {
      built = await packagePrototype({ runDirectory: confinedRun.path, runHandle: confinedRun.handle, projectName: project.name, runId: run.run_id, signal: lease.signal })
    } catch (error) {
      // The class of refusal survives to the boundary: a package refused because it carries a secret
      // is not the same answer as a malformed request, and the documents promised those statuses.
      // The DETAIL travels with the code: three different refusals used to reach the history as a
      // bare `TOO_LARGE`, and a package refused for carrying a secret named the file on the screen
      // and nowhere in the row. The detail is a path or a reason, never the matched text.
      if (error instanceof ExportError) return await refuse(`${error.code} ${error.detail}`, new HubError(exportErrorCode(error.code), error.code === 'INVALID_PATH' ? t('errors.internal') : error.message))
      // Anything else (an unreadable folder, a name the filesystem returns as invalid UTF-8) used to
      // leave through the front door as a 500 with no audit at all — the person saw "something went
      // wrong" and the history said nothing had been attempted.
      return await refuse(`package-failed ${error instanceof Error ? error.name : 'Error'}`, new HubError('INVALID', t('errors.exportFailed')))
    } finally {
      await confinedRun.handle.close().catch(() => undefined)
    }
    // The walk is over and it took longer than the ceiling allows: the person has already been told
    // the Studio stopped waiting. Nothing below this line may run — no file, no row, no audit.
    if (lease.abandoned) throw abandoned()
    // Same run, same bytes: hand back the existing package instead of writing a twin file on every click.
    const existing = (await this.listExports(actor, projectId)).find(value => value.run_id === run.run_id && value.sha256 === built.sha256)
    // No lease is claimed here on purpose: handing back a package that was already on disk writes
    // no file, no row and no audit line, so there is nothing for the ceiling to contradict — and a
    // guard whose failure changes nothing is not a guard.
    if (existing !== undefined && await exists(existing.path)) return existing
    const exportId = this.#createId()
    // Every segment that becomes a path here is checked, not trusted: ids and scope names never carry `..`, separators or control characters.
    const directory = resolve(this.options.exportsRoot, safeSegment(actor.orgId), safeSegment(actor.tenantId))
    const scope = await this.#openExportScope(actor, true)
    const path = resolve(directory, `${safeSegment(exportId)}.zip`)
    // Created, not opened: O_EXCL means this call makes the file or fails, O_NOFOLLOW means a
    // symlink planted at that name is never followed, and the mode is set BY the open — a `chmod`
    // afterwards leaves a window in which the package is readable by anyone on the machine.
    let target: FileHandle | undefined
    try {
      target = await open(join(referenceOf(scope.handle, directory), `${safeSegment(exportId)}.zip`), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
      await target.writeFile(built.archive)
    } finally {
      await target?.close().catch(() => undefined)
      await scope.handle.close().catch(() => undefined)
    }
    // The package exists on disk; the row and the history line do not yet. This is the last moment
    // at which this attempt can still be given up, so it is where the lease is claimed: from here
    // the ceiling can no longer answer over it, and the person gets the export they waited for.
    // Losing here means the abandoned `.zip` is removed and nothing is ever recorded about it —
    // the history used to carry BOTH `failure / packaging-timeout` and `success` for one click.
    if (!lease.commit()) {
      await unlink(path).catch(() => undefined)
      throw abandoned()
    }
    const record: StudioExport = {
      export_id: exportId, org_id: actor.orgId, tenant_id: actor.tenantId, project_id: projectId, run_id: run.run_id,
      file_name: built.fileName, path, sha256: built.sha256, size_bytes: built.archive.length, entries: built.entries,
      created_by: actor.userId, created_at: this.#stamp(),
    }
    await this.options.repository.putExport(record)
    await this.#audit(actor, 'export.created', exportId, 'success', `${built.fileName} ${built.sha256}`)
    return record
  }

  async exportRecord(actor: HubActor, projectId: string, exportId: string): Promise<StudioExport> {
    this.#authorize(actor, 'project.read')
    this.options.projects.project(actor, projectId)
    const record = await this.options.repository.export(actor, projectId, exportId)
    if (record === undefined) throw new HubError('NOT_FOUND', t('errors.exportNotFound'))
    return record
  }

  /**
   * The file to send for a package, resolved by real path and refused unless it
   * sits inside this workspace's export folder. The stored path is data: a row
   * that was tampered with (or written by an older build) must not be able to
   * turn the download route into "read any file on the server".
   */
  async exportFile(actor: HubActor, projectId: string, exportId: string): Promise<{ handle: FileHandle; size: number }> {
    const record = await this.exportRecord(actor, projectId, exportId)
    const root = resolve(this.options.exportsRoot, safeSegment(actor.orgId), safeSegment(actor.tenantId))
    const expected = resolve(root, `${safeSegment(exportId)}.zip`)
    if (resolve(record.path) !== expected) {
      await this.#audit(actor, 'export.downloadRefused', exportId, 'failure', 'path-outside-exports')
      throw new HubError('NOT_FOUND', t('errors.exportUnavailable'))
    }
    // Everything above decided about a NAME. What is served is a HANDLE: opened once without
    // following a link, checked for being a regular file on that same handle, and streamed from it.
    // Resolving the name and then opening it again is exactly the window an attacker needs.
    const scope = await this.#openExportScope(actor, false).catch(() => undefined)
    if (scope === undefined) throw new HubError('NOT_FOUND', t('errors.exportUnavailable'))
    // O_NONBLOCK is required here: opening a FIFO read-only can otherwise block
    // a libuv worker forever before the regular-file check below can refuse it.
    const handle = await open(join(referenceOf(scope.handle, root), `${safeSegment(exportId)}.zip`), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)).catch(() => undefined)
    await scope.handle.close().catch(() => undefined)
    if (handle === undefined) throw new HubError('NOT_FOUND', t('errors.exportUnavailable'))
    const info = await handle.stat().catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      await handle.close().catch(() => undefined)
      await this.#audit(actor, 'export.downloadRefused', exportId, 'failure', 'not-a-regular-file')
      throw new HubError('NOT_FOUND', t('errors.exportUnavailable'))
    }
    return { handle, size: info.size }
  }

  /**
   * One page of this workspace's history, newest first. The whole table never
   * travels in a single answer: an audit trail grows for as long as the Studio
   * runs, and a route that returned all of it was a way to make the server do
   * unbounded work on request.
   */
  async events(actor: HubActor, page: { readonly limit?: number | undefined; readonly cursor?: string | undefined } = {}): Promise<{ events: readonly HubEvent[]; next_cursor: string | null }> {
    this.#authorize(actor, 'audit.read')
    const limit = Math.min(Math.max(Math.trunc(page.limit ?? EVENTS_PAGE_SIZE), 1), EVENTS_PAGE_MAX)
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor)
    const pageRows = await this.options.repository.eventPage(actor, after, limit + 1)
    const window = pageRows.slice(0, limit)
    const last = window.at(-1)
    // A cursor only exists while there is something after it: the client stops without a second empty round trip.
    const more = last !== undefined && pageRows.length > limit
    return { events: window, next_cursor: more ? encodeCursor(last) : null }
  }

  // ---- internals -----------------------------------------------------------

  async #smtpRecord(actor: HubActor): Promise<StudioIntegration | undefined> {
    return (await this.options.repository.integrations(actor)).find(value => value.kind === 'smtp' && value.manifest === null)
  }

  async #integration(actor: HubActor, integrationId: string): Promise<StudioIntegration> {
    const value = await this.options.repository.integration(actor, integrationId)
    if (value === undefined) throw new HubError('NOT_FOUND', t('errors.integrationNotFound'))
    return value
  }

  /**
   * D16 enforcement, in the same place that computes the tier: T0/T1 proceed,
   * T2 needs a confirmation recorded for exactly that tier, T3 needs that plus
   * a recent strong identity on this session. Every refusal is audited.
   */
  async #requireTier(actor: HubActor, tier: PolicyTier, approval: HubApproval | undefined, action: HubEvent['action'], subjectId: string, fingerprint: string): Promise<boolean> {
    // The RETURN VALUE is what may be written into the history afterwards: `true` only when this
    // tier really demanded a confirmation and a real ticket was found, checked and burned here.
    if (!needsApproval(tier)) return false
    // Looked up INSIDE this workspace's bucket: an id from another org or tenant is not even visible here.
    const bucket = this.#approvals.get(this.#scope(actor))
    const ticket = approval === undefined ? undefined : bucket?.get(approval.approvalId)
    const now = this.#now().getTime()
    const usable = ticket !== undefined
      && ticket.tier === tier
      && ticket.action === action
      && ticket.subject_id === subjectId
      && ticket.org_id === actor.orgId
      && ticket.tenant_id === actor.tenantId
      // What the person confirmed, not merely which action: another alias, another address or a
      // record whose security fields changed since is a different decision.
      && ticket.fingerprint === fingerprint
      && ticket.user_id === actor.userId
      && ticket.session_id === actor.sessionId
      && Date.parse(ticket.expires_at) > now
    if (!usable) {
      // A ticket that does not fit this action is spent anyway: it was presented, and a presented
      // ticket never gets a second chance.
      if (ticket !== undefined) bucket?.delete(ticket.approval_id)
      await this.#audit(actor, action, subjectId, 'failure', `approval-required ${tier}`)
      throw new HubError('FORBIDDEN', tier === 'T3' ? t('errors.approvalRequiredT3') : t('errors.approvalRequiredT2'))
    }
    if (tier === 'T3') {
      // Fail closed: without a recent passkey on this very session, a T3 action never runs.
      if (actor.strongIdentityVerified !== true) {
        // The confirmation is NOT spent here: the person is being told to go and confirm with the
        // passkey, and burning the ticket would greet them with "confirm again" instead.
        await this.#audit(actor, action, subjectId, 'failure', 'strong-identity-required')
        throw new HubError('FORBIDDEN', t('errors.strongIdentityRequired'))
      }
    }
    // Honoured now: burned synchronously, with no await in between, so two requests presenting the
    // same id cannot both get through.
    bucket?.delete(ticket.approval_id)
    return true
  }

  /**
   * Written only after the action itself succeeded, and only when a confirmation was actually
   * required and actually spent. It used to be written whenever the request CARRIED an `approval`
   * field: on a T0/T1 integration, where nothing is confirmed and no ticket is checked, sending
   * `{"approval":{"approval_id":"anything"}}` was enough to put "Confirmação da pessoa registrada"
   * in the history of an action nobody confirmed. The audit trail is read by people as proof; a row
   * that can be asked for is not proof of anything.
   */
  async #recordApproval(actor: HubActor, confirmed: boolean, action: HubEvent['action'], subjectId: string): Promise<void> {
    if (!confirmed) return
    await this.#audit(actor, 'approval.recorded', subjectId, 'success', action)
  }

  /** Walks from a pinned `runsRoot` descriptor; the packager receives the final descriptor, never a re-resolved name. */
  async #openConfinedRunDirectory(candidate: string): Promise<{ handle: FileHandle; path: string }> {
    const root = resolve(this.options.runsRoot)
    const target = resolve(candidate)
    const inside = relative(root, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new HubError('INVALID', t('errors.exportRunOutside'))
    let handle = await openDirectory(root)
    if (handle === undefined) throw new HubError('CONFLICT', t('errors.exportRunMissing'))
    let currentPath = root
    for (const segment of inside.split(/[\\/]/u)) {
      const child = await openChildDirectory(handle, currentPath, segment)
      await handle.close().catch(() => undefined)
      if (child === undefined) throw new HubError('CONFLICT', t('errors.exportRunMissing'))
      handle = child
      currentPath = join(currentPath, segment)
    }
    return { handle, path: target }
  }

  async #openExportScope(actor: HubActor, create: boolean): Promise<{ handle: FileHandle }> {
    const rootPath = resolve(this.options.exportsRoot)
    let handle = await openDirectory(rootPath)
    if (handle === undefined) throw new HubError('CONFLICT', t('errors.exportUnavailable'))
    let currentPath = rootPath
    for (const segment of [safeSegment(actor.orgId), safeSegment(actor.tenantId)]) {
      const reference = join(referenceOf(handle, currentPath), segment)
      if (create) await mkdir(reference, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      })
      const child = await openChildDirectory(handle, currentPath, segment)
      await handle.close().catch(() => undefined)
      if (child === undefined) throw new HubError('CONFLICT', t('errors.exportUnavailable'))
      handle = child
      currentPath = join(currentPath, segment)
    }
    return { handle }
  }

  #authorize(actor: HubActor, permission: StudioPermission): void {
    if (!roleAllows(actor.role, permission)) throw new HubError('FORBIDDEN', t('errors.forbidden'))
  }

  async #audit(actor: HubActor, action: HubEvent['action'], subjectId: string, outcome: HubEvent['outcome'], detail: string): Promise<void> {
    await this.options.repository.putEvent({
      event_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId, actor_user_id: actor.userId,
      action, subject_id: subjectId, outcome, detail: detail.slice(0, 500), created_at: this.#stamp(),
    })
    await this.#retainEvents(actor)
  }

  /**
   * Retention, per workspace: the history keeps the most recent
   * `EVENTS_RETAINED_PER_TENANT` events and the older ones leave. Without this
   * the table only ever grew, and anybody able to make the Studio refuse
   * something could grow it for free. One workspace's ceiling never touches
   * another's rows.
   */
  async #retainEvents(actor: HubActor): Promise<void> {
    // A poda decide sozinha se há o que podar, e devolve zero quando não há.
    // Perguntar a contagem ANTES custava uma leitura inteira das linhas do
    // inquilino a cada linha de auditoria — duas leituras no caminho quente
    // para, na esmagadora maioria das vezes, não apagar nada. Sob o
    // repositório com RLS isso é uma consulta ao banco por evento gravado.
    await this.options.repository.pruneEvents(actor, EVENTS_RETAINED_PER_TENANT)
  }
}

// ---- despachante MCP (X-11) -----------------------------------------------
//
// O Hub não sabe falar MCP e não vai aprender: ele sabe QUEM pode ser chamado,
// com que teto, quantas vezes e com que registro. Quem fala o protocolo é
// `plugins/mcp-client`, e ele entra por esta porta.

/** O que o Hub entrega ao despachante MCP. O corpo da chamada nunca volta para a auditoria. */
export interface McpDispatchInput {
  readonly integrationId: string
  /** O manifesto ASSINADO e reconferido nesta chamada; é ele que identifica o servidor cadastrado. */
  readonly manifest: IntegrationManifest
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  /** A desistência do Hub: o tempo máximo da chamada e o botão de emergência falam por aqui. */
  readonly signal: AbortSignal
}

/** O que voltou de um servidor MCP real. `tools` é a lista que ELE anunciou, não uma esperada. */
export interface McpCallOutcome {
  readonly protocolVersion: string
  readonly serverName: string
  readonly tools: readonly string[]
  readonly content: readonly { readonly type: string; readonly text?: string | undefined }[]
  /** Do protocolo: o servidor executou e a FERRAMENTA falhou. Não é o mesmo que a chamada ter falhado. */
  readonly isError: boolean
}

/**
 * A porta de saída para MCP.
 *
 * Interface estrutural, como `EmergencyStopGuard`: o Hub continua subindo — e
 * recusando toda chamada MCP com `NOT_EXECUTED` auditado — num perfil que não
 * monte cliente nenhum.
 */
export interface McpDispatchPort {
  call(input: McpDispatchInput): Promise<McpCallOutcome>
  /**
   * Abre a conexão, cumprimenta, lê o catálogo e FECHA — sem chamar ferramenta
   * nenhuma (X-04).
   *
   * É esta a diferença entre testar e usar: um teste de conexão que executasse
   * uma ferramenta poderia mandar um e-mail, criar um registro ou apagar algo
   * do lado de lá, e ninguém aperta "testar" esperando efeito.
   */
  probe(input: McpProbeInput): Promise<McpProbeOutcome>
}

/** O que o Hub entrega para um teste de conexão: quem é o servidor e até quando esperar. */
export interface McpProbeInput {
  readonly integrationId: string
  readonly manifest: IntegrationManifest
  readonly signal: AbortSignal
}

/** O que um servidor MCP real respondeu ao aperto de mão. `tools` é o que ELE anunciou. */
export interface McpProbeOutcome {
  readonly protocolVersion: string
  readonly serverName: string
  readonly tools: readonly string[]
}

/** O que uma chamada de ferramenta MCP pede. Herda de `IntegrationCallRequest` o que o teto e o custo usam. */
export interface McpToolCallRequest extends Omit<IntegrationCallRequest, 'operation'> {
  readonly tool: string
  readonly arguments?: Readonly<Record<string, unknown>> | undefined
}

/** O que está sendo chamado, para o teto, para a repetição e para a auditoria. Nunca o corpo da chamada. */
export interface IntegrationCallRequest {
  /** Nome curto e técnico da operação; é o que a auditoria guarda. */
  readonly operation: string
  /**
   * Se repetir é o mesmo que fazer uma vez.
   *
   * Quem chama declara, e declara `false` na dúvida: repetir um envio, uma
   * cobrança ou um aviso que já pode ter chegado do outro lado faz a coisa duas
   * vezes, e daqui isso parece uma falha só.
   */
  readonly idempotent: boolean
  /**
   * Preço desta chamada, quando alguém sabe.
   *
   * Ausente significa custo DESCONHECIDO e nunca zero: a chamada é contada como
   * não precificada, e é isso que faz o estado do custo ser `PARTIAL` ou
   * `UNKNOWN` em vez de anunciar que não custou nada.
   */
  readonly priceUsd?: number | undefined
  /**
   * O projeto em nome de quem a chamada acontece, quando há um.
   *
   * Ele existe para o desligamento por PROJETO (X-07) poder valer. Ausente, só
   * o alcance da organização é conferido — o que é honesto: uma chamada que não
   * sabe de que projeto é não pode ser barrada por um botão de projeto.
   */
  readonly projectId?: string | undefined
}

/** O desfecho de uma chamada: o que aconteceu, quantas tentativas custou e o que se sabe do custo. */
export type IntegrationCallResult<T> =
  | { readonly state: 'OK'; readonly value: T; readonly attempts: number; readonly retried: boolean; readonly latencyMs: number; readonly cost: IntegrationCostState }
  | { readonly state: 'FAILED' | 'TIMEOUT'; readonly message: string; readonly attempts: number; readonly retried: boolean; readonly latencyMs: number; readonly cost: IntegrationCostState }

/**
 * O nome da operação como ele entra na auditoria: curto, sem espaço e sem
 * caractere de controle.
 *
 * Ele vem de quem chama, e uma linha de auditoria com quebra de linha dentro
 * deixa de ser uma linha — quem lê o histórico passa a ver duas, uma delas
 * escrita por quem fez a chamada.
 */
export function auditOperation(operation: string): string {
  const cleaned = operation.replace(/[^A-Za-z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  return cleaned === '' ? 'call' : cleaned
}

/** T2 and T3 are the tiers D16 makes the person confirm; T0/T1 are allowed and recorded. */
export function needsApproval(tier: PolicyTier): tier is 'T2' | 'T3' { return tier === 'T2' || tier === 'T3' }

/**
 * One spelling for a credential reference. `secret://DZ23_APP_SMTP`,
 * `DZ23_APP_SMTP` and the same with surrounding blanks are the same name; a
 * value that is not exactly one of those shapes is refused by the schema.
 */
export function canonicalSecretRef(input: unknown): unknown {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  // The case is NOT normalised: the vault name is what it is, and silently upper-casing it would invent a name nobody registered.
  return /^secret:\/\//iu.test(trimmed) ? trimmed.slice('secret://'.length) : trimmed
}

/**
 * The security-relevant state of one registry record, as a digest: its
 * identity, its kind, the tier it is enforced at, whether its signature checks
 * out, the manifest AND its signature, and which credential it points at. A
 * monotonic `updated_at` orders writes; THIS says whether what was confirmed is
 * still what is about to be enabled. Anything that changes here refuses an
 * `enable` that was confirmed before the change.
 */
export function securityFingerprint(record: Pick<StudioIntegration, 'integration_id' | 'kind' | 'effective_tier' | 'verification' | 'manifest' | 'secret_ref'>): string {
  return createHash('sha256').update(canonicalJsonBytes({
    integration_id: record.integration_id, kind: record.kind, effective_tier: record.effective_tier,
    verification: record.verification, manifest: record.manifest, secret_ref: record.secret_ref,
  })).digest('hex')
}

/** sha256 over parts that cannot run into each other (NUL is not allowed in any of them). */
function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')
}

/** The cursor is opaque on purpose: it is a position in one workspace's history, not an API. */
function encodeCursor(event: Pick<HubEvent, 'created_at' | 'event_id'>): string {
  return Buffer.from(`${event.created_at}\u0000${event.event_id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): Pick<HubEvent, 'created_at' | 'event_id'> {
  const [createdAt, eventId] = Buffer.from(cursor, 'base64url').toString('utf8').split('\u0000')
  if (createdAt === undefined || eventId === undefined || eventId === '' || Number.isNaN(Date.parse(createdAt))) {
    throw new HubError('INVALID', t('errors.invalidRequest'))
  }
  return { created_at: createdAt, event_id: eventId }
}

/** The audit proves WHICH reference was configured without naming it: same name → same short digest. */
export function minimizeSecretRef(ref: string): string {
  return `ref sha256:${createHash('sha256').update(ref, 'utf8').digest('hex').slice(0, 12)}`
}

/** Audit keeps proof, not the address: the domain (useful when diagnosing) and a short digest that matches a repeat test. */
export function minimizeRecipient(email: string): string {
  const canonical = email.trim()
  const domain = canonical.slice(canonical.lastIndexOf('@') + 1).toLowerCase()
  return `***@${domain} sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)}`
}

/** A single path segment, or nothing: no separators, no `..`, no control characters, no surprises from an id. */
export function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value === '.' || value === '..') {
    throw new HubError('INVALID', t('errors.internal'))
  }
  return value
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}
