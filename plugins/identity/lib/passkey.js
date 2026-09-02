import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, } from '@simplewebauthn/server';
export class SimpleWebAuthnProvider {
    async registrationOptions(input) {
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
        });
    }
    async verifyRegistration(input) {
        const verification = await verifyRegistrationResponse({
            response: input.response,
            expectedChallenge: input.challengeMatches,
            expectedOrigin: input.expectedOrigin,
            expectedRPID: input.expectedRpId,
            requireUserVerification: false,
        });
        if (!verification.verified || verification.registrationInfo === undefined) {
            throw new Error('Não foi possível confirmar esta chave de acesso.');
        }
        const credential = verification.registrationInfo.credential;
        return {
            id: credential.id,
            publicKey: credential.publicKey,
            counter: credential.counter,
            transports: [...(credential.transports ?? [])],
        };
    }
    async authenticationOptions(input) {
        return generateAuthenticationOptions({
            rpID: input.rpId,
            allowCredentials: input.credentialIds.map(id => ({ id })),
            userVerification: input.requireUserVerification ? 'required' : 'preferred',
        });
    }
    async verifyAuthentication(input) {
        const verification = await verifyAuthenticationResponse({
            response: input.response,
            expectedChallenge: input.challengeMatches,
            expectedOrigin: input.expectedOrigin,
            expectedRPID: input.expectedRpId,
            credential: {
                id: input.credential.id,
                publicKey: Uint8Array.from(input.credential.publicKey),
                counter: input.credential.counter,
                transports: input.credential.transports,
            },
            requireUserVerification: input.requireUserVerification,
        });
        if (!verification.verified)
            throw new Error('Não foi possível confirmar esta chave de acesso.');
        return {
            newCounter: verification.authenticationInfo.newCounter,
            userVerified: verification.authenticationInfo.userVerified,
        };
    }
}
