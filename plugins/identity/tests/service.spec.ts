import { describe, expect, it } from 'vitest'
import type { EmailSender, InvitationMessage, MagicCodeMessage } from '../src/email.ts'
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
  CAMPOS_PRIVADOS_DA_SESSAO,
  IdentityError,
  StudioIdentityService,
  type EnrollmentMode,
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
  readonly invitations: InvitationMessage[] = []
  sendMagicCode(message: MagicCodeMessage) { this.messages.push(message); return Promise.resolve() }
  sendInvitation(message: InvitationMessage) { this.invitations.push(message); return Promise.resolve() }
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
    // `allowCredentials` ECOADO, como o provedor de verdade faz
    // (`passkey.ts:102`). O dublê antes descartava a lista, e por isso nenhum
    // teste conseguia enxergar o que a rota pública devolve — que é exatamente
    // onde estava a enumeração de usuário.
    return Promise.resolve({
      challenge: this.challenge,
      allowCredentials: input.credentialIds.map(id => ({ id })),
      userVerification: input.requireUserVerification ? 'required' : 'preferred',
    } as AuthenticationOptions)
  }
  verifyAuthentication(input: Parameters<PasskeyProvider['verifyAuthentication']>[0]) {
    if (!input.challengeMatches(this.challenge)) return Promise.reject(new Error('challenge'))
    return Promise.resolve({ newCounter: this.counter, userVerified: this.userVerified })
  }
}

function makeHarness(enrollment: EnrollmentMode = 'open', personalModeAllowed = true) {
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
    rpName: 'FRIGG',
    rpId: 'localhost',
    expectedOrigin: 'https://localhost',
    defaultOrgId: 'org-a',
    defaultTenantId: 'tenant-a',
    enrollment,
    personalModeAllowed,
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
    expect(h.repository.users()[0]).toMatchObject({ bootstrap_owner: true, org_id: 'org-a', tenant_id: 'tenant-a' })
    expect(h.service.auditRecords().map(record => record.event_type)).toContain('personal_mode_disabled')
    expect(h.service.auditRecords().map(record => record.event_type)).toContain('enrollment_closed')
  })

  it('disables personal mode in the service when an authenticated edge is required', () => {
    const h = makeHarness('open', false)
    expect(h.service.isPersonalMode('127.0.0.1')).toBe(false)
    expect(h.service.personalPrincipal('127.0.0.1')).toBeUndefined()
    expect(h.service.identityStateForHarnessSession('unbound-agent', '127.0.0.1')).toEqual({
      authenticated: false, strongIdentityVerified: false,
    })
  })

  it('allows the process-wide Harness browser client only for one local registered person', async () => {
    const local = makeHarness()
    const first = await login(local)
    expect(local.service.isSharedHarnessClientAllowed(first.session)).toBe(true)

    const edge = makeHarness('closed', false)
    expect(edge.service.isSharedHarnessClientAllowed(first.session)).toBe(false)

    const secondUser = {
      ...local.repository.users()[0]!, user_id: 'user-2', email: 'second@example.com', bootstrap_owner: false,
    }
    await local.repository.putUser(secondUser)
    expect(local.service.isSharedHarnessClientAllowed(first.session)).toBe(false)
    expect(local.service.isSharedHarnessClientAllowed({ ...first.session, user_id: 'user-2' })).toBe(false)
  })

  it('allows only the configured email to win bootstrap enrollment', async () => {
    const h = makeHarness({ mode: 'bootstrap-email', email: ' Owner@Example.com ' }, false)
    const [competitor, owner] = await Promise.all([
      h.service.requestMagicCode('competitor@example.com'),
      h.service.requestMagicCode('owner@example.com'),
    ])
    expect({ competitor, owner }).toEqual({ competitor: 'suppressed', owner: 'sent' })
    expect(h.email.messages).toEqual([{ to: 'owner@example.com', code: '123456', expiresInMinutes: 10 }])
    expect(h.repository.magicCodes()).toHaveLength(1)
    expect(h.repository.users()).toHaveLength(0)

    await h.service.verifyMagicCode('owner@example.com', '123456', device)
    expect(h.repository.users()).toEqual([
      expect.objectContaining({ email: 'owner@example.com', bootstrap_owner: true }),
    ])
    await expect(h.service.requestMagicCode('competitor@example.com')).resolves.toBe('suppressed')
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
    // `invalid`, e nao `not-found`: quem nao tem conta e quem errou o codigo
    // recebem a MESMA recusa. Enquanto eram duas, o par de chamadas
    // start+verify respondia 'essa pessoa tem conta aqui?' com um status HTTP.
    await expect(h.service.verifyMagicCode('none@example.com', '123456', device)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('expires and consumes magic codes exactly once', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode('a@b.com')
    h.setNow('2026-09-02T12:10:00.000Z')
    await expect(h.service.verifyMagicCode('a@b.com', '123456', device)).rejects.toMatchObject({ code: 'expired' })
    h.setNow('2026-09-02T12:00:00.000Z')
    await h.service.requestMagicCode('a@b.com')
    await h.service.verifyMagicCode('a@b.com', '123456', device)
    await expect(h.service.verifyMagicCode('a@b.com', '123456', device)).rejects.toMatchObject({ code: 'invalid' })
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
    expect(() => h.service.validateCsrfToken(issued.session, issued.csrfToken)).not.toThrow()
    expect(() => h.service.validateCsrfToken(issued.session, undefined)).toThrow(IdentityError)
    h.repository.sessionMap.set(issued.session.session_id, { ...issued.session, csrf_hash: 'legacy-hash' })
    await expect(h.service.csrfTokenFor(issued.session)).resolves.toBe(issued.csrfToken)
    await expect(h.service.csrfTokenFor(issued.session)).resolves.toBe(issued.csrfToken)
    await expect(h.service.csrfTokenFor({ ...issued.session, session_id: 'missing' })).rejects.toMatchObject({ code: 'invalid' })
    for (const header of [undefined, '', 'wrong']) {
      expect(() => h.service.validateCsrfToken(issued.session, header)).toThrow(IdentityError)
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
    expect(h.service.ownsHarnessSession(first.session, 'agent-1')).toBe(true)
    expect(h.service.ownsHarnessSession({ ...first.session, user_id: 'other' }, 'agent-1')).toBe(false)
    expect(h.service.ownsHarnessSession({ ...first.session, org_id: 'other' }, 'agent-1')).toBe(false)
    expect(h.service.ownsHarnessSession({ ...first.session, tenant_id: 'other' }, 'agent-1')).toBe(false)
    expect(h.service.ownsHarnessSession(second.session, 'agent-1')).toBe(false)
    expect(h.service.ownsHarnessSession(first.session, ' ')).toBe(false)
    await expect(h.service.bindHarnessSession(second.session, 'agent-1')).rejects.toMatchObject({ code: 'replay' })
    expect(h.service.auditRecords()).toContainEqual(expect.objectContaining({
      event_type: 'harness_session_bound', outcome: 'failure', session_id: second.session.session_id,
    }))
    expect(h.service.strongIdentityForHarnessSession('agent-1')).toBe(false)
    expect(h.service.identityStateForHarnessSession('agent-1', '0.0.0.0')).toEqual({
      authenticated: true, strongIdentityVerified: false,
    })
    expect(h.service.sessionRecords()).toHaveLength(2)
    await h.service.revokeAllSessions(second.session)
    expect(h.repository.sessions().every(session => session.revoked_at !== null)).toBe(true)
    expect(h.service.ownsHarnessSession(first.session, 'agent-1')).toBe(false)
    expect(h.service.strongIdentityForHarnessSession('agent-1')).toBe(false)
    expect(h.service.identityStateForHarnessSession('agent-1', '0.0.0.0')).toEqual({
      authenticated: false, strongIdentityVerified: false,
    })
  })

  it('serializes assistant bindings and fails closed on ambiguous imported ownership', async () => {
    const h = makeHarness()
    const first = await login(h)
    await h.service.requestMagicCode('owner@example.com')
    const second = await h.service.verifyMagicCode('owner@example.com', '123456', { ...device, label: 'Celular' })

    await Promise.all([
      h.service.bindHarnessSession(first.session, 'agent-a'),
      h.service.bindHarnessSession(first.session, 'agent-b'),
    ])
    expect(h.repository.sessionMap.get(first.session.session_id)?.harness_session_ids).toEqual(['agent-a', 'agent-b'])

    const contested = await Promise.allSettled([
      h.service.bindHarnessSession(first.session, 'agent-contested'),
      h.service.bindHarnessSession(second.session, 'agent-contested'),
    ])
    expect(contested.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(contested.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(h.repository.sessions().filter(session => session.harness_session_ids.includes('agent-contested'))).toHaveLength(1)

    const secondStored = h.repository.sessionMap.get(second.session.session_id)!
    h.repository.sessionMap.set(secondStored.session_id, {
      ...secondStored,
      harness_session_ids: [...secondStored.harness_session_ids, 'agent-a'],
    })
    expect(h.service.ownsHarnessSession(first.session, 'agent-a')).toBe(false)
    expect(h.service.ownsHarnessSession(second.session, 'agent-a')).toBe(false)
    expect(h.service.principalForHarnessSession('agent-a')).toBeUndefined()
    expect(h.service.strongIdentityForHarnessSession('agent-a')).toBe(false)
    expect(h.service.identityStateForHarnessSession('agent-a', '0.0.0.0')).toEqual({
      authenticated: false, strongIdentityVerified: false,
    })
  })

  it('refuses a ninth conversation pointer instead of silently dropping one', async () => {
    const h = makeHarness()
    const issued = await login(h)
    for (let index = 0; index < 8; index += 1) {
      await h.service.bindHarnessSession(h.repository.sessionMap.get(issued.session.session_id)!, `agent-${String(index)}`)
    }
    const full = h.repository.sessionMap.get(issued.session.session_id)!
    expect(full.harness_session_ids).toHaveLength(8)
    await expect(h.service.bindHarnessSession(full, 'agent-8')).rejects.toMatchObject({ code: 'invalid' })
    const stored = h.repository.sessionMap.get(issued.session.session_id)!
    expect(stored.harness_session_ids).toHaveLength(8)
    expect(stored.harness_session_ids[0]).toBe('agent-0')
    expect(stored.harness_session_ids).not.toContain('agent-8')
    expect(h.service.ownsHarnessSession(stored, 'agent-0')).toBe(true)
    const refused = h.service.auditRecords().filter(record => (
      record.event_type === 'harness_session_bound' && record.outcome === 'failure'
    ))
    expect(refused).toHaveLength(1)
    expect(refused[0]?.reason).toContain('8')
  })

  it('releases a pointer only with an audit written first, and lets the freed slot be reused', async () => {
    const h = makeHarness()
    const issued = await login(h)
    for (let index = 0; index < 8; index += 1) {
      await h.service.bindHarnessSession(h.repository.sessionMap.get(issued.session.session_id)!, `agent-${String(index)}`)
    }
    await h.service.releaseHarnessSession(
      h.repository.sessionMap.get(issued.session.session_id)!, 'agent-0', 'o Harness não encontrou mais esta conversa',
    )
    const afterRelease = h.repository.sessionMap.get(issued.session.session_id)!
    expect(afterRelease.harness_session_ids).toHaveLength(7)
    expect(afterRelease.harness_session_ids).not.toContain('agent-0')
    expect(h.service.ownsHarnessSession(afterRelease, 'agent-0')).toBe(false)
    const released = h.service.auditRecords().filter(record => record.event_type === 'harness_session_unbound')
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ outcome: 'success', session_id: issued.session.session_id })
    expect(released[0]?.reason).toContain('agent-0')
    // Liberar é idempotente e não inventa auditoria para ponteiro inexistente.
    await h.service.releaseHarnessSession(afterRelease, 'agent-0', 'de novo')
    expect(h.service.auditRecords().filter(record => record.event_type === 'harness_session_unbound')).toHaveLength(1)
    await expect(h.service.releaseHarnessSession(afterRelease, ' ', 'vazio')).rejects.toMatchObject({ code: 'invalid' })
    // Linha de sessão que sumiu no meio do caminho falha fechado.
    const vanished = makeHarness()
    const gone = await login(vanished)
    await vanished.service.bindHarnessSession(vanished.repository.sessionMap.get(gone.session.session_id)!, 'agent-x')
    vanished.repository.sessionMap.clear()
    await expect(vanished.service.releaseHarnessSession(gone.session, 'agent-x', 'motivo'))
      .rejects.toMatchObject({ code: 'invalid' })
    // A vaga liberada volta a aceitar uma conversa nova.
    await h.service.bindHarnessSession(h.repository.sessionMap.get(issued.session.session_id)!, 'agent-8')
    expect(h.repository.sessionMap.get(issued.session.session_id)!.harness_session_ids).toHaveLength(8)
  })

  it('does not write the session before the release audit succeeds', async () => {
    const h = makeHarness()
    const issued = await login(h)
    await h.service.bindHarnessSession(h.repository.sessionMap.get(issued.session.session_id)!, 'agent-0')
    const putAudit = h.repository.putAudit.bind(h.repository)
    h.repository.putAudit = async record => {
      if (record.event_type === 'harness_session_unbound') throw new Error('auditoria indisponível')
      return putAudit(record)
    }
    await expect(h.service.releaseHarnessSession(
      h.repository.sessionMap.get(issued.session.session_id)!, 'agent-0', 'motivo',
    )).rejects.toThrow()
    expect(h.repository.sessionMap.get(issued.session.session_id)!.harness_session_ids).toContain('agent-0')
  })


  it('fails closed when session rows disappear or are revoked during serialized mutations', async () => {
    const missingBinding = makeHarness()
    const issued = await login(missingBinding)
    missingBinding.repository.sessionMap.clear()
    await expect(missingBinding.service.bindHarnessSession(issued.session, 'agent-gone'))
      .rejects.toMatchObject({ code: 'invalid' })

    const removedDuringRevoke = makeHarness()
    const removed = await login(removedDuringRevoke)
    const removedRows = removedDuringRevoke.repository.sessions.bind(removedDuringRevoke.repository)
    let removedReads = 0
    removedDuringRevoke.repository.sessions = () => ++removedReads === 1 ? removedRows() : []
    await expect(removedDuringRevoke.service.revokeAllSessions(removed.session)).resolves.toBeUndefined()

    const revokedDuringRevoke = makeHarness()
    const revoked = await login(revokedDuringRevoke)
    const revokedRows = revokedDuringRevoke.repository.sessions.bind(revokedDuringRevoke.repository)
    let revokedReads = 0
    revokedDuringRevoke.repository.sessions = () => ++revokedReads === 1
      ? revokedRows()
      : revokedRows().map(row => ({ ...row, revoked_at: '2026-09-06T00:00:00.000Z' }))
    await expect(revokedDuringRevoke.service.revokeAllSessions(revoked.session)).resolves.toBeUndefined()
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
    // `invalid`, e nao `not-found`: apresentar a ISCA que `/passkey/login/options`
    // devolve para quem nao tem chave dava 404, e apresentar um identificador
    // REAL dava 500 — as iscas disfarcavam uma rota e a rota irma desfazia o
    // disfarce, no mesmo processo.
    await expect(h.service.finishPasskeyLogin(unknown.challengeId, authResponse(), device)).rejects.toMatchObject({ code: 'invalid' })
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
    // A autoridade de confirmação de ações pergunta pela sessão de identidade,
    // não pela sessão do Harness: as duas leituras têm de concordar.
    const sessionId = h.repository.sessions()[0]!.session_id
    expect(h.service.strongIdentityForSession(sessionId)).toBe(true)
    expect(h.service.strongIdentityForSession('sessao-inexistente')).toBe(false)
    h.setNow('2026-09-02T12:05:00.000Z')
    expect(h.service.strongIdentityForHarnessSession('agent-strong')).toBe(false)
    expect(h.service.strongIdentityForSession(sessionId)).toBe(false)
    // Sessão revogada não é identidade forte, mesmo dentro da janela.
    h.setNow('2026-09-02T12:00:30.000Z')
    expect(h.service.strongIdentityForSession(sessionId)).toBe(true)
    await h.service.revokeSession(h.repository.sessions()[0]!, sessionId)
    expect(h.service.strongIdentityForSession(sessionId)).toBe(false)
  })

  it('does not recreate a session removed while a strong-identity ceremony is finishing', async () => {
    const h = makeHarness()
    const issued = await login(h)
    const registration = await h.service.beginPasskeyRegistration(issued.token)
    await h.service.finishPasskeyRegistration(issued.token, registration.challengeId, registrationResponse, 'Passkey')
    const stepUp = await h.service.beginStepUp(issued.token)
    const putCredential = h.repository.putCredential.bind(h.repository)
    h.repository.putCredential = async value => {
      await putCredential(value)
      h.repository.sessionMap.clear()
    }
    h.passkeys.counter = 2
    await expect(h.service.finishStepUp(issued.token, stepUp.challengeId, authResponse()))
      .rejects.toMatchObject({ code: 'invalid' })
    expect(h.repository.sessions()).toHaveLength(0)
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

  it('provisions invited identities from server-owned grants and exposes only usable principals', async () => {
    const h = makeHarness('closed')
    const provisioned: Array<{ user: IdentityUser; source: string }> = []
    const unsetEnrollment = h.service.setEnrollmentResolver(email => email === 'invited@example.com'
      ? { orgId: 'org-invite', tenantId: 'workspace-invite', role: 'builder' }
      : undefined)
    const unsetProvisioner = h.service.setUserProvisioner((user, source) => {
      provisioned.push({ user, source })
      return Promise.resolve()
    })
    expect(h.service.userRecords()).toEqual([])
    await h.service.sendInvitation({
      to: 'invited@example.com', token: 'secret', workspaceName: 'Produto', role: 'builder', expiresInHours: 72,
    })
    expect(h.email.invitations).toHaveLength(1)
    await h.service.requestMagicCode('invited@example.com')
    const issued = await h.service.verifyMagicCode('invited@example.com', '123456', device)
    const user = h.service.userForSession(issued.session)
    expect(user).toMatchObject({ org_id: 'org-invite', tenant_id: 'workspace-invite', bootstrap_owner: false })
    expect(provisioned).toEqual([{ user, source: 'invitation' }])
    await h.service.bindHarnessSession(issued.session, 'agent-invited')
    expect(h.service.principalForHarnessSession('agent-invited')).toMatchObject({ orgId: 'org-invite' })
    expect(h.service.principalForHarnessSession('missing')).toBeUndefined()
    h.repository.userMap.clear()
    expect(h.service.principalForHarnessSession('agent-invited')).toBeUndefined()
    await h.repository.putUser(user)
    h.setNow('2027-01-01T00:00:00.000Z')
    expect(h.service.principalForHarnessSession('agent-invited')).toBeUndefined()
    await h.service.recordAdministrationEvent(
      'invitation_accepted', user.user_id, user.org_id, user.tenant_id, 'Convite aceito.',
    )
    expect(h.service.auditRecords()).toContainEqual(expect.objectContaining({ event_type: 'invitation_accepted' }))
    unsetProvisioner()
    unsetEnrollment()
  })

})


describe('B-M6: o token CSRF pode ser trocado, e a elevação o troca', () => {
  it('a confirmação forte invalida o CSRF anterior sem derrubar a sessão', async () => {
    // O token CSRF era função DETERMINÍSTICA e imutável do token de sessão:
    // `GET /csrf` devolvia sempre o mesmo valor, e um vazamento pontual (log de
    // proxy, extensão, captura de tela) valia pelo resto da vida da sessão —
    // até 90 dias — inclusive DEPOIS da confirmação forte, que é justamente
    // quando a sessão passa a poder fazer o que é sensível.
    const h = makeHarness()
    const issued = await login(h)
    const registration = await h.service.beginPasskeyRegistration(issued.token)
    await h.service.finishPasskeyRegistration(issued.token, registration.challengeId, registrationResponse, 'Passkey')
    h.passkeys.counter = 2
    h.passkeys.userVerified = true

    const session = h.repository.sessions()[0]!
    // Sessão NOVA nasce com semente: o ramo sem semente é só para o que foi
    // gravado antes do campo existir.
    expect(session.csrf_seed, 'sessão nova sem semente').toBeDefined()
    const before = await h.service.csrfTokenFor(session)
    // Estável enquanto nada acontece: é assim que a tela funciona.
    expect(await h.service.csrfTokenFor(session)).toBe(before)

    const stepUp = await h.service.beginStepUp(issued.token)
    await h.service.finishStepUp(issued.token, stepUp.challengeId, authResponse())

    const rotated = h.repository.sessions()[0]!
    const after = await h.service.csrfTokenFor(rotated)
    expect(after).not.toBe(before)
    // E a sessão continua a MESMA: trocar o CSRF não é deslogar a pessoa.
    expect((await h.service.authenticate(issued.token)).session_id).toBe(session.session_id)
    // O valor antigo não confere mais com o que está gravado.
    expect(rotated.csrf_hash).not.toBe(session.csrf_hash)
  })
})

describe('ACHADO: a rota pública de chave de acesso não diz quem tem conta', () => {
  it('endereço DESCONHECIDO recebe uma resposta com a mesma forma de quem tem chave', async () => {
    // `POST /passkey/login/options` é rota PÚBLICA e respondia com
    // `allowCredentials` cheio para quem tem chave e VAZIO para quem não tem.
    // Enumeração de usuário a olho nu: o atacante anônimo descobre quem tem
    // conta — e, de quebra, recebia os `credential_id` REAIS, que são
    // identificadores estáveis do dispositivo. O caminho do código mágico foi
    // construído com esse cuidado (responde 202 idêntico nos dois casos); aqui
    // a propriedade tinha sido perdida.
    const h = makeHarness()
    const desconhecido = await h.service.beginPasskeyLogin('ninguem@example.com')
    expect(desconhecido.options.allowCredentials?.length ?? 0).toBeGreaterThan(0)
    expect(desconhecido.challengeId).toBeTruthy()
  })

  it('a resposta para o MESMO endereço desconhecido é estável', async () => {
    // Identificadores que mudassem a cada pergunta seriam o oráculo de volta:
    // um identificador real não muda.
    const h = makeHarness()
    const primeira = await h.service.beginPasskeyLogin('ninguem@example.com')
    const segunda = await h.service.beginPasskeyLogin(' Ninguem@Example.com ')
    expect(segunda.options.allowCredentials).toEqual(primeira.options.allowCredentials)
  })

  it('endereços desconhecidos DIFERENTES recebem identificadores diferentes', () => {
    // Um mesmo conjunto para todo endereço desconhecido seria reconhecível
    // depois de duas perguntas.
    const h = makeHarness()
    return Promise.all([
      h.service.beginPasskeyLogin('a@example.com'),
      h.service.beginPasskeyLogin('b@example.com'),
    ]).then(([a, b]) => {
      expect(a.options.allowCredentials).not.toEqual(b.options.allowCredentials)
    })
  })
})

describe('ACHADO: "sair de todos os dispositivos" alcança a sessão que nasceu no meio', () => {
  it('uma sessão emitida DURANTE a revogação também cai', async () => {
    // A versão anterior tirava a foto das sessões ativas FORA de qualquer
    // trava e revogava só aquelas. Uma sessão emitida entre a foto e as
    // escritas sobrevivia ao botão "sair de todos os dispositivos" — que é
    // exatamente o botão que a pessoa aperta quando desconfia de invasão, e
    // exatamente a sessão que ela quer derrubar.
    const h = makeHarness()
    const primeira = await login(h)
    let emitidaNoMeio: Awaited<ReturnType<typeof login>> | undefined
    const original = h.repository.putSession.bind(h.repository)
    let interceptado = false
    h.repository.putSession = async record => {
      await original(record)
      if (!interceptado && record.revoked_at !== null) {
        interceptado = true
        // MESMA pessoa: `revokeAllSessions` filtra por `user_id`, e uma
        // sessão de outro usuário não exercitaria nada.
        emitidaNoMeio = await login(h)
      }
    }
    await h.service.revokeAllSessions(primeira.session)
    h.repository.putSession = original

    expect(emitidaNoMeio).toBeDefined()
    const sobrevivente = h.repository.sessionMap.get(emitidaNoMeio!.session.session_id)
    expect(sobrevivente?.revoked_at).not.toBeNull()
  })

  it('o caso normal continua encerrando todas', async () => {
    const h = makeHarness()
    const issued = await login(h)
    await h.service.revokeAllSessions(issued.session)
    expect([...h.repository.sessionMap.values()].every(session => session.revoked_at !== null)).toBe(true)
  })
})

describe('ACHADO: pedir código não conta pelo RELÓGIO quem tem conta', () => {
  it('uma falha de envio NÃO sobe: ela é registrada, e a resposta continua igual', async () => {
    // Dois oráculos na mesma linha. O corpo da resposta já era idêntico nos
    // dois casos — 202 para quem tem conta e para quem não tem, com o
    // resultado descartado de propósito na rota. Mas o RELÓGIO entregava a
    // mesma informação: o ramo suprimido faz UMA escrita e volta, e este
    // esperava o SMTP, que em produção é síncrono e custa dezenas a centenas
    // de milissegundos.
    //
    // E uma falha de envio era o segundo, pior: ela SUBIA, e a rota respondia
    // com um status diferente de 202 — só para quem tem conta.
    const h = makeHarness()
    h.email.sendMagicCode = () => Promise.reject(new Error('smtp fora do ar'))
    await expect(h.service.requestMagicCode('owner@example.com')).resolves.toBe('sent')
    // O registro chega depois do envio falhar; esperar o laço de microtarefas
    // é o suficiente porque o dublê rejeita de imediato.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.service.auditRecords().map(record => record.event_type)).toContain('magic_code_send_failed')
  })

  it('o envio não segura o retorno de quem pediu', async () => {
    // Se o retorno esperasse o envio, o tempo voltaria a contar quem tem conta.
    const h = makeHarness()
    let liberar!: () => void
    h.email.sendMagicCode = () => new Promise<void>(resolve => { liberar = resolve })
    await expect(h.service.requestMagicCode('owner@example.com')).resolves.toBe('sent')
    liberar()
  })
})

/**
 * OS-90 — o par `/magic/start` + `/magic/verify` não responde "essa pessoa tem
 * conta aqui?".
 *
 * A OS-33 igualou o CORPO e o RELÓGIO de `/magic/start`. O pedido seguinte
 * desfazia isso com um status HTTP, e o teste que existia **congelava** a
 * diferença em vez de pegá-la.
 */
describe('ACHADO: a conferência do código não conta quem tem conta', () => {
  const desconhecido = 'ninguem@example.com'
  const conhecido = 'a@b.com'

  it('quem NÃO existe e quem ERROU o código recebem a mesma recusa', async () => {
    const h = makeHarness('closed')
    // Com o cadastro fechado, pedir código para quem não existe é suprimido e
    // NENHUM registro é gravado — que era exatamente a origem do 404.
    expect(await h.service.requestMagicCode(desconhecido)).toBe('suppressed')
    const semConta = await h.service.verifyMagicCode(desconhecido, '000000', device).catch((error: unknown) => error)
    expect(semConta).toMatchObject({ code: 'invalid' })
  })

  it('a TRAVA também não conta: quem não existe percorre a mesma escada e trava igual', async () => {
    const h = makeHarness('closed')
    // Enquanto o teto era por REGISTRO, quem não tem registro nunca travava —
    // e aí bastava errar seis vezes para separar quem existe de quem não.
    for (let tentativa = 1; tentativa <= 5; tentativa += 1) {
      await expect(h.service.verifyMagicCode(desconhecido, '000000', device)).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(h.service.verifyMagicCode(desconhecido, '000000', device)).rejects.toMatchObject({ code: 'locked' })
  })

  it('pedir um código NOVO não zera o teto: cinco palpites não viram vinte e cinco', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode(conhecido)
    for (let tentativa = 1; tentativa <= 5; tentativa += 1) {
      await h.service.verifyMagicCode(conhecido, '000000', device).catch(() => undefined)
    }
    // O registro novo nasce com `attempts: 0`; a escada por E-MAIL não nasce.
    await h.service.requestMagicCode(conhecido)
    await expect(h.service.verifyMagicCode(conhecido, '000000', device)).rejects.toMatchObject({ code: 'locked' })
  })

  it('a trava PASSA sozinha: uma trava que não passa é um jeito de manter alguém de fora', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode(conhecido)
    for (let tentativa = 1; tentativa <= 5; tentativa += 1) {
      await h.service.verifyMagicCode(conhecido, '000000', device).catch(() => undefined)
    }
    await expect(h.service.verifyMagicCode(conhecido, '123456', device)).rejects.toMatchObject({ code: 'locked' })
    h.setNow('2026-09-02T12:16:00.000Z')
    await h.service.requestMagicCode(conhecido)
    await expect(h.service.verifyMagicCode(conhecido, '123456', device)).resolves.toMatchObject({ session: expect.anything() as unknown })
  })

  it('entrar zera a escada: quem acabou de provar quem é não fica travado pelos erros de antes', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode(conhecido)
    for (let tentativa = 1; tentativa <= 4; tentativa += 1) {
      await h.service.verifyMagicCode(conhecido, '000000', device).catch(() => undefined)
    }
    await h.service.verifyMagicCode(conhecido, '123456', device)
    await h.service.requestMagicCode(conhecido)
    // Mais UM erro depois da entrada. Sem zerar, ele seria o quinto da escada
    // antiga e a tentativa seguinte estaria travada; zerando, ele é o primeiro.
    await expect(h.service.verifyMagicCode(conhecido, '000000', device)).rejects.toMatchObject({ code: 'invalid' })
    await expect(h.service.verifyMagicCode(conhecido, '000000', device)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('sem confiança declarada, MUDAR estado é recusado — e LER continua passando', () => {
    // Esta é a única conferência de `Host`/`Origin` das mutações autenticadas de
    // TODOS os outros plugins. Ela devolvia `void` quando a borda não tinha
    // declarado nada, deixando o cabeçalho `x-dz23-csrf` como única defesa — a
    // propriedade de navegador que este mesmo arquivo diz não querer sozinha.
    // O critério não é novo: `#secureCookies` já começa no lado seguro, dez
    // linhas acima, com a razão escrita.
    const h = makeHarness()
    expect(h.service.requestTrustConfigured).toBe(false)
    expect(() => h.service.assertRequestTrust('studio.example', 'https://studio.example', true)).toThrow(IdentityError)
    // Recusar LEITURA numa montagem não declarada derruba o produto inteiro
    // para consertar uma folga de escrita.
    expect(() => h.service.assertRequestTrust('studio.example', undefined, false)).not.toThrow()
    h.service.setRequestTrust({ allowedHosts: ['studio.example'], allowedOrigins: ['https://studio.example'] })
    expect(() => h.service.assertRequestTrust('studio.example', 'https://studio.example', true)).not.toThrow()
  })

  it('a lista de dispositivos não entrega nada que ajude a forjar a sessão', async () => {
    const h = makeHarness()
    await h.service.requestMagicCode(conhecido)
    const issued = await h.service.verifyMagicCode(conhecido, '123456', device)
    const dispositivos = h.service.listDevices(issued.session.user_id)
    expect(dispositivos.length).toBe(1)
    // A lista de campos privados é a autoridade: um campo novo do registro tem
    // de ser acrescentado A ELA para sair, e não ficar de fora dela para sair.
    for (const campo of CAMPOS_PRIVADOS_DA_SESSAO) expect(dispositivos[0]).not.toHaveProperty(campo)
    expect(CAMPOS_PRIVADOS_DA_SESSAO).toContain('csrf_seed')
    // …e o que a tela precisa continua vindo.
    expect(dispositivos[0]).toMatchObject({ session_id: issued.session.session_id })
  })
})

describe('a sessao sintetica do modo pessoal', () => {
  /*
    O ENDEREÇO PADRÃO É O QUE FECHA A PORTA, e isto tem caso porque a sabotagem
    que o trocava por `127.0.0.1` sobreviveu a tudo.

    `personalSession()` é chamada de dentro de `authenticatedMutation`, que
    recebe o pedido e o serviço — nunca o perfil. O endereço, então, é
    declarado na montagem por `setBindHost`. Uma instalação que ESQUEÇA de
    declará-lo não pode ganhar a porta larga por omissão: ela ganha a estreita,
    e alguém descobre o esquecimento tendo de entrar, e não servindo o produto
    inteiro a quem alcançar a porta.
  */
  it('sem `setBindHost`, NAO ha sessao pessoal — nem com ninguem registrado', () => {
    const { service } = makeHarness()
    expect(service.personalSession()).toBeUndefined()
  })

  it('declarado o endereco local, a sessao pessoal existe e e sintetica', () => {
    const { service } = makeHarness()
    service.setBindHost('127.0.0.1')
    const sessao = service.personalSession()
    expect(sessao?.user_id).toBe('user_local')
    expect(sessao?.session_id).toBe('session_local')
    // Sem segredo nenhum: os campos de hash existem porque o esquema os exige.
    expect(sessao?.token_hash).toBe('0'.repeat(64))
    expect(sessao?.csrf_hash).toBe('0'.repeat(64))
  })

  it('declarado o endereco aberto, a porta continua fechada', () => {
    const { service } = makeHarness()
    service.setBindHost('0.0.0.0')
    expect(service.personalSession()).toBeUndefined()
  })
  it('ehSessaoPessoal reconhece SO a sessao sintetica deste momento', () => {
    const { service } = makeHarness()
    service.setBindHost('127.0.0.1')
    const sessao = service.personalSession()!
    expect(service.ehSessaoPessoal(sessao)).toBe(true)
    expect(service.ehSessaoPessoal({ ...sessao, token_hash: 'a'.repeat(64) })).toBe(false)
    expect(service.ehSessaoPessoal({ ...sessao, tenant_id: 'outro' })).toBe(false)
    service.setBindHost('0.0.0.0')
    expect(service.ehSessaoPessoal(sessao)).toBe(false)
  })

  it('a sessao pessoal vincula e reconhece a PROPRIA conversa, em memoria', async () => {
    const { service } = makeHarness()
    service.setBindHost('127.0.0.1')
    const sessao = service.personalSession()!
    expect(service.ownsHarnessSession(sessao, 'conversa-1')).toBe(false)
    await service.bindHarnessSession(sessao, 'conversa-1')
    expect(service.ownsHarnessSession(sessao, 'conversa-1')).toBe(true)
    expect(service.ownsHarnessSession(sessao, 'conversa-2')).toBe(false)
    // Outra sessao (gravada) nao herda a conversa pessoal.
    expect(service.ownsHarnessSession({ ...sessao, token_hash: 'a'.repeat(64) }, 'conversa-1')).toBe(false)
    await service.releaseHarnessSession(sessao, 'conversa-1', 'fim')
    expect(service.ownsHarnessSession(sessao, 'conversa-1')).toBe(false)
  })
})

describe('a porta pessoal fecha quando existe gente', () => {
  /*
    A REGRA QUE NÃO PODE INVERTER: ausência de cookie NÃO escolhe modo pessoal.

    O modo pessoal é a instalação recém-baixada, presa ao endereço local, onde
    NÃO HÁ ninguém registrado — e por isso entrar não existe. No instante em que
    existe uma pessoa, entrar passa a ser a única porta, e a falta de cookie
    volta a ser recusa. Sem este caso, a porta que `ABRIR-02` abriu poderia
    virar, num conserto distraído, "sem cookie? então é pessoal" — que é a
    forma mais barata de servir o produto inteiro a quem alcançar o endereço.
  */
  it('com UMA pessoa registrada, nao ha sessao pessoal nem no endereco local', async () => {
    const h = makeHarness()
    h.service.setBindHost('127.0.0.1')
    expect(h.service.personalSession()).toBeDefined()
    await login(h)
    expect(h.service.personalSession()).toBeUndefined()
    expect(h.service.isPersonalMode('127.0.0.1')).toBe(false)
  })
})

describe('adotar o espaço pessoal no primeiro registro local', () => {
  it('mantém os identificadores que já são donos do trabalho pessoal', async () => {
    const h = makeHarness()
    h.service.setBindHost('127.0.0.1')
    const personal = h.service.personalSession()!
    const issued = await login(h)
    expect(issued.session).toMatchObject({ user_id: personal.user_id, org_id: personal.org_id, tenant_id: personal.tenant_id })
    expect(h.repository.users()[0]).toMatchObject({ user_id: 'user_local', bootstrap_owner: true, email: 'owner@example.com' })
    expect(h.service.personalSession()).toBeUndefined()
  })
  it('vincula o código ao espaço pessoal e não o usa depois de expor o servidor', async () => {
    const h = makeHarness()
    h.service.setBindHost('127.0.0.1')
    await h.service.requestMagicCode('owner@example.com')
    expect(h.repository.magicCodes()[0]).toMatchObject({ org_id: 'org_local', tenant_id: 'tenant_local' })
    h.service.setBindHost('0.0.0.0')
    await expect(h.service.verifyMagicCode('owner@example.com', '123456', device)).rejects.toMatchObject({ code: 'invalid' })
    expect(h.repository.users()).toHaveLength(0)
  })
  it('um convite de outro espaço não se torna dono do trabalho pessoal', async () => {
    const h = makeHarness()
    h.service.setBindHost('127.0.0.1')
    h.service.setEnrollmentResolver(() => ({ orgId: 'org-invited', tenantId: 'tenant-invited', role: 'builder' }))
    const issued = await login(h)
    expect(issued.session).toMatchObject({ org_id: 'org-invited', tenant_id: 'tenant-invited' })
    expect(issued.session.user_id).not.toBe('user_local')
    expect(h.repository.users()[0]?.bootstrap_owner).toBe(false)
  })
  it.each(['org_id', 'tenant_id'] as const)('recusa código com %s de outro espaço e registra a recusa', async field => {
    const h = makeHarness()
    h.service.setBindHost('127.0.0.1')
    await h.service.requestMagicCode('owner@example.com')
    const code = h.repository.magicCodes()[0]!
    await h.repository.putMagicCode({ ...code, [field]: 'outro-escopo' })
    await expect(h.service.verifyMagicCode('owner@example.com', '123456', device)).rejects.toMatchObject({ code: 'invalid' })
    expect(h.repository.users()).toHaveLength(0)
    expect(h.repository.sessions()).toHaveLength(0)
    expect(h.repository.audits().at(-1)).toMatchObject({ event_type: 'login_failed', outcome: 'failure' })
  })
})
