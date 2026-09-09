import { randomUUID } from 'node:crypto'
import { newMagicCode, newOpaqueSecret, secretHash, secretMatches } from './crypto.js'
import type { EmailSender, InvitationMessage } from './email.js'
import type {
  AuthenticationOptions,
  AuthenticationResponse,
  PasskeyProvider,
  RegistrationOptions,
  RegistrationResponse,
} from './passkey.js'
import type {
  ChallengeRecord,
  IdentityAuditRecord,
  IdentityUser,
  MagicCodeRecord,
  PasskeyCredential,
  SessionRecord,
} from './model.js'
import { KeyedMutex } from './mutex.js'
import { t } from './i18n.js'

const MINUTE = 60_000
/**
 * A device session indexes the Assistant conversations opened from it. The list
 * is bounded so an authenticated caller cannot grow one session record without
 * limit. Reaching the ceiling refuses the new binding with an explained error;
 * nothing is dropped to make room, because dropping a live pointer would cost
 * the person a conversation they can still use. Pointers leave the list only
 * through `releaseHarnessSession`, which the launcher calls after the Harness
 * proved the conversation no longer exists.
 */
const MAX_HARNESS_SESSION_BINDINGS = 8
const DAY = 24 * 60 * MINUTE
const CHALLENGE_TTL = 5 * MINUTE
const MAGIC_TTL = 10 * MINUTE
const SLIDING_TTL = 14 * DAY
const ABSOLUTE_TTL = 90 * DAY
const STRONG_AUTH_TTL = 5 * MINUTE
const MAX_MAGIC_ATTEMPTS = 5
const SESSION_TOUCH_INTERVAL = MINUTE

function derivedCsrfToken(tokenHash: string): string { return secretHash(`dz23-csrf-v1:${tokenHash}`) }

export type EnrollmentMode = 'closed' | 'open' | {
  readonly mode: 'bootstrap-email'
  readonly email: string
}
export type MagicCodeRequestResult = 'sent' | 'suppressed'

export interface EnrollmentGrant {
  readonly orgId: string
  readonly tenantId: string
  readonly role: InvitationMessage['role']
}

export type IdentityUserProvisioningSource = 'bootstrap' | 'invitation'

export interface IdentityRepository {
  users(): readonly IdentityUser[]
  putUser(record: IdentityUser): Promise<void>
  credentials(): readonly PasskeyCredential[]
  putCredential(record: PasskeyCredential): Promise<void>
  challenges(): readonly ChallengeRecord[]
  putChallenge(record: ChallengeRecord): Promise<void>
  magicCodes(): readonly MagicCodeRecord[]
  putMagicCode(record: MagicCodeRecord): Promise<void>
  sessions(): readonly SessionRecord[]
  putSession(record: SessionRecord): Promise<void>
  audits(): readonly IdentityAuditRecord[]
  putAudit(record: IdentityAuditRecord): Promise<void>
}

export interface DeviceInput {
  readonly label: string
  readonly userAgent: string
  readonly ipTruncated: string
}

export interface IssuedSession {
  readonly token: string
  readonly csrfToken: string
  readonly session: SessionRecord
}

export interface IdentityPrincipal {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly sessionId: string
}

export interface IdentityExecutionState {
  readonly authenticated: boolean
  readonly strongIdentityVerified: boolean
}

export interface PasskeyCeremony<TOptions> {
  readonly challengeId: string
  readonly options: TOptions
}

export class IdentityError extends Error {
  constructor(
    readonly code: 'invalid' | 'expired' | 'revoked' | 'locked' | 'not-found' | 'csrf' | 'replay' | 'counter',
    message: string,
  ) {
    super(message)
  }
}

export interface IdentityServiceOptions {
  readonly repository: IdentityRepository
  readonly passkeys: PasskeyProvider
  readonly emailSender: EmailSender
  readonly rpName: string
  readonly rpId: string
  readonly expectedOrigin: string
  readonly defaultOrgId: string
  readonly defaultTenantId: string
  readonly enrollment: EnrollmentMode
  readonly personalModeAllowed?: boolean
  readonly now?: () => Date
  readonly createId?: () => string
  readonly createSecret?: () => string
  readonly createMagicCode?: () => string
}

export class StudioIdentityService {
  readonly #repository: IdentityRepository
  readonly #passkeys: PasskeyProvider
  readonly #emailSender: EmailSender
  readonly #rpName: string
  readonly #rpId: string
  readonly #expectedOrigin: string
  readonly #defaultOrgId: string
  readonly #defaultTenantId: string
  readonly #enrollment: EnrollmentMode
  readonly #personalModeAllowed: boolean
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #createSecret: () => string
  readonly #createMagicCode: () => string
  readonly #mutex = new KeyedMutex()
  #enrollmentResolver: (email: string) => EnrollmentGrant | undefined = () => undefined
  #userProvisioner: (user: IdentityUser, source: IdentityUserProvisioningSource) => Promise<void> = () => Promise.resolve()

  constructor(options: IdentityServiceOptions) {
    this.#repository = options.repository
    this.#passkeys = options.passkeys
    this.#emailSender = options.emailSender
    this.#rpName = options.rpName
    this.#rpId = options.rpId
    this.#expectedOrigin = options.expectedOrigin
    this.#defaultOrgId = options.defaultOrgId
    this.#defaultTenantId = options.defaultTenantId
    this.#enrollment = typeof options.enrollment === 'string'
      ? options.enrollment
      : { mode: 'bootstrap-email', email: normalizeEmail(options.enrollment.email) }
    this.#personalModeAllowed = options.personalModeAllowed ?? true
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#createSecret = options.createSecret ?? newOpaqueSecret
    this.#createMagicCode = options.createMagicCode ?? newMagicCode
  }

  isPersonalMode(bindHost: '127.0.0.1' | '0.0.0.0'): boolean {
    return this.#personalModeAllowed && bindHost === '127.0.0.1' && this.#repository.users().length === 0
  }

  personalPrincipal(bindHost: '127.0.0.1' | '0.0.0.0'): IdentityPrincipal | undefined {
    if (!this.isPersonalMode(bindHost)) return undefined
    return { userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', sessionId: 'session_local' }
  }

  /**
   * The upstream Harness browser cookie authenticates one process, not one
   * Studio identity. Expose that client only for a local installation with a
   * single registered person; team/server installations need a tenant-aware
   * transport instead of this process-wide cookie.
   */
  isSharedHarnessClientAllowed(session: SessionRecord): boolean {
    if (!this.#personalModeAllowed) return false
    const users = this.#repository.users()
    return users.length === 1 && users[0]?.user_id === session.user_id
  }

  isEnrollmentOpen(email?: string): boolean {
    if (this.#repository.users().length !== 0) return false
    if (this.#enrollment === 'open') return true
    return typeof this.#enrollment !== 'string'
      && email !== undefined
      && this.#enrollment.email === normalizeEmail(email)
  }

  setEnrollmentResolver(resolver: (email: string) => EnrollmentGrant | undefined): () => void {
    const previous = this.#enrollmentResolver
    this.#enrollmentResolver = resolver
    return () => { this.#enrollmentResolver = previous }
  }

  setUserProvisioner(provisioner: (user: IdentityUser, source: IdentityUserProvisioningSource) => Promise<void>): () => void {
    const previous = this.#userProvisioner
    this.#userProvisioner = provisioner
    return () => { this.#userProvisioner = previous }
  }

  userRecords(): readonly IdentityUser[] {
    return this.#repository.users()
  }

  sendInvitation(message: InvitationMessage): Promise<void> {
    return this.#emailSender.sendInvitation(message)
  }

  async requestMagicCode(email: string): Promise<MagicCodeRequestResult> {
    const normalized = normalizeEmail(email)
    return this.#mutex.run(`magic-request:${normalized}`, async () => {
      const existing = this.#repository.users().find(user => user.email === normalized)
      const grant = this.#enrollmentResolver(normalized)
      if (existing === undefined && !this.isEnrollmentOpen(normalized) && grant === undefined) {
        await this.#audit(
          'magic_code_suppressed', null, null, this.#defaultOrgId, this.#defaultTenantId,
          'failure', t('auth.genericRequestRefused'),
        )
        return 'suppressed'
      }
      const code = this.#createMagicCode()
      if (!/^\d{6}$/.test(code)) throw new IdentityError('invalid', t('auth.invalidGeneratedCode'))
      const now = this.#now()
      await Promise.all(this.#repository.magicCodes()
        .filter(previous => previous.email === normalized && previous.consumed_at === null)
        .map(previous => this.#repository.putMagicCode({ ...previous, consumed_at: now.toISOString() })))
      const orgId = existing?.org_id ?? grant?.orgId ?? this.#defaultOrgId
      const tenantId = existing?.tenant_id ?? grant?.tenantId ?? this.#defaultTenantId
      const record: MagicCodeRecord = {
        magic_code_id: this.#createId(),
        email: normalized,
        code_hash: secretHash(code),
        org_id: orgId,
        tenant_id: tenantId,
        attempts: 0,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + MAGIC_TTL).toISOString(),
        consumed_at: null,
      }
      await this.#repository.putMagicCode(record)
      await this.#emailSender.sendMagicCode({ to: normalized, code, expiresInMinutes: 10 })
      await this.#audit('magic_code_requested', existing?.user_id ?? null, null, orgId, tenantId, 'success', t('auth.codeRequested'))
      return 'sent'
    })
  }

  async verifyMagicCode(email: string, code: string, device: DeviceInput): Promise<IssuedSession> {
    const normalized = normalizeEmail(email)
    return this.#mutex.run('magic-verify', async () => this.#verifyMagicCodeLocked(normalized, code, device))
  }

  async #verifyMagicCodeLocked(normalized: string, code: string, device: DeviceInput): Promise<IssuedSession> {
    const candidate = this.#repository.magicCodes()
      .filter(record => record.email === normalized && record.consumed_at === null)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))[0]
    if (candidate === undefined) {
      await this.#audit('login_failed', null, null, 'org_unknown', 'tenant_unknown', 'failure', t('auth.codeMissing'))
      throw new IdentityError('not-found', t('auth.codeInvalidOrExpired'))
    }
    const now = this.#now()
    if (Date.parse(candidate.expires_at) <= now.getTime()) {
      await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', t('auth.codeExpired'))
      throw new IdentityError('expired', t('auth.codeInvalidOrExpired'))
    }
    if (candidate.attempts >= MAX_MAGIC_ATTEMPTS) {
      throw new IdentityError('locked', t('auth.tooManyAttempts'))
    }
    if (!secretMatches(code, candidate.code_hash)) {
      const attempts = candidate.attempts + 1
      await this.#repository.putMagicCode({ ...candidate, attempts })
      await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', t('auth.codeIncorrect'))
      throw new IdentityError(attempts >= MAX_MAGIC_ATTEMPTS ? 'locked' : 'invalid', t('auth.codeInvalidOrExpired'))
    }
    await this.#repository.putMagicCode({ ...candidate, consumed_at: now.toISOString() })
    const existing = this.#repository.users().find(user => user.email === normalized)
    const grant = this.#enrollmentResolver(normalized)
    const validGrant = grant !== undefined && grant.orgId === candidate.org_id && grant.tenantId === candidate.tenant_id
    if (existing === undefined && !this.isEnrollmentOpen(normalized) && !validGrant) {
      await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', t('auth.bootstrapClosed'))
      throw new IdentityError('invalid', t('auth.codeInvalidOrExpired'))
    }
    const source: IdentityUserProvisioningSource = validGrant ? 'invitation' : 'bootstrap'
    const user: IdentityUser = existing ?? {
      user_id: this.#createId(),
      email: normalized,
      display_name: normalized.split('@')[0]!,
      bootstrap_owner: source === 'bootstrap',
      org_id: candidate.org_id,
      tenant_id: candidate.tenant_id,
      created_at: now.toISOString(),
    }
    if (existing === undefined) {
      await this.#repository.putUser(user)
      await this.#userProvisioner(user, source)
      if (source === 'bootstrap') {
        await this.#audit('personal_mode_disabled', user.user_id, null, user.org_id, user.tenant_id, 'success', 'Primeiro acesso cadastrado.')
        await this.#audit('enrollment_closed', user.user_id, null, user.org_id, user.tenant_id, 'success', t('auth.bootstrapClosedAfterOwner'))
      }
    }
    const issued = await this.#issueSession(user, device)
    await this.#audit('login_succeeded', user.user_id, issued.session.session_id, user.org_id, user.tenant_id, 'success', t('auth.signedInWithCode'))
    return issued
  }

  async authenticate(token: string, touch = true): Promise<SessionRecord> {
    const located = this.#findSessionByToken(token)
    return this.#mutex.run(`session:${located.session_id}`, async () => {
      const session = this.#findSessionByToken(token)
      const now = this.#now()
      this.#assertSessionUsable(session, now)
      if (!touch) return session
      if (now.getTime() - Date.parse(session.last_seen_at) < SESSION_TOUCH_INTERVAL) return session
      const sliding = Math.min(now.getTime() + SLIDING_TTL, Date.parse(session.expires_absolute_at))
      const updated = {
        ...session,
        last_seen_at: now.toISOString(),
        expires_sliding_at: new Date(sliding).toISOString(),
      }
      await this.#repository.putSession(updated)
      return updated
    })
  }

  validateCsrf(session: SessionRecord, cookieToken: string | undefined, headerToken: string | undefined): void {
    if (cookieToken === undefined || headerToken === undefined
      || cookieToken !== headerToken || !secretMatches(headerToken, session.csrf_hash)) {
      throw new IdentityError('csrf', t('auth.invalidConfirmation'))
    }
  }

  validateCsrfToken(session: SessionRecord, headerToken: string | undefined): void {
    if (headerToken === undefined || !secretMatches(headerToken, session.csrf_hash)) {
      throw new IdentityError('csrf', t('auth.invalidConfirmation'))
    }
  }

  async csrfTokenFor(session: SessionRecord): Promise<string> {
    return this.#mutex.run(`session:${session.session_id}`, async () => {
      const current = this.#repository.sessions().find(candidate => candidate.session_id === session.session_id)
      if (current === undefined) throw new IdentityError('invalid', t('auth.invalidSession'))
      this.#assertSessionUsable(current, this.#now())
      const csrfToken = derivedCsrfToken(current.token_hash)
      const csrfHash = secretHash(csrfToken)
      if (current.csrf_hash !== csrfHash) await this.#repository.putSession({ ...current, csrf_hash: csrfHash })
      return csrfToken
    })
  }

  listDevices(userId: string): readonly Omit<SessionRecord, 'token_hash' | 'csrf_hash'>[] {
    return this.#repository.sessions()
      .filter(session => session.user_id === userId)
      .map(({ token_hash: _tokenHash, csrf_hash: _csrfHash, ...safe }) => safe)
  }

  async revokeSession(actor: SessionRecord, sessionId: string, reason = t('auth.revokedByUser')): Promise<void> {
    await this.#mutex.run(`session:${sessionId}`, async () => {
      const target = this.#repository.sessions().find(session => session.session_id === sessionId && session.user_id === actor.user_id)
      if (target === undefined) throw new IdentityError('not-found', t('auth.deviceNotFound'))
      if (target.revoked_at !== null) return
      const revoked = { ...target, revoked_at: this.#now().toISOString(), revoked_reason: reason }
      await this.#repository.putSession(revoked)
      await this.#audit('session_revoked', actor.user_id, target.session_id, actor.org_id, actor.tenant_id, 'success', reason)
    })
  }

  async revokeAllSessions(actor: SessionRecord): Promise<void> {
    const activeIds = this.#repository.sessions()
      .filter(session => session.user_id === actor.user_id && session.revoked_at === null)
      .map(session => session.session_id)
    const now = this.#now().toISOString()
    await Promise.all(activeIds.map(sessionId => this.#mutex.run(`session:${sessionId}`, async () => {
      const current = this.#repository.sessions().find(session => session.session_id === sessionId && session.user_id === actor.user_id)
      if (current === undefined || current.revoked_at !== null) return
      await this.#repository.putSession({
        ...current,
        revoked_at: now,
        revoked_reason: t('auth.signedOutAllDevices'),
      })
    })))
    await this.#audit('all_sessions_revoked', actor.user_id, actor.session_id, actor.org_id, actor.tenant_id, 'success', t('auth.allSessionsRevoked'))
  }

  async bindHarnessSession(session: SessionRecord, harnessSessionId: string): Promise<void> {
    if (harnessSessionId.trim() === '') throw new IdentityError('invalid', t('auth.invalidAgentSession'))
    await this.#mutex.run('harness-session-bindings', () => this.#mutex.run(`session:${session.session_id}`, async () => {
      const sessions = this.#repository.sessions()
      const current = sessions.find(candidate => candidate.session_id === session.session_id)
      if (current === undefined) throw new IdentityError('invalid', t('auth.invalidSession'))
      this.#assertSessionUsable(current, this.#now())
      const existing = sessions.filter(candidate => candidate.harness_session_ids.includes(harnessSessionId))
      if (existing.some(candidate => candidate.session_id !== current.session_id)) {
        await this.#audit(
          'harness_session_bound', current.user_id, current.session_id,
          current.org_id, current.tenant_id, 'failure',
          t('assistant.bindingConflictAudit'),
        )
        throw new IdentityError('replay', t('assistant.bindingConflict'))
      }
      if (current.harness_session_ids.includes(harnessSessionId)) return
      if (current.harness_session_ids.length >= MAX_HARNESS_SESSION_BINDINGS) {
        await this.#audit(
          'harness_session_bound', current.user_id, current.session_id,
          current.org_id, current.tenant_id, 'failure', t('assistant.bindingQuotaAudit'),
        )
        throw new IdentityError('invalid', t('assistant.bindingQuota'))
      }
      await this.#repository.putSession({
        ...current,
        harness_session_ids: [...current.harness_session_ids, harnessSessionId],
      })
      await this.#audit('harness_session_bound', current.user_id, current.session_id, current.org_id, current.tenant_id, 'success', t('auth.agentSessionBound'))
    }))
  }

  /**
   * Drops one conversation pointer from a device session. Only the launcher
   * calls this, and only after the Harness itself proved the conversation is
   * gone or is not an Assistant conversation. The audit row is written before
   * the session is rewritten, so a pointer never disappears unrecorded.
   */
  async releaseHarnessSession(session: SessionRecord, harnessSessionId: string, reason: string): Promise<void> {
    if (harnessSessionId.trim() === '') throw new IdentityError('invalid', t('auth.invalidAgentSession'))
    await this.#mutex.run('harness-session-bindings', () => this.#mutex.run(`session:${session.session_id}`, async () => {
      const current = this.#repository.sessions().find(candidate => candidate.session_id === session.session_id)
      if (current === undefined) throw new IdentityError('invalid', t('auth.invalidSession'))
      if (!current.harness_session_ids.includes(harnessSessionId)) return
      await this.#audit(
        'harness_session_unbound', current.user_id, current.session_id,
        current.org_id, current.tenant_id, 'success',
        `${t('assistant.bindingReleasedAudit')} (${harnessSessionId}) ${reason}`.trim(),
      )
      await this.#repository.putSession({
        ...current,
        harness_session_ids: current.harness_session_ids.filter(candidate => candidate !== harnessSessionId),
      })
    }))
  }

  ownsHarnessSession(session: SessionRecord, harnessSessionId: string): boolean {
    if (harnessSessionId.trim() === '') return false
    const bindings = this.#repository.sessions().filter(candidate => candidate.harness_session_ids.includes(harnessSessionId))
    if (bindings.length !== 1 || bindings[0]?.session_id !== session.session_id) return false
    try {
      this.#assertSessionUsable(bindings[0], this.#now())
      return bindings[0].user_id === session.user_id
        && bindings[0].org_id === session.org_id
        && bindings[0].tenant_id === session.tenant_id
    } catch {
      return false
    }
  }

  #usableHarnessSessionBinding(harnessSessionId: string): SessionRecord | undefined {
    const bindings = this.#repository.sessions().filter(session => session.harness_session_ids.includes(harnessSessionId))
    if (bindings.length !== 1) return undefined
    const session = bindings[0]!
    try {
      this.#assertSessionUsable(session, this.#now())
      return session
    } catch {
      return undefined
    }
  }

  strongIdentityForHarnessSession(harnessSessionId: string): boolean {
    const session = this.#usableHarnessSessionBinding(harnessSessionId)
    return session !== undefined && this.#strongAuthFresh(session)
  }

  /**
   * Identidade forte de uma sessão de identidade, pelo seu próprio
   * `session_id`. É o que a autoridade de confirmação de ações usa: ela conhece
   * a sessão do principal, não a sessão do Harness. Sessão inexistente,
   * revogada ou vencida não é identidade forte.
   * @param sessionId - identificador durável da sessão de identidade.
   * @returns verdadeiro só com chave de acesso recente naquela mesma sessão.
   */
  strongIdentityForSession(sessionId: string): boolean {
    const session = this.#repository.sessions().find(candidate => candidate.session_id === sessionId)
    if (session === undefined) return false
    try {
      this.#assertSessionUsable(session, this.#now())
    } catch {
      return false
    }
    return this.#strongAuthFresh(session)
  }

  /**
   * Chave de acesso recente nesta sessão, dentro da janela de identidade forte.
   * @param session - o registro de sessão já verificado como utilizável.
   * @returns verdadeiro enquanto a autenticação forte ainda vale.
   */
  #strongAuthFresh(session: SessionRecord): boolean {
    return session.last_strong_auth_method === 'passkey'
      && session.last_strong_auth_at !== null
      && this.#now().getTime() - Date.parse(session.last_strong_auth_at) < STRONG_AUTH_TTL
  }

  identityStateForHarnessSession(
    harnessSessionId: string,
    bindHost: '127.0.0.1' | '0.0.0.0',
  ): IdentityExecutionState {
    if (this.isPersonalMode(bindHost)) return { authenticated: true, strongIdentityVerified: false }
    const authenticated = this.#usableHarnessSessionBinding(harnessSessionId) !== undefined
    return {
      authenticated,
      strongIdentityVerified: authenticated && this.strongIdentityForHarnessSession(harnessSessionId),
    }
  }

  async beginPasskeyRegistration(token: string): Promise<PasskeyCeremony<RegistrationOptions>> {
    const session = await this.authenticate(token)
    const user = this.#user(session.user_id)
    const existing = this.#repository.credentials().filter(credential => credential.user_id === user.user_id)
    const options = await this.#passkeys.registrationOptions({
      rpName: this.#rpName,
      rpId: this.#rpId,
      userId: user.user_id,
      userName: user.email,
      excludeCredentialIds: existing.map(credential => credential.credential_id),
    })
    const challengeId = await this.#storeChallenge('registration', user.user_id, session.session_id, options.challenge)
    return { challengeId, options }
  }

  async finishPasskeyRegistration(token: string, challengeId: string, response: RegistrationResponse, deviceLabel: string): Promise<void> {
    const session = await this.authenticate(token)
    await this.#withChallenge(challengeId, 'registration', session.user_id, session.session_id, async challenge => {
      const verified = await this.#passkeys.verifyRegistration({
        response,
        challengeMatches: value => secretMatches(value, challenge.challenge_hash),
        expectedOrigin: this.#expectedOrigin,
        expectedRpId: this.#rpId,
      })
      if (this.#repository.credentials().some(credential => credential.credential_id === verified.id)) {
        throw new IdentityError('replay', t('auth.passkeyAlreadyRegistered'))
      }
      await this.#repository.putCredential({
        credential_id: verified.id,
        user_id: session.user_id,
        public_key: Buffer.from(verified.publicKey).toString('base64url'),
        counter: verified.counter,
        transports: verified.transports,
        device_label: deviceLabel,
        created_at: this.#now().toISOString(),
        last_used_at: null,
      })
    })
    await this.#audit('passkey_registered', session.user_id, session.session_id, session.org_id, session.tenant_id, 'success', 'Chave de acesso cadastrada.')
  }

  async beginPasskeyLogin(email: string): Promise<PasskeyCeremony<AuthenticationOptions>> {
    const user = this.#repository.users().find(candidate => candidate.email === normalizeEmail(email))
    const userId = user?.user_id ?? `unknown-${this.#createId()}`
    const credentials = this.#repository.credentials().filter(credential => credential.user_id === userId)
    const options = await this.#passkeys.authenticationOptions({
      rpId: this.#rpId,
      credentialIds: credentials.map(credential => credential.credential_id),
      requireUserVerification: false,
    })
    const challengeId = await this.#storeChallenge('authentication', userId, null, options.challenge)
    return { challengeId, options }
  }

  async finishPasskeyLogin(challengeId: string, response: AuthenticationResponse, device: DeviceInput): Promise<IssuedSession> {
    return this.#withChallenge(challengeId, 'authentication', undefined, undefined, challenge => (
      this.#mutex.run(`credential:${response.id}`, async () => {
        const credential = this.#credentialForResponse(response.id, challenge.user_id)
        const verified = await this.#verifyAuthentication(response, challenge, credential, false)
        await this.#updateCounter(credential, verified.newCounter)
        const user = this.#user(challenge.user_id)
        const issued = await this.#issueSession(user, device)
        await this.#audit('login_succeeded', user.user_id, issued.session.session_id, user.org_id, user.tenant_id, 'success', 'Entrada por chave de acesso.')
        return issued
      })
    ))
  }

  async beginStepUp(token: string): Promise<PasskeyCeremony<AuthenticationOptions>> {
    const session = await this.authenticate(token)
    const credentials = this.#repository.credentials().filter(credential => credential.user_id === session.user_id)
    if (credentials.length === 0) throw new IdentityError('not-found', t('auth.passkeyRequiredBeforeConfirm'))
    const options = await this.#passkeys.authenticationOptions({
      rpId: this.#rpId,
      credentialIds: credentials.map(credential => credential.credential_id),
      requireUserVerification: true,
    })
    const challengeId = await this.#storeChallenge('step-up', session.user_id, session.session_id, options.challenge)
    return { challengeId, options }
  }

  async finishStepUp(token: string, challengeId: string, response: AuthenticationResponse): Promise<void> {
    const session = await this.authenticate(token)
    await this.#withChallenge(challengeId, 'step-up', session.user_id, session.session_id, challenge => (
      this.#mutex.run(`credential:${response.id}`, async () => {
        const credential = this.#credentialForResponse(response.id, session.user_id)
        const verified = await this.#verifyAuthentication(response, challenge, credential, true)
        if (!verified.userVerified) throw new IdentityError('invalid', t('auth.userVerificationMissing'))
        await this.#updateCounter(credential, verified.newCounter)
        await this.#mutex.run(`session:${session.session_id}`, async () => {
          const current = this.#repository.sessions().find(candidate => candidate.session_id === session.session_id)
          if (current === undefined) throw new IdentityError('invalid', t('auth.invalidSession'))
          this.#assertSessionUsable(current, this.#now())
          await this.#repository.putSession({
            ...current,
            last_strong_auth_at: this.#now().toISOString(),
            last_strong_auth_method: 'passkey',
          })
        })
      })
    ))
    await this.#audit('step_up_succeeded', session.user_id, session.session_id, session.org_id, session.tenant_id, 'success', 'Identidade forte confirmada por chave de acesso.')
  }

  auditRecords(): readonly IdentityAuditRecord[] {
    return this.#repository.audits()
  }

  sessionRecords(): readonly SessionRecord[] {
    return this.#repository.sessions()
  }

  userForSession(session: SessionRecord): IdentityUser {
    return this.#user(session.user_id)
  }

  principalForHarnessSession(harnessSessionId: string): IdentityPrincipal | undefined {
    const session = this.#usableHarnessSessionBinding(harnessSessionId)
    if (session === undefined) return undefined
    try {
      const user = this.#user(session.user_id)
      return { userId: user.user_id, orgId: session.org_id, tenantId: session.tenant_id, sessionId: session.session_id }
    } catch {
      return undefined
    }
  }

  recordAdministrationEvent(
    eventType: Extract<IdentityAuditRecord['event_type'], 'invitation_created' | 'invitation_accepted' | 'role_changed' | 'workspace_created'>,
    userId: string,
    orgId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    return this.#audit(eventType, userId, null, orgId, tenantId, 'success', reason)
  }

  async #issueSession(user: IdentityUser, device: DeviceInput): Promise<IssuedSession> {
    const now = this.#now()
    const token = this.#createSecret()
    const tokenHash = secretHash(token)
    const csrfToken = derivedCsrfToken(tokenHash)
    const session: SessionRecord = {
      session_id: this.#createId(),
      user_id: user.user_id,
      org_id: user.org_id,
      tenant_id: user.tenant_id,
      token_hash: tokenHash,
      csrf_hash: secretHash(csrfToken),
      device_label: device.label,
      user_agent: device.userAgent,
      ip_truncated: device.ipTruncated,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_sliding_at: new Date(now.getTime() + SLIDING_TTL).toISOString(),
      expires_absolute_at: new Date(now.getTime() + ABSOLUTE_TTL).toISOString(),
      last_strong_auth_at: null,
      last_strong_auth_method: null,
      revoked_at: null,
      revoked_reason: null,
      harness_session_ids: [],
    }
    await this.#repository.putSession(session)
    return { token, csrfToken, session }
  }

  #findSessionByToken(token: string): SessionRecord {
    if (token === '') throw new IdentityError('invalid', t('auth.invalidSession'))
    const tokenHash = secretHash(token)
    const session = this.#repository.sessions().find(candidate => candidate.token_hash === tokenHash)
    if (session === undefined) throw new IdentityError('invalid', t('auth.invalidSession'))
    return session
  }

  #assertSessionUsable(session: SessionRecord, now: Date): void {
    if (session.revoked_at !== null) throw new IdentityError('revoked', t('auth.sessionEnded'))
    if (Date.parse(session.expires_absolute_at) <= now.getTime()) throw new IdentityError('expired', t('auth.sessionExpired'))
    if (Date.parse(session.expires_sliding_at) <= now.getTime()) throw new IdentityError('expired', t('auth.sessionIdleExpired'))
  }

  #user(userId: string): IdentityUser {
    const user = this.#repository.users().find(candidate => candidate.user_id === userId)
    if (user === undefined) throw new IdentityError('not-found', t('auth.userNotFound'))
    return user
  }

  #credentialForResponse(credentialId: string, userId: string): PasskeyCredential {
    const credential = this.#repository.credentials().find(candidate => candidate.credential_id === credentialId && candidate.user_id === userId)
    if (credential === undefined) throw new IdentityError('not-found', t('auth.passkeyNotFound'))
    return credential
  }

  async #withChallenge<T>(
    challengeId: string,
    purpose: ChallengeRecord['purpose'],
    userId: string | undefined,
    sessionId: string | undefined,
    work: (challenge: ChallengeRecord) => Promise<T>,
  ): Promise<T> {
    return this.#mutex.run(`challenge:${challengeId}`, async () => {
      const challenge = this.#repository.challenges().find(candidate => candidate.challenge_id === challengeId)
      if (challenge === undefined || challenge.purpose !== purpose
        || (userId !== undefined && challenge.user_id !== userId)
        || (sessionId !== undefined && challenge.session_id !== sessionId)) {
        throw new IdentityError('not-found', t('auth.confirmationNotFound'))
      }
      if (challenge.consumed_at !== null) throw new IdentityError('replay', t('auth.confirmationAlreadyUsed'))
      try {
        if (Date.parse(challenge.expires_at) <= this.#now().getTime()) throw new IdentityError('expired', t('auth.confirmationExpired'))
        return await work(challenge)
      } finally {
        await this.#consumeChallenge(challenge)
      }
    })
  }

  async #storeChallenge(purpose: ChallengeRecord['purpose'], userId: string, sessionId: string | null, challenge: string): Promise<string> {
    const now = this.#now()
    const challengeId = this.#createId()
    await this.#repository.putChallenge({
      challenge_id: challengeId,
      challenge_hash: secretHash(challenge),
      purpose,
      user_id: userId,
      session_id: sessionId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CHALLENGE_TTL).toISOString(),
      consumed_at: null,
    })
    return challengeId
  }

  async #consumeChallenge(challenge: ChallengeRecord): Promise<void> {
    await this.#repository.putChallenge({ ...challenge, consumed_at: this.#now().toISOString() })
  }

  async #verifyAuthentication(response: AuthenticationResponse, challenge: ChallengeRecord, credential: PasskeyCredential, requireUserVerification: boolean) {
    return this.#passkeys.verifyAuthentication({
      response,
      challengeMatches: value => secretMatches(value, challenge.challenge_hash),
      expectedOrigin: this.#expectedOrigin,
      expectedRpId: this.#rpId,
      credential: {
        id: credential.credential_id,
        publicKey: Buffer.from(credential.public_key, 'base64url'),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification,
    })
  }

  async #updateCounter(credential: PasskeyCredential, newCounter: number): Promise<void> {
    if (credential.counter !== 0 && newCounter <= credential.counter) {
      throw new IdentityError('counter', t('auth.passkeyPossiblyCloned'))
    }
    await this.#repository.putCredential({ ...credential, counter: newCounter, last_used_at: this.#now().toISOString() })
  }

  async #audit(
    eventType: IdentityAuditRecord['event_type'],
    userId: string | null,
    sessionId: string | null,
    orgId: string,
    tenantId: string,
    outcome: IdentityAuditRecord['outcome'],
    reason: string,
  ): Promise<void> {
    const record: IdentityAuditRecord = {
      audit_id: this.#createId(),
      event_type: eventType,
      user_id: userId,
      session_id: sessionId,
      org_id: orgId,
      tenant_id: tenantId,
      created_at: this.#now().toISOString(),
      outcome,
      reason,
    }
    await this.#repository.putAudit(record)
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!zEmail.test(normalized)) throw new IdentityError('invalid', t('auth.invalidEmail'))
  return normalized
}

const zEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
