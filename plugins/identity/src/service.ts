import { randomUUID } from 'node:crypto'
import { newMagicCode, newOpaqueSecret, secretHash, secretMatches } from './crypto.js'
import type { EmailSender } from './email.js'
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

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const CHALLENGE_TTL = 5 * MINUTE
const MAGIC_TTL = 10 * MINUTE
const SLIDING_TTL = 14 * DAY
const ABSOLUTE_TTL = 90 * DAY
const STRONG_AUTH_TTL = 5 * MINUTE
const MAX_MAGIC_ATTEMPTS = 5
const SESSION_TOUCH_INTERVAL = MINUTE

export type EnrollmentMode = 'closed' | 'open'
export type MagicCodeRequestResult = 'sent' | 'suppressed'

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
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #createSecret: () => string
  readonly #createMagicCode: () => string
  readonly #mutex = new KeyedMutex()

  constructor(options: IdentityServiceOptions) {
    this.#repository = options.repository
    this.#passkeys = options.passkeys
    this.#emailSender = options.emailSender
    this.#rpName = options.rpName
    this.#rpId = options.rpId
    this.#expectedOrigin = options.expectedOrigin
    this.#defaultOrgId = options.defaultOrgId
    this.#defaultTenantId = options.defaultTenantId
    this.#enrollment = options.enrollment
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#createSecret = options.createSecret ?? newOpaqueSecret
    this.#createMagicCode = options.createMagicCode ?? newMagicCode
  }

  isPersonalMode(bindHost: '127.0.0.1' | '0.0.0.0'): boolean {
    return bindHost === '127.0.0.1' && this.#repository.users().length === 0
  }

  personalPrincipal(bindHost: '127.0.0.1' | '0.0.0.0'): IdentityPrincipal | undefined {
    if (!this.isPersonalMode(bindHost)) return undefined
    return { userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', sessionId: 'session_local' }
  }

  isEnrollmentOpen(): boolean {
    return this.#enrollment === 'open' && this.#repository.users().length === 0
  }

  async requestMagicCode(email: string): Promise<MagicCodeRequestResult> {
    const normalized = normalizeEmail(email)
    return this.#mutex.run(`magic-request:${normalized}`, async () => {
      const existing = this.#repository.users().find(user => user.email === normalized)
      if (existing === undefined && !this.isEnrollmentOpen()) {
        await this.#audit(
          'magic_code_suppressed', null, null, this.#defaultOrgId, this.#defaultTenantId,
          'failure', 'Solicitação genérica recusada: não existe convite nem cadastro inicial aberto.',
        )
        return 'suppressed'
      }
      const code = this.#createMagicCode()
      if (!/^\d{6}$/.test(code)) throw new IdentityError('invalid', 'O gerador de código retornou um valor inválido.')
      const now = this.#now()
      await Promise.all(this.#repository.magicCodes()
        .filter(previous => previous.email === normalized && previous.consumed_at === null)
        .map(previous => this.#repository.putMagicCode({ ...previous, consumed_at: now.toISOString() })))
      const orgId = existing?.org_id ?? this.#defaultOrgId
      const tenantId = existing?.tenant_id ?? this.#defaultTenantId
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
      await this.#audit('magic_code_requested', existing?.user_id ?? null, null, orgId, tenantId, 'success', 'Código temporário solicitado.')
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
      await this.#audit('login_failed', null, null, 'org_unknown', 'tenant_unknown', 'failure', 'Código temporário ausente.')
      throw new IdentityError('not-found', 'Código inválido ou expirado.')
    }
    const now = this.#now()
    if (Date.parse(candidate.expires_at) <= now.getTime()) {
      await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', 'Código temporário expirado.')
      throw new IdentityError('expired', 'Código inválido ou expirado.')
    }
    if (candidate.attempts >= MAX_MAGIC_ATTEMPTS) {
      throw new IdentityError('locked', 'Muitas tentativas. Solicite um novo código.')
    }
    if (!secretMatches(code, candidate.code_hash)) {
      const attempts = candidate.attempts + 1
      await this.#repository.putMagicCode({ ...candidate, attempts })
      await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', 'Código temporário incorreto.')
      throw new IdentityError(attempts >= MAX_MAGIC_ATTEMPTS ? 'locked' : 'invalid', 'Código inválido ou expirado.')
    }
    await this.#repository.putMagicCode({ ...candidate, consumed_at: now.toISOString() })
    const existing = this.#repository.users().find(user => user.email === normalized)
    if (existing === undefined && !this.isEnrollmentOpen()) {
      await this.#audit('login_failed', null, null, candidate.org_id, candidate.tenant_id, 'failure', 'Cadastro inicial já encerrado.')
      throw new IdentityError('invalid', 'Código inválido ou expirado.')
    }
    const user: IdentityUser = existing ?? {
      user_id: this.#createId(),
      email: normalized,
      display_name: normalized.split('@')[0]!,
      role: 'owner',
      org_id: candidate.org_id,
      tenant_id: candidate.tenant_id,
      created_at: now.toISOString(),
    }
    if (existing === undefined) {
      await this.#repository.putUser(user)
      await this.#audit('personal_mode_disabled', user.user_id, null, user.org_id, user.tenant_id, 'success', 'Primeiro acesso cadastrado.')
      await this.#audit('enrollment_closed', user.user_id, null, user.org_id, user.tenant_id, 'success', 'Cadastro inicial encerrado após criar a pessoa proprietária.')
    }
    const issued = await this.#issueSession(user, device)
    await this.#audit('login_succeeded', user.user_id, issued.session.session_id, user.org_id, user.tenant_id, 'success', 'Entrada por código temporário.')
    return issued
  }

  async authenticate(token: string, touch = true): Promise<SessionRecord> {
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
  }

  validateCsrf(session: SessionRecord, cookieToken: string | undefined, headerToken: string | undefined): void {
    if (cookieToken === undefined || headerToken === undefined
      || cookieToken !== headerToken || !secretMatches(headerToken, session.csrf_hash)) {
      throw new IdentityError('csrf', 'A confirmação desta solicitação é inválida.')
    }
  }

  listDevices(userId: string): readonly Omit<SessionRecord, 'token_hash' | 'csrf_hash'>[] {
    return this.#repository.sessions()
      .filter(session => session.user_id === userId)
      .map(({ token_hash: _tokenHash, csrf_hash: _csrfHash, ...safe }) => safe)
  }

  async revokeSession(actor: SessionRecord, sessionId: string, reason = 'Revogada pela pessoa usuária.'): Promise<void> {
    const target = this.#repository.sessions().find(session => session.session_id === sessionId && session.user_id === actor.user_id)
    if (target === undefined) throw new IdentityError('not-found', 'Dispositivo não encontrado.')
    if (target.revoked_at !== null) return
    const revoked = { ...target, revoked_at: this.#now().toISOString(), revoked_reason: reason }
    await this.#repository.putSession(revoked)
    await this.#audit('session_revoked', actor.user_id, target.session_id, actor.org_id, actor.tenant_id, 'success', reason)
  }

  async revokeAllSessions(actor: SessionRecord): Promise<void> {
    const active = this.#repository.sessions().filter(session => session.user_id === actor.user_id && session.revoked_at === null)
    const now = this.#now().toISOString()
    await Promise.all(active.map(session => this.#repository.putSession({
      ...session,
      revoked_at: now,
      revoked_reason: 'Saída de todos os dispositivos.',
    })))
    await this.#audit('all_sessions_revoked', actor.user_id, actor.session_id, actor.org_id, actor.tenant_id, 'success', 'Todas as sessões foram revogadas.')
  }

  async bindHarnessSession(session: SessionRecord, harnessSessionId: string): Promise<void> {
    if (harnessSessionId.trim() === '') throw new IdentityError('invalid', 'Sessão do agente inválida.')
    if (session.harness_session_ids.includes(harnessSessionId)) return
    await this.#repository.putSession({
      ...session,
      harness_session_ids: [...session.harness_session_ids, harnessSessionId],
    })
    await this.#audit('harness_session_bound', session.user_id, session.session_id, session.org_id, session.tenant_id, 'success', 'Sessão do agente vinculada.')
  }

  strongIdentityForHarnessSession(harnessSessionId: string): boolean {
    const now = this.#now()
    return this.#repository.sessions().some(session => {
      if (!session.harness_session_ids.includes(harnessSessionId)) return false
      try {
        this.#assertSessionUsable(session, now)
      } catch {
        return false
      }
      return session.last_strong_auth_method === 'passkey'
        && session.last_strong_auth_at !== null
        && now.getTime() - Date.parse(session.last_strong_auth_at) < STRONG_AUTH_TTL
    })
  }

  identityStateForHarnessSession(
    harnessSessionId: string,
    bindHost: '127.0.0.1' | '0.0.0.0',
  ): IdentityExecutionState {
    if (this.isPersonalMode(bindHost)) return { authenticated: true, strongIdentityVerified: false }
    const bound = this.#repository.sessions().filter(session => session.harness_session_ids.includes(harnessSessionId))
    const authenticated = bound.some(session => {
      try {
        this.#assertSessionUsable(session, this.#now())
        return true
      } catch {
        return false
      }
    })
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
        throw new IdentityError('replay', 'Esta chave de acesso já está cadastrada.')
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
    if (credentials.length === 0) throw new IdentityError('not-found', 'Cadastre uma chave de acesso antes de confirmar esta ação.')
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
        if (!verified.userVerified) throw new IdentityError('invalid', 'A biometria ou o PIN do dispositivo não foi confirmado.')
        await this.#updateCounter(credential, verified.newCounter)
        await this.#repository.putSession({
          ...session,
          last_strong_auth_at: this.#now().toISOString(),
          last_strong_auth_method: 'passkey',
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

  async #issueSession(user: IdentityUser, device: DeviceInput): Promise<IssuedSession> {
    const now = this.#now()
    const token = this.#createSecret()
    const csrfToken = this.#createSecret()
    const session: SessionRecord = {
      session_id: this.#createId(),
      user_id: user.user_id,
      org_id: user.org_id,
      tenant_id: user.tenant_id,
      token_hash: secretHash(token),
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
    if (token === '') throw new IdentityError('invalid', 'Sessão inválida.')
    const tokenHash = secretHash(token)
    const session = this.#repository.sessions().find(candidate => candidate.token_hash === tokenHash)
    if (session === undefined) throw new IdentityError('invalid', 'Sessão inválida.')
    return session
  }

  #assertSessionUsable(session: SessionRecord, now: Date): void {
    if (session.revoked_at !== null) throw new IdentityError('revoked', 'Esta sessão foi encerrada.')
    if (Date.parse(session.expires_absolute_at) <= now.getTime()) throw new IdentityError('expired', 'Esta sessão expirou.')
    if (Date.parse(session.expires_sliding_at) <= now.getTime()) throw new IdentityError('expired', 'Esta sessão expirou por inatividade.')
  }

  #user(userId: string): IdentityUser {
    const user = this.#repository.users().find(candidate => candidate.user_id === userId)
    if (user === undefined) throw new IdentityError('not-found', 'Pessoa usuária não encontrada.')
    return user
  }

  #credentialForResponse(credentialId: string, userId: string): PasskeyCredential {
    const credential = this.#repository.credentials().find(candidate => candidate.credential_id === credentialId && candidate.user_id === userId)
    if (credential === undefined) throw new IdentityError('not-found', 'Chave de acesso não encontrada.')
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
        throw new IdentityError('not-found', 'Confirmação não encontrada.')
      }
      if (challenge.consumed_at !== null) throw new IdentityError('replay', 'Esta confirmação já foi usada.')
      try {
        if (Date.parse(challenge.expires_at) <= this.#now().getTime()) throw new IdentityError('expired', 'Esta confirmação expirou.')
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
      throw new IdentityError('counter', 'Esta chave de acesso pode ter sido clonada e foi bloqueada.')
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
  if (!zEmail.test(normalized)) throw new IdentityError('invalid', 'Digite um e-mail válido.')
  return normalized
}

const zEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
