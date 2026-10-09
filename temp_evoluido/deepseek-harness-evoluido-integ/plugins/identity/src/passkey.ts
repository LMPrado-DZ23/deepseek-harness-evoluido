import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import { t } from './i18n.js'

export type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]['response']
export type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]['response']
export type RegistrationOptions = Awaited<ReturnType<typeof generateRegistrationOptions>>
export type AuthenticationOptions = Awaited<ReturnType<typeof generateAuthenticationOptions>>

export interface StoredPasskey {
  readonly id: string
  readonly publicKey: Uint8Array
  readonly counter: number
  readonly transports: string[]
}

export interface VerifiedRegistration {
  readonly id: string
  readonly publicKey: Uint8Array
  readonly counter: number
  readonly transports: string[]
}

export interface VerifiedAuthentication {
  readonly newCounter: number
  readonly userVerified: boolean
}

export interface PasskeyProvider {
  registrationOptions(input: {
    readonly rpName: string
    readonly rpId: string
    readonly userId: string
    readonly userName: string
    readonly excludeCredentialIds: readonly string[]
  }): Promise<RegistrationOptions>
  verifyRegistration(input: {
    readonly response: RegistrationResponse
    readonly challengeMatches: (challenge: string) => boolean
    readonly expectedOrigin: string
    readonly expectedRpId: string
  }): Promise<VerifiedRegistration>
  authenticationOptions(input: {
    readonly rpId: string
    readonly credentialIds: readonly string[]
    readonly requireUserVerification: boolean
  }): Promise<AuthenticationOptions>
  verifyAuthentication(input: {
    readonly response: AuthenticationResponse
    readonly challengeMatches: (challenge: string) => boolean
    readonly expectedOrigin: string
    readonly expectedRpId: string
    readonly credential: StoredPasskey
    readonly requireUserVerification: boolean
  }): Promise<VerifiedAuthentication>
}

export class SimpleWebAuthnProvider implements PasskeyProvider {
  async registrationOptions(input: Parameters<PasskeyProvider['registrationOptions']>[0]): Promise<RegistrationOptions> {
    return generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userID: new TextEncoder().encode(input.userId),
      userName: input.userName,
      attestationType: 'none',
      excludeCredentials: input.excludeCredentialIds.map(id => ({ id })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    })
  }

  async verifyRegistration(input: Parameters<PasskeyProvider['verifyRegistration']>[0]): Promise<VerifiedRegistration> {
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.challengeMatches,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: false,
    })
    if (!verification.verified || verification.registrationInfo === undefined) {
      throw new Error(t('passkey.notConfirmed'))
    }
    const credential = verification.registrationInfo.credential
    return {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: [...(credential.transports ?? [])],
    }
  }

  async authenticationOptions(input: Parameters<PasskeyProvider['authenticationOptions']>[0]): Promise<AuthenticationOptions> {
    return generateAuthenticationOptions({
      rpID: input.rpId,
      allowCredentials: input.credentialIds.map(id => ({ id })),
      userVerification: input.requireUserVerification ? 'required' : 'preferred',
    })
  }

  async verifyAuthentication(input: Parameters<PasskeyProvider['verifyAuthentication']>[0]): Promise<VerifiedAuthentication> {
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.challengeMatches,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      credential: {
        id: input.credential.id,
        publicKey: Uint8Array.from(input.credential.publicKey),
        counter: input.credential.counter,
        transports: input.credential.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: input.requireUserVerification,
    })
    if (!verification.verified) throw new Error(t('passkey.notConfirmed'))
    return {
      newCounter: verification.authenticationInfo.newCounter,
      userVerified: verification.authenticationInfo.userVerified,
    }
  }
}
