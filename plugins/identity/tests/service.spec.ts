import { describe, expect, it } from 'vitest'
import type { EmailSender, MagicCodeMessage } from '../src/email.ts'
import type {
  ChallengeRecord,
  IdentityAuditRecord,
  IdentityUser,
  MagicCodeRecord,
  PasskeyCredential,
  SessionRecord,
} from '../src/model.ts'
import type {
  AuthenticationOptions,
  AuthenticationResponse,
  PasskeyProvider,
  RegistrationOptions,
  RegistrationResponse,
} from '../src/passkey.ts'
import {
  IdentityError,
  StudioIdentityService,
  type IdentityRepository,
} from '../src/service.ts'

class MemoryRepository implements IdentityRepository {
  readonly userMap = new Map<string, IdentityUser>()
  readonly credentialMap = new Map<string, PasskeyCredential>()
  readonly challengeMap = new Map<string, ChallengeRecord>()
  readonly codeMap = new Map<string, MagicCodeRecord>()
  readonly sessionMap = new Map<string, SessionRecord>()
  readonly auditMap = new Map<string, IdentityAuditRecord>()
  users() { return [...this.userMap.values()] }
  putUser(value: IdentityUser) { this.userMap.set(value.user_id, value); return Promise.resolve() }
  credentials() { return [...this.credentialMap.values()] }
  putCredential(value: PasskeyCredential) { this.credentialMap.set(value.credential_id, value); return Promise.resolve() }
  challenges() { return [...this.challengeMap.values()] }
  putChallenge(value: ChallengeRecord) { this.challengeMap.set(value.challenge_id, value); return Promise.resolve() }
  magicCodes() { return [...this.codeMap.values()] }
  putMagicCode(value: MagicCodeRecord) { this.codeMap.set(value.magic_code_id, value); return Promise.resolve() }
  sessions() { return [...this.sessionMap.values()] }
  putSession(value: SessionRecord) { this.sessionMap.set(value.session_id, value); return Promise.resolve() }
  audits() { return [...this.auditMap.values()] }
  putAudit(value: IdentityAuditRecord) { this.auditMap.set(value.audit_id, value); return Promise.resolve() }
}

class CaptureEmail implements EmailSender {
  readonly messages: MagicCodeMessage[] = []
  sendMagicCode(message: MagicCodeMessage) { this.messages.push(message); return Promise.resolve() }
}

class FakePasskeys implements PasskeyProvider {
  challenge = 'challenge-one'
  registeredId = 'credential-one'
  counter = 1
  userVerified = true
  registrationOptions(): Promise<RegistrationOptions> {
    return Promise.resolve({ challenge: this.challenge } as RegistrationOptions)
  }
  verifyRegistration(input: Parameters<PasskeyProvider['verifyRegistration']>[0]) {
    if (!input.challengeMatches(this.challenge)) return Promise.reject(new Error('challenge'))
    return Promise.resolve({
      id: this.registeredId,
      publicKey: Uint8Array.from([1, 2, 3]),
      counter: this.counter,
      transports: ['internal'],
    })
  }
  authenticationOptions(input: Parameters<PasskeyProvider['authenticationOptions']>[0]): Promise<AuthenticationOptions> {
    return Promise.resolve({ challenge: this.challenge, userVerification: input.requireUserVerification ? 'required' : 'preferred' } as AuthenticationOptions)
  }
  verifyAuthentication(input: Parameters<PasskeyProvider['verifyAuthentication']>[0]) {
    if (!input.challengeMatches(this.challenge)) return Promise.reject(new Error('challenge'))
    return Promise.resolve({ newCounter: this.counter, userVerified: this.userVerified })
  }
}

function makeHarness(enrollment: 'closed' | 'open' = 'open') {
  const repository = new MemoryRepository()
  const email = new CaptureEmail()
  const passkeys = new FakePasskeys()
  let now = new Date('2026-09-02T12:00:00.000Z')
  let id = 0
  let secret = 0
  let code = '123456'
  const service = new StudioIdentityService({
    repository,
    emailSender: email,
    passkeys,
    rpName: 'DZ23 STUDIO',
    rpId: 'localhost',
    expectedOrigin: 'https://localhost',
    defaultOrgId: 'org-a',
    defaultTenantId: 'tenant-a',
    enrollment,
    now: () => new Date(now),
    createId: () => `id-${++id}`,
    createSecret: () => `secret-${++secret}`,
    createMagicCode: () => code,
  })
  return {
    repository, email, passkeys, service,
    setNow: (value: string) => { now = new Date(value) },
    setCode: (value: string) => { code = value },
  }
}

const device = { label: 'Notebook', userAgent: 'Vitest', ipTruncated: '127.0.0.0/24' }
const authResponse = (id = 'credential-one') => ({ id }) as AuthenticationResponse
const registrationResponse = { id: 'new' } as RegistrationResponse

async function login(harness: ReturnType<typeof makeHarness>) {
  await harness.service.requestMagicCode(' Owner@Example.com ')
  return harness.service.verifyMagicCode('owner@example.com', '123456', device)
}

describe('StudioIdentityService', () => {
  it('keeps personal mode local-only and disables it after the first verified access', async () => {
    const h = makeHarness()
    expect(h.service.personalPrincipal('127.0.0.1')).toEqual({
      userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', sessionId: 'session_local',
    })
    expect(h.service.personalPrincipal('0.0.0.0')).toBeUndefined()
    expect(h.service.identityStateForHarnessSession('new-agent', '127.0.0.1')).toEqual({
      authenticated: true, strongIdentityVerified: false,
    })
    await login(h)
    expect(h.service.isPersonalMode('127.0.0.1')).toBe(false)
    expect(h.service.identityStateForHarnessSession('new-agent', '127.0.0.1')).toEqual({
      authenticated: false, strongIdentityVerified: false,
    })
    expect(h.email.messages).toEqual([{ to: 'owner@example.com', code: '123456', expiresInMinutes: 10 }])
    expect(h.repository.users()[0]).toMatchObject({ role: 'owner', org_id: 'org-a', tenant_id: 'tenant-a' })
    expect(h.service.auditRecords().map(record => record.event_type)).toContain('personal_mode_disabled')
    expect(h.service.auditRecords().map(record => record.event_type)).toContain('enrollment_closed')
  })

  it('does not create or email unknown users when enrollment is closed', async () => {
    const h = makeHarness('closed')
    await expect(h.service.requestMagicCode('unknown@example.com')).resolves.toBe('suppressed')
    expect(h.email.messages).toHaveLength(0)
    expect(h.repository.users()).toHaveLength(0)
    expect(h.repository.magicCodes()).toHaveLength(0)
    expect(h.service.auditRecords()).toContainEqual(expect.objectContaining({ event_type: 'magic_code_suppressed' }))
  })

  it('refuses an already-issued unknown-user code after another person closes enrollment', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode('late@example.com')
    await h.service.requestMagicCode('owner@example.com')
    await h.service.verifyMagicCode('owner@example.com', '123456', device)
    await expect(h.service.verifyMagicCode('late@example.com', '123456', device)).rejects.toMatchObject({ code: 'invalid' })
    expect(h.repository.users()).toHaveLength(1)
  })

  it('rejects invalid requests and locks a magic code after five wrong attempts', async () => {
    const h = makeHarness()
    await expect(h.service.requestMagicCode('bad')).rejects.toMatchObject({ code: 'invalid' })
    h.setCode('abc')
    await expect(h.service.requestMagicCode('a@b.com')).rejects.toMatchObject({ code: 'invalid' })
    h.setCode('123456')
    await h.service.requestMagicCode('a@b.com')
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(h.service.verifyMagicCode('a@b.com', '000000', device)).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(h.service.verifyMagicCode('a@b.com', '000000', device)).rejects.toMatchObject({ code: 'locked' })
    await expect(h.service.verifyMagicCode('a@b.com', '123456', device)).rejects.toMatchObject({ code: 'locked' })
    await expect(h.service.verifyMagicCode('none@example.com', '123456', device)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('expires and consumes magic codes exactly once', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode('a@b.com')
    h.setNow('2026-09-02T12:10:00.000Z')
    await expect(h.service.verifyMagicCode('a@b.com', '123456', device)).rejects.toMatchObject({ code: 'expired' })
    h.setNow('2026-09-02T12:00:00.000Z')
    await h.service.requestMagicCode('a@b.com')
    await h.service.verifyMagicCode('a@b.com', '123456', device)
    await expect(h.service.verifyMagicCode('a@b.com', '123456', device)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('chooses the newest eligible code when imported storage contains more than one', async () => {
    const h = makeHarness()
    h.repository.codeMap.set('old', {
      magic_code_id: 'old', email: 'a@b.com', code_hash: '0'.repeat(64), org_id: 'old-org', tenant_id: 'old-tenant',
      attempts: 0, created_at: '2026-09-02T11:00:00.000Z', expires_at: '2026-09-02T13:00:00.000Z', consumed_at: null,
    })
    await h.service.requestMagicCode('a@b.com')
    h.repository.codeMap.set('old', { ...h.repository.codeMap.get('old')!, consumed_at: null })
    const issued = await h.service.verifyMagicCode('a@b.com', '123456', device)
    expect(issued.session.org_id).toBe('org-a')
  })

  it('uses opaque revocable sessions with sliding and absolute expiry plus CSRF', async () => {
    const h = makeHarness()
    const issued = await login(h)
    expect(issued.session.token_hash).not.toContain(issued.token)
    expect(issued.session.csrf_hash).not.toContain(issued.csrfToken)
    await expect(h.service.authenticate('wrong')).rejects.toMatchObject({ code: 'invalid' })
    await expect(h.service.authenticate('')).rejects.toMatchObject({ code: 'invalid' })
    await expect(h.service.authenticate(issued.token, false)).resolves.toEqual(issued.session)
    await expect(h.service.authenticate(issued.token)).resolves.toBe(issued.session)
    expect(() => h.service.validateCsrf(issued.session, issued.csrfToken, issued.csrfToken)).not.toThrow()
    for (const [cookie, header] of [[undefined, issued.csrfToken], [issued.csrfToken, undefined], ['wrong', 'wrong']]) {
      expect(() => h.service.validateCsrf(issued.session, cookie, header)).toThrow(IdentityError)
    }
    h.setNow('2026-09-03T12:00:00.000Z')
    const touched = await h.service.authenticate(issued.token)
    expect(touched.last_seen_at).toBe('2026-09-03T12:00:00.000Z')
    await h.service.revokeSession(touched, touched.session_id)
    await h.service.revokeSession(touched, touched.session_id)
    await expect(h.service.authenticate(issued.token)).rejects.toMatchObject({ code: 'revoked' })
    await expect(h.service.revokeSession(touched, 'missing')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('rejects sliding and absolute expiration independently', async () => {
    const h = makeHarness()
    const issued = await login(h)
    h.setNow('2026-09-16T12:00:00.000Z')
    await expect(h.service.authenticate(issued.token)).rejects.toMatchObject({ code: 'expired' })
    const stored = h.repository.sessionMap.get(issued.session.session_id)!
    h.repository.sessionMap.set(stored.session_id, { ...stored, expires_sliding_at: '2027-01-01T00:00:00.000Z' })
    h.setNow('2026-12-01T12:00:00.000Z')
    await expect(h.service.authenticate(issued.token)).rejects.toMatchObject({ code: 'expired' })
  })

  it('lists safe device data, binds a Harness session once, and revokes all devices', async () => {
    const h = makeHarness()
    const first = await login(h)
    const second = await h.service.verifyMagicCode(
      'owner@example.com',
      await (async () => { await h.service.requestMagicCode('owner@example.com'); return '123456' })(),
      { ...device, label: 'Celular' },
    )
    expect(h.service.listDevices(first.session.user_id)).toHaveLength(2)
    expect(h.service.listDevices(first.session.user_id)[0]).not.toHaveProperty('token_hash')
    await expect(h.service.bindHarnessSession(first.session, ' ')).rejects.toMatchObject({ code: 'invalid' })
    await h.service.bindHarnessSession(first.session, 'agent-1')
    await h.service.bindHarnessSession(h.repository.sessionMap.get(first.session.session_id)!, 'agent-1')
    expect(h.service.strongIdentityForHarnessSession('agent-1')).toBe(false)
    expect(h.service.identityStateForHarnessSession('agent-1', '0.0.0.0')).toEqual({
      authenticated: true, strongIdentityVerified: false,
    })
    expect(h.service.sessionRecords()).toHaveLength(2)
    await h.service.revokeAllSessions(second.session)
    expect(h.repository.sessions().every(session => session.revoked_at !== null)).toBe(true)
    expect(h.service.strongIdentityForHarnessSession('agent-1')).toBe(false)
    expect(h.service.identityStateForHarnessSession('agent-1', '0.0.0.0')).toEqual({
      authenticated: false, strongIdentityVerified: false,
    })
  })

  it('registers a passkey, rejects duplicate credentials and expired or replayed challenges', async () => {
    const h = makeHarness()
    const issued = await login(h)
    const ceremony = await h.service.beginPasskeyRegistration(issued.token)
    await h.service.finishPasskeyRegistration(issued.token, ceremony.challengeId, registrationResponse, 'Windows Hello')
    expect(h.repository.credentials()[0]).toMatchObject({ credential_id: 'credential-one', device_label: 'Windows Hello' })
    const second = await h.service.beginPasskeyRegistration(issued.token)
    await expect(h.service.finishPasskeyRegistration(issued.token, second.challengeId, registrationResponse, 'Duplicada'))
      .rejects.toMatchObject({ code: 'replay' })
    await expect(h.service.finishPasskeyRegistration(issued.token, second.challengeId, registrationResponse, 'Duplicada novamente'))
      .rejects.toMatchObject({ code: 'replay' })
    await expect(h.service.finishPasskeyRegistration(issued.token, ceremony.challengeId, registrationResponse, 'Reuso'))
      .rejects.toMatchObject({ code: 'replay' })
    const third = await h.service.beginPasskeyRegistration(issued.token)
    h.setNow('2026-09-02T12:05:00.000Z')
    await expect(h.service.finishPasskeyRegistration(issued.token, third.challengeId, registrationResponse, 'Expirada'))
      .rejects.toMatchObject({ code: 'expired' })
    await expect(h.service.finishPasskeyRegistration(issued.token, 'missing', registrationResponse, 'Ausente'))
      .rejects.toMatchObject({ code: 'not-found' })
    const wrongPurpose = await h.service.beginPasskeyLogin('owner@example.com')
    await expect(h.service.finishPasskeyRegistration(issued.token, wrongPurpose.challengeId, registrationResponse, 'Errada'))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('fails closed when a durable session points to a missing user', async () => {
    const h = makeHarness()
    const issued = await login(h)
    h.repository.userMap.clear()
    await expect(h.service.beginPasskeyRegistration(issued.token)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('uses cryptographically secure defaults when test factories are omitted', async () => {
    const repository = new MemoryRepository()
    const email = new CaptureEmail()
    const service = new StudioIdentityService({
      repository,
      emailSender: email,
      passkeys: new FakePasskeys(),
      rpName: 'DZ23', rpId: 'localhost', expectedOrigin: 'https://localhost',
      defaultOrgId: 'org', defaultTenantId: 'tenant', enrollment: 'open',
    })
    await service.requestMagicCode('secure@example.com')
    expect(repository.magicCodes()[0]!.magic_code_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(email.messages[0]!.code).toMatch(/^\d{6}$/)
  })

  it('logs in with a passkey and rejects a regressing authenticator counter', async () => {
    const h = makeHarness()
    const issued = await login(h)
    const registration = await h.service.beginPasskeyRegistration(issued.token)
    await h.service.finishPasskeyRegistration(issued.token, registration.challengeId, registrationResponse, 'Passkey')
    h.passkeys.counter = 2
    const loginCeremony = await h.service.beginPasskeyLogin('owner@example.com')
    const passkeySession = await h.service.finishPasskeyLogin(loginCeremony.challengeId, authResponse(), device)
    expect(passkeySession.session.user_id).toBe(issued.session.user_id)
    h.passkeys.counter = 2
    const replay = await h.service.beginPasskeyLogin('owner@example.com')
    await expect(h.service.finishPasskeyLogin(replay.challengeId, authResponse(), device)).rejects.toMatchObject({ code: 'counter' })
    const unknown = await h.service.beginPasskeyLogin('unknown@example.com')
    await expect(h.service.finishPasskeyLogin(unknown.challengeId, authResponse(), device)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('requires a UV passkey step-up and grants strong identity for five minutes only', async () => {
    const h = makeHarness()
    const issued = await login(h)
    await expect(h.service.beginStepUp(issued.token)).rejects.toMatchObject({ code: 'not-found' })
    const registration = await h.service.beginPasskeyRegistration(issued.token)
    await h.service.finishPasskeyRegistration(issued.token, registration.challengeId, registrationResponse, 'Passkey')
    await h.service.bindHarnessSession(h.repository.sessions()[0]!, 'agent-strong')
    h.passkeys.counter = 2
    h.passkeys.userVerified = false
    const failed = await h.service.beginStepUp(issued.token)
    await expect(h.service.finishStepUp(issued.token, failed.challengeId, authResponse())).rejects.toMatchObject({ code: 'invalid' })
    await expect(h.service.finishStepUp(issued.token, failed.challengeId, authResponse())).rejects.toMatchObject({ code: 'replay' })
    h.passkeys.userVerified = true
    const stepUp = await h.service.beginStepUp(issued.token)
    await h.service.finishStepUp(issued.token, stepUp.challengeId, authResponse())
    expect(h.service.strongIdentityForHarnessSession('agent-strong')).toBe(true)
    expect(h.service.identityStateForHarnessSession('agent-strong', '0.0.0.0')).toEqual({
      authenticated: true, strongIdentityVerified: true,
    })
    h.setNow('2026-09-02T12:05:00.000Z')
    expect(h.service.strongIdentityForHarnessSession('agent-strong')).toBe(false)
  })

  it('serializes concurrent one-time code and challenge consumption', async () => {
    const h = makeHarness()
    const issued = await login(h)
    await h.service.requestMagicCode('owner@example.com')
    const magicResults = await Promise.allSettled([
      h.service.verifyMagicCode('owner@example.com', '123456', device),
      h.service.verifyMagicCode('owner@example.com', '123456', device),
    ])
    expect(magicResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(magicResults.filter(result => result.status === 'rejected')).toHaveLength(1)

    const registration = await h.service.beginPasskeyRegistration(issued.token)
    const challengeResults = await Promise.allSettled([
      h.service.finishPasskeyRegistration(issued.token, registration.challengeId, registrationResponse, 'Primeira'),
      h.service.finishPasskeyRegistration(issued.token, registration.challengeId, registrationResponse, 'Segunda'),
    ])
    expect(challengeResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(challengeResults.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})
