import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  sendMail,
  createTransport,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = vi.hoisted(() => {
  const hoistedSendMail = vi.fn(() => Promise.resolve({ messageId: 'mail-1' }))
  return {
    sendMail: hoistedSendMail,
    createTransport: vi.fn(() => ({ sendMail: hoistedSendMail })),
    generateRegistrationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  }
})

vi.mock('nodemailer', () => ({ default: { createTransport } }))
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
}))

import { newMagicCode, newOpaqueSecret, secretHash, secretMatches, truncateIp } from '../src/crypto.ts'
import { MemoryEmailSender, SmtpEmailSender } from '../src/email.ts'
import {
  identityAuditDomainSpec,
  identityAuditRecordSchema,
  identityCredentialsDomainSpec,
  identitySessionsDomainSpec,
  identityUsersDomainSpec,
  identityUserSchema,
  passkeyCredentialSchema,
  sessionRecordSchema,
} from '../src/model.ts'
import { SimpleWebAuthnProvider, type AuthenticationResponse, type RegistrationResponse } from '../src/passkey.ts'

describe('identity primitives and schemas', () => {
  it('hashes and compares secrets without storing their plaintext', () => {
    const hash = secretHash('secret')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(secretMatches('secret', hash)).toBe(true)
    expect(secretMatches('other', hash)).toBe(false)
    expect(secretMatches('secret', '00')).toBe(false)
    expect(newOpaqueSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newMagicCode()).toMatch(/^\d{6}$/)
  })

  it('truncates IP addresses and rejects untrusted text', () => {
    expect(truncateIp(undefined)).toBe('unknown')
    expect(truncateIp('   ')).toBe('unknown')
    expect(truncateIp('192.168.4.99, 10.0.0.1')).toBe('192.168.4.0/24')
    expect(truncateIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
    expect(truncateIp('not-an-ip')).toBe('invalid')
  })

  it('loads typed domains and rejects malformed records', () => {
    expect([
      identityUsersDomainSpec.name,
      identityCredentialsDomainSpec.name,
      identitySessionsDomainSpec.name,
      identityAuditDomainSpec.name,
    ]).toEqual([
      'studio_identity_users', 'studio_identity_credentials', 'studio_identity_sessions', 'studio_identity_audit',
    ])
    expect(() => identityUserSchema.parse({})).toThrow()
    expect(identityUserSchema.parse({
      user_id: 'legacy-user', email: 'legacy@example.com', display_name: 'Legacy',
      role: 'owner', org_id: 'org', tenant_id: 'tenant', created_at: '2026-09-02T00:00:00.000Z',
    })).toEqual({
      user_id: 'legacy-user', email: 'legacy@example.com', display_name: 'Legacy',
      org_id: 'org', tenant_id: 'tenant', created_at: '2026-09-02T00:00:00.000Z',
    })
    expect(() => passkeyCredentialSchema.parse({})).toThrow()
    expect(() => sessionRecordSchema.parse({})).toThrow()
    expect(() => identityAuditRecordSchema.parse({})).toThrow()
  })
})

describe('email adapters', () => {
  beforeEach(() => {
    createTransport.mockClear()
    sendMail.mockClear()
  })

  it('captures development email only in memory', async () => {
    const sender = new MemoryEmailSender()
    const message = { to: 'a@example.com', code: '123456', expiresInMinutes: 10 }
    await sender.sendMagicCode(message)
    expect(sender.messages).toEqual([message])
    expect(sender.messages[0]).not.toBe(message)
    await sender.sendInvitation({
      to: 'b@example.com', token: 'invite-token', workspaceName: 'Produto', role: 'builder', expiresInHours: 72,
    })
    expect(sender.invitations).toEqual([expect.objectContaining({ to: 'b@example.com', role: 'builder' })])
  })

  it('resolves SMTP configuration for each send and does not cache secrets', async () => {
    const resolve = vi.fn(() => Promise.resolve({
      value: JSON.stringify({ host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p', from: 'DZ23 <noreply@example.com>' }),
      source: 'file',
    }))
    const credentials = { resolve } as unknown as CredentialProvider
    const sender = new SmtpEmailSender(credentials, 'DZ23_SMTP' as CredentialRef)
    await sender.sendMagicCode({ to: 'a@example.com', code: '654321', expiresInMinutes: 10 })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'u', pass: 'p' },
    })
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com', subject: expect.stringContaining('FRIGG') }))
    await sender.sendInvitation({
      to: 'b@example.com', token: 'invite-token', workspaceName: 'Produto', role: 'viewer', expiresInHours: 72,
    })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'b@example.com', subject: expect.stringContaining('Produto') }))
  })

  it('fails closed when SMTP secret is absent or malformed', async () => {
    const absent = { resolve: () => Promise.resolve(undefined) } as unknown as CredentialProvider
    await expect(new SmtpEmailSender(absent, 'DZ23_SMTP' as CredentialRef)
      .sendMagicCode({ to: 'a@example.com', code: '123456', expiresInMinutes: 10 })).rejects.toThrow(/não foi configurado/)
    const badJson = { resolve: () => Promise.resolve({ value: '{', source: 'file' }) } as unknown as CredentialProvider
    await expect(new SmtpEmailSender(badJson, 'DZ23_SMTP' as CredentialRef)
      .sendMagicCode({ to: 'a@example.com', code: '123456', expiresInMinutes: 10 })).rejects.toThrow(/inválida/)
    const badShape = { resolve: () => Promise.resolve({ value: '{}', source: 'file' }) } as unknown as CredentialProvider
    await expect(new SmtpEmailSender(badShape, 'DZ23_SMTP' as CredentialRef)
      .sendMagicCode({ to: 'a@example.com', code: '123456', expiresInMinutes: 10 })).rejects.toThrow()
  })
})

describe('SimpleWebAuthnProvider', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates registration options and maps a verified credential', async () => {
    generateRegistrationOptions.mockResolvedValue({ challenge: 'registration-challenge' })
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: 'cred', publicKey: Uint8Array.from([1]), counter: 4 } },
    })
    const provider = new SimpleWebAuthnProvider()
    await expect(provider.registrationOptions({
      rpName: 'DZ23', rpId: 'localhost', userId: 'user', userName: 'u@example.com', excludeCredentialIds: ['old'],
    })).resolves.toEqual({ challenge: 'registration-challenge' })
    await expect(provider.verifyRegistration({
      response: {} as RegistrationResponse,
      challengeMatches: () => true,
      expectedOrigin: 'https://localhost',
      expectedRpId: 'localhost',
    })).resolves.toEqual({ id: 'cred', publicKey: Uint8Array.from([1]), counter: 4, transports: [] })
  })

  it('rejects an unverified registration and preserves transports', async () => {
    verifyRegistrationResponse.mockResolvedValueOnce({ verified: false })
    const provider = new SimpleWebAuthnProvider()
    await expect(provider.verifyRegistration({
      response: {} as RegistrationResponse, challengeMatches: () => true,
      expectedOrigin: 'https://localhost', expectedRpId: 'localhost',
    })).rejects.toThrow(/confirmar/)
    verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: 'cred', publicKey: Uint8Array.from([2]), counter: 0, transports: ['usb'] } },
    })
    await expect(provider.verifyRegistration({
      response: {} as RegistrationResponse, challengeMatches: () => true,
      expectedOrigin: 'https://localhost', expectedRpId: 'localhost',
    })).resolves.toMatchObject({ transports: ['usb'] })
  })

  it('creates normal and step-up authentication options and maps verification', async () => {
    generateAuthenticationOptions.mockImplementation((input: unknown) => Promise.resolve(input))
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 7, userVerified: true },
    })
    const provider = new SimpleWebAuthnProvider()
    await provider.authenticationOptions({ rpId: 'localhost', credentialIds: ['cred'], requireUserVerification: false })
    await provider.authenticationOptions({ rpId: 'localhost', credentialIds: ['cred'], requireUserVerification: true })
    expect(generateAuthenticationOptions.mock.calls.map(call => call[0].userVerification)).toEqual(['preferred', 'required'])
    await expect(provider.verifyAuthentication({
      response: {} as AuthenticationResponse,
      challengeMatches: () => true,
      expectedOrigin: 'https://localhost',
      expectedRpId: 'localhost',
      credential: { id: 'cred', publicKey: Uint8Array.from([1]), counter: 6, transports: ['internal'] },
      requireUserVerification: true,
    })).resolves.toEqual({ newCounter: 7, userVerified: true })
    verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false })
    await expect(provider.verifyAuthentication({
      response: {} as AuthenticationResponse,
      challengeMatches: () => true,
      expectedOrigin: 'https://localhost', expectedRpId: 'localhost',
      credential: { id: 'cred', publicKey: Uint8Array.from([1]), counter: 6, transports: [] },
      requireUserVerification: false,
    })).rejects.toThrow(/confirmar/)
  })
})
