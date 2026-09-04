import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { roleAllows, type PolicyTier, type StudioPermission, type StudioRole } from '@dz23-studio/policy'
import { z } from 'zod'
import { ExportError, openChildDirectory, openDirectory, packagePrototype, referenceOf } from './export.js'
import { t } from './i18n.js'
import { canonicalJsonBytes, evaluateManifest, policyFloor, type PublisherKeys } from './manifest.js'
import { secretRefSchema, type HubEvent, type StudioExport, type StudioIntegration } from './model.js'

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

export interface HubRepository {
  integrations(): readonly StudioIntegration[]
  putIntegration(value: StudioIntegration): Promise<void>
  /** Atomic within the repository writer: replace only the security state the caller read. */
  compareAndSwapIntegration(integrationId: string, expectedFingerprint: string, value: StudioIntegration): Promise<boolean>
  exports(): readonly StudioExport[]
  putExport(value: StudioExport): Promise<void>
  events(): readonly HubEvent[]
  putEvent(value: HubEvent): Promise<void>
  /** Retention: the oldest events of ONE workspace leave when it is over its ceiling. */
  deleteEvent(eventId: string): Promise<void>
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
 */
export const PACKAGING_SLOT_TIMEOUT_MS = 10 * 60 * 1000

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
  now?: () => Date
  createId?: () => string
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

type ExportOutcome =
  | { readonly ok: true; readonly value: StudioExport }
  | { readonly ok: false; readonly error: unknown }

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
  /**
   * One package per workspace and project at a time: a page that clicks ten
   * times, or ten tabs of the same person, join the SAME build instead of
   * starting ten of them on a single-threaded process.
   */
  readonly #exportsInFlight = new Map<string, Promise<ExportOutcome>>()
  /** Export attempts per workspace inside the window, so a flood costs the flooder and nobody else. */
  readonly #exportAttempts = new Map<string, number[]>()
  /**
   * How many events this process believes one workspace has stored. Retention used to read the
   * WHOLE table, filter it and sort it on every audited action — including the refusals an attacker
   * can ask for by the thousand — which made each audited action more expensive than the last. The
   * count is kept here, recomputed the first time a workspace is seen and after every sweep, so the
   * full pass happens when the ceiling is actually in play and not before.
   */
  readonly #eventCounts = new Map<string, number>()
  /**
   * Strictly increasing millisecond stamp. `Date.now()` repeats inside one
   * millisecond, and two writes that share a stamp cannot be ordered — the
   * concurrency check that compared `updated_at` could then keep the WRONG
   * version. Every record and every event this service writes gets a stamp
   * that is never equal to, nor earlier than, the previous one.
   */
  #lastStamp = 0

  constructor(private readonly options: HubServiceOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
  }

  #stamp(): string {
    const now = this.#now().getTime()
    this.#lastStamp = now > this.#lastStamp ? now : this.#lastStamp + 1
    return new Date(this.#lastStamp).toISOString()
  }

  /** The workspace an approval belongs to. Tickets are never looked up outside their own bucket. */
  #scope(actor: HubActor): string { return `${actor.orgId}\u0000${actor.tenantId}` }

  // ---- registry -------------------------------------------------------------

  list(actor: HubActor): readonly StudioIntegration[] {
    this.#authorize(actor, 'workspace.read')
    return this.options.repository.integrations().filter(value => this.#sameScope(actor, value))
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
    const existing = this.list(actor).find(value => value.manifest?.id === evaluation.manifest!.id && value.kind === evaluation.manifest!.kind)
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
    const tier = this.#tierForAction(actor, action, subject)
    const ticket: HubApprovalTicket = {
      approval_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      tier, action, subject_id: subject, fingerprint: this.#fingerprint(actor, action, subject, payload),
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
  #fingerprint(actor: HubActor, action: HubEvent['action'], subjectId: string, payload: string | undefined): string {
    if (action === 'integration.enabled') return securityFingerprint(this.#integration(actor, subjectId))
    if (action === 'smtp.configured' || action === 'smtp.tested') {
      // A decision with no target is a decision about nothing: refuse to issue it.
      if (payload === undefined || payload.trim() === '') throw new HubError('INVALID', t('errors.invalidRequest'))
      const target = action === 'smtp.configured' ? String(canonicalSecretRef(payload)) : payload.trim()
      const record = this.#smtpRecord(actor)
      return digest([action, target, record === undefined ? '-' : securityFingerprint(record)])
    }
    throw new HubError('INVALID', t('errors.invalidRequest'))
  }

  /** The tier an action would need right now, decided by the server for the request above. */
  #tierForAction(actor: HubActor, action: HubEvent['action'], subjectId: string): PolicyTier {
    if (action === 'integration.enabled') return this.#enforcedTier(this.#integration(actor, subjectId))
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
    const current = this.#integration(actor, integrationId)
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
    const latest = this.#integration(actor, integrationId)
    if (securityFingerprint(latest) !== securityFingerprint(current)) {
      await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'failure', 'changed-during-approval')
      throw new HubError('CONFLICT', t('errors.integrationChanged'))
    }
    const updated = { ...latest, enabled, updated_at: this.#stamp() }
    if (!await this.options.repository.compareAndSwapIntegration(integrationId, securityFingerprint(latest), updated)) {
      await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'failure', 'changed-during-write')
      throw new HubError('CONFLICT', t('errors.integrationChanged'))
    }
    await this.#recordApproval(actor, confirmed, 'integration.enabled', integrationId)
    await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'success', updated.effective_tier)
    return updated
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

  // ---- smtp for generated apps ---------------------------------------------

  smtp(actor: HubActor): { configured: boolean; secret_ref: string | null; tier: PolicyTier } {
    this.#authorize(actor, 'workspace.read')
    const record = this.#smtpRecord(actor)
    const configured = record !== undefined && record.enabled && record.secret_ref !== null
    return { configured, secret_ref: configured ? record.secret_ref : null, tier: SMTP_TIER }
  }

  async configureSmtp(actor: HubActor, secretRefInput: unknown, approval?: HubApproval): Promise<StudioIntegration> {
    this.#authorize(actor, 'integrations.manage')
    const parsed = secretRefSchema.safeParse(canonicalSecretRef(secretRefInput))
    if (!parsed.success) throw new HubError('INVALID', t('errors.secretRefInvalid'))
    // The confirmation has to have been given for THIS alias: the fingerprint of the reference is
    // what separates a decision about `DZ23_APP_SMTP` from one about somebody else's credential.
    const confirmed = await this.#requireTier(actor, SMTP_TIER, approval, 'smtp.configured', SMTP_SUBJECT, this.#fingerprint(actor, 'smtp.configured', SMTP_SUBJECT, parsed.data))
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
    const existing = this.#smtpRecord(actor)
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
    const record = this.#smtpRecord(actor)
    if (record === undefined || record.secret_ref === null || !record.enabled) throw new HubError('NOT_FOUND', t('errors.smtpNotConfigured'))
    // The address is checked BEFORE the confirmation is spent: a typo must not cost the person their
    // confirmation, and the ticket is bound to this exact recipient anyway.
    const recipient = z.string().trim().email().safeParse(to)
    if (!recipient.success) {
      await this.#audit(actor, 'smtp.tested', record.integration_id, 'failure', 'invalid-recipient')
      throw new HubError('INVALID', t('errors.invalidRequest'))
    }
    // Bound to the address the person confirmed: a ticket taken for one recipient cannot send to another.
    const confirmed = await this.#requireTier(actor, this.#enforcedTier(record), approval, 'smtp.tested', SMTP_SUBJECT, this.#fingerprint(actor, 'smtp.tested', SMTP_SUBJECT, recipient.data))
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

  listExports(actor: HubActor, projectId: string): readonly StudioExport[] {
    this.#authorize(actor, 'project.read')
    this.options.projects.project(actor, projectId)
    return this.options.repository.exports().filter(value => value.project_id === projectId && this.#sameScope(actor, value))
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
    let task = this.#exportsInFlight.get(key)
    if (task === undefined) {
      // Registered SYNCHRONOUSLY, before the first await: ten clicks arriving in the same tick must
      // find the build already in flight, not each other's absence.  The shared promise always
      // resolves to a tagged outcome; no fast refusal can briefly become an unhandled rejection.
      task = this.#guardedExport(actor, projectId).then<ExportOutcome>(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      )
      this.#exportsInFlight.set(key, task)
      void task.then(() => { if (this.#exportsInFlight.get(key) === task) this.#exportsInFlight.delete(key) })
    }
    const outcome = await task
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  async #guardedExport(actor: HubActor, projectId: string): Promise<StudioExport> {
    await this.#throttleExport(actor, projectId)
    // One build per workspace is not enough on its own: two DIFFERENT workspaces packaging at the
    // same time each walk a whole run and hash it, on the one thread this Studio has. Past this
    // ceiling the caller waits its turn instead of making everybody's Studio slow at once.
    try {
      return await this.#withPackagingSlot(signal => this.#createExport(actor, projectId, signal))
    } catch (error) {
      // A refusal nobody can see is not a refusal: the person is told the Studio stopped waiting,
      // and the history says so too, with the project it happened on.
      if (error instanceof HubError && error.code === 'TIMEOUT') await this.#audit(actor, 'export.created', projectId, 'failure', 'packaging-timeout')
      throw error
    }
  }

  async #withPackagingSlot<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
    const controller = new AbortController()
    const timeout = new HubError('TIMEOUT', t('errors.exportTimedOut'))
    const timer = setTimeout(() => controller.abort(timeout), this.options.packagingTimeoutMs ?? PACKAGING_SLOT_TIMEOUT_MS)
    timer.unref?.()
    // Convert both contenders to values before racing them.  A fast fail-closed
    // refusal can otherwise reject in the short interval between construction
    // and the async HTTP boundary attaching its observer, which Node correctly
    // reports as PromiseRejectionHandledWarning even though the response is
    // eventually mapped to 409/413.
    const task = work(controller.signal).then(
      value => ({ kind: 'value' as const, value }),
      error => ({ kind: 'error' as const, error }),
    )
    const releaseSlot = () => {
      clearTimeout(timer)
      this.#packaging -= 1
      this.#packagingQueue.shift()?.release()
    }
    // This observer owns the slot lifecycle; the caller may receive TIMEOUT first, but capacity
    // is not returned until the abandoned operation really stops.
    void task.then(releaseSlot)
    const aborted = new Promise<{ kind: 'error'; error: unknown }>(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ kind: 'error', error: timeout }), { once: true })
    })
    const outcome = await Promise.race([task, aborted])
    if (outcome.kind === 'error') throw outcome.error
    return outcome.value
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

  async #createExport(actor: HubActor, projectId: string, signal: AbortSignal): Promise<StudioExport> {
    const project = this.options.projects.project(actor, projectId)
    const refuse = async (detail: string, error: HubError): Promise<never> => {
      await this.#audit(actor, 'export.created', projectId, 'failure', detail)
      throw error
    }
    if (project.state !== 'VERIFIED_PROTOTYPE') return refuse(`state ${project.state}`, new HubError('INVALID', t('errors.exportNotVerified')))
    const run = [...this.options.projects.runs(actor, projectId)].filter(value => value.state === 'PASSED')
      .sort((left, right) => (right.started_at < left.started_at ? -1 : right.started_at > left.started_at ? 1 : 0) || right.attempt - left.attempt)[0]
    if (run === undefined) return refuse('no PASSED run', new HubError('INVALID', t('errors.exportNotVerified')))
    // The run directory arrives as data from another plugin: it is confined to the runs root by real path before anything is read.
    let confinedRun: { handle: FileHandle; path: string }
    try {
      confinedRun = await this.#openConfinedRunDirectory(run.run_directory)
    } catch (error) {
      return refuse(error instanceof HubError ? `run-directory ${error.code}` : 'run-directory', error instanceof HubError ? error : new HubError('INVALID', t('errors.exportRunMissing')))
    }
    let built
    try {
      built = await packagePrototype({ runDirectory: confinedRun.path, runHandle: confinedRun.handle, projectName: project.name, runId: run.run_id, signal })
    } catch (error) {
      // The class of refusal survives to the boundary: a package refused because it carries a secret
      // is not the same answer as a malformed request, and the documents promised those statuses.
      // The DETAIL travels with the code: three different refusals used to reach the history as a
      // bare `TOO_LARGE`, and a package refused for carrying a secret named the file on the screen
      // and nowhere in the row. The detail is a path or a reason, never the matched text.
      if (error instanceof ExportError) return refuse(`${error.code} ${error.detail}`, new HubError(exportErrorCode(error.code), error.code === 'INVALID_PATH' ? t('errors.internal') : error.message))
      // Anything else (an unreadable folder, a name the filesystem returns as invalid UTF-8) used to
      // leave through the front door as a 500 with no audit at all — the person saw "something went
      // wrong" and the history said nothing had been attempted.
      return refuse(`package-failed ${error instanceof Error ? error.name : 'Error'}`, new HubError('INVALID', t('errors.exportFailed')))
    } finally {
      await confinedRun.handle.close().catch(() => undefined)
    }
    // Same run, same bytes: hand back the existing package instead of writing a twin file on every click.
    const existing = this.listExports(actor, projectId).find(value => value.run_id === run.run_id && value.sha256 === built.sha256)
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
    const record: StudioExport = {
      export_id: exportId, org_id: actor.orgId, tenant_id: actor.tenantId, project_id: projectId, run_id: run.run_id,
      file_name: built.fileName, path, sha256: built.sha256, size_bytes: built.archive.length, entries: built.entries,
      created_by: actor.userId, created_at: this.#stamp(),
    }
    await this.options.repository.putExport(record)
    await this.#audit(actor, 'export.created', exportId, 'success', `${built.fileName} ${built.sha256}`)
    return record
  }

  exportRecord(actor: HubActor, projectId: string, exportId: string): StudioExport {
    const record = this.listExports(actor, projectId).find(value => value.export_id === exportId)
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
    const record = this.exportRecord(actor, projectId, exportId)
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
  events(actor: HubActor, page: { readonly limit?: number | undefined; readonly cursor?: string | undefined } = {}): { events: readonly HubEvent[]; next_cursor: string | null } {
    this.#authorize(actor, 'audit.read')
    const limit = Math.min(Math.max(Math.trunc(page.limit ?? EVENTS_PAGE_SIZE), 1), EVENTS_PAGE_MAX)
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor)
    const ordered = this.options.repository.events().filter(value => this.#sameScope(actor, value)).sort(newestFirst)
    const start = after === undefined ? 0 : ordered.findIndex(value => newestFirst(value, after) > 0)
    const window = start < 0 ? [] : ordered.slice(start, start + limit)
    const last = window.at(-1)
    // A cursor only exists while there is something after it: the client stops without a second empty round trip.
    const more = last !== undefined && (start < 0 ? false : ordered.length > start + window.length)
    return { events: window, next_cursor: more ? encodeCursor(last) : null }
  }

  // ---- internals -----------------------------------------------------------

  #smtpRecord(actor: HubActor): StudioIntegration | undefined {
    return this.options.repository.integrations().find(value => value.kind === 'smtp' && value.manifest === null && this.#sameScope(actor, value))
  }

  #integration(actor: HubActor, integrationId: string): StudioIntegration {
    const value = this.options.repository.integrations().find(candidate => candidate.integration_id === integrationId && this.#sameScope(actor, candidate))
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

  #sameScope(actor: HubActor, value: { readonly org_id: string; readonly tenant_id: string }): boolean {
    return value.org_id === actor.orgId && value.tenant_id === actor.tenantId
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
    const key = this.#scope(actor)
    const known = this.#eventCounts.get(key)
    // Unknown workspace: count once, from the table. Known: one more than last time — the write
    // that got us here. Either way the expensive pass below runs only when the ceiling is reached.
    const count = known === undefined ? this.options.repository.events().filter(value => this.#sameScope(actor, value)).length : known + 1
    this.#eventCounts.set(key, count)
    // The map is keyed by a workspace that had to authenticate, and a dropped entry only costs one
    // recount; it is bounded like every other per-workspace map in this service.
    if (this.#eventCounts.size > MAX_APPROVAL_SCOPES) {
      for (const scope of this.#eventCounts.keys()) {
        if (this.#eventCounts.size <= MAX_APPROVAL_SCOPES) break
        if (scope !== key) this.#eventCounts.delete(scope)
      }
    }
    if (count <= EVENTS_RETAINED_PER_TENANT) return
    const mine = this.options.repository.events().filter(value => this.#sameScope(actor, value))
    const oldest = [...mine].sort(newestFirst).slice(EVENTS_RETAINED_PER_TENANT)
    for (const event of oldest) await this.options.repository.deleteEvent(event.event_id)
    this.#eventCounts.set(key, Math.min(mine.length, EVENTS_RETAINED_PER_TENANT))
  }
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

/** Newest first, with the id as tie-break so a page boundary is a total order and never repeats a row. */
function newestFirst(left: Pick<HubEvent, 'created_at' | 'event_id'>, right: Pick<HubEvent, 'created_at' | 'event_id'>): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.event_id < right.event_id ? 1 : left.event_id > right.event_id ? -1 : 0
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
