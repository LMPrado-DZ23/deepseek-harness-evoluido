import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
export type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]['response'];
export type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]['response'];
export type RegistrationOptions = Awaited<ReturnType<typeof generateRegistrationOptions>>;
export type AuthenticationOptions = Awaited<ReturnType<typeof generateAuthenticationOptions>>;
export interface StoredPasskey {
    readonly id: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly transports: string[];
}
export interface VerifiedRegistration {
    readonly id: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly transports: string[];
}
export interface VerifiedAuthentication {
    readonly newCounter: number;
    readonly userVerified: boolean;
}
export interface PasskeyProvider {
    registrationOptions(input: {
        readonly rpName: string;
        readonly rpId: string;
        readonly userId: string;
        readonly userName: string;
        readonly excludeCredentialIds: readonly string[];
    }): Promise<RegistrationOptions>;
    verifyRegistration(input: {
        readonly response: RegistrationResponse;
        readonly challengeMatches: (challenge: string) => boolean;
        readonly expectedOrigin: string;
        readonly expectedRpId: string;
    }): Promise<VerifiedRegistration>;
    authenticationOptions(input: {
        readonly rpId: string;
        readonly credentialIds: readonly string[];
        readonly requireUserVerification: boolean;
    }): Promise<AuthenticationOptions>;
    verifyAuthentication(input: {
        readonly response: AuthenticationResponse;
        readonly challengeMatches: (challenge: string) => boolean;
        readonly expectedOrigin: string;
        readonly expectedRpId: string;
        readonly credential: StoredPasskey;
        readonly requireUserVerification: boolean;
    }): Promise<VerifiedAuthentication>;
}
export declare class SimpleWebAuthnProvider implements PasskeyProvider {
    registrationOptions(input: Parameters<PasskeyProvider['registrationOptions']>[0]): Promise<RegistrationOptions>;
    verifyRegistration(input: Parameters<PasskeyProvider['verifyRegistration']>[0]): Promise<VerifiedRegistration>;
    authenticationOptions(input: Parameters<PasskeyProvider['authenticationOptions']>[0]): Promise<AuthenticationOptions>;
    verifyAuthentication(input: Parameters<PasskeyProvider['verifyAuthentication']>[0]): Promise<VerifiedAuthentication>;
}
//# sourceMappingURL=passkey.d.ts.map