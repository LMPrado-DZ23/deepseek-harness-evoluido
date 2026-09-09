import type { IncomingMessage } from 'node:http';
export type IdentityRateLimitBucket = 'global' | 'magic-start' | 'magic-verify' | 'passkey';
export interface IdentityRateLimitRule {
    readonly limit: number;
    readonly windowMs: number;
}
export interface IdentityRateLimitDecision {
    readonly allowed: boolean;
    readonly limit: number;
    readonly remaining: number;
    readonly retryAfterSeconds: number;
}
export declare const IDENTITY_RATE_LIMITS: Readonly<Record<IdentityRateLimitBucket, IdentityRateLimitRule>>;
/** Per-process limiter. A multi-instance deployment must replace this with a shared atomic store. */
export declare class InMemoryIdentityRateLimiter {
    #private;
    consume(bucket: IdentityRateLimitBucket, key: string, now?: number): IdentityRateLimitDecision;
}
export declare function rateLimitBuckets(route: string): readonly IdentityRateLimitBucket[];
/**
 * O endereço que a BORDA afirmou, num `X-Forwarded-For`.
 *
 * O primeiro elemento do cabeçalho é o que o CLIENTE mandou: um proxy
 * acrescenta o endereço observado ao final, não substitui o que veio. Ler o
 * primeiro elemento era, portanto, deixar o cliente escolher o próprio balde do
 * limitador — três valores forjados, três baldes distintos, e os limites de
 * `magic-start`, `magic-verify` e `passkey` viravam decoração.
 *
 * O ÚLTIMO elemento é o que a borda confiável escreveu, e é o único que um
 * cliente não consegue empurrar. (A borda do Studio também passou a
 * SUBSTITUIR o cabeçalho, em vez de acrescentar; isto aqui é a defesa que
 * sobrevive a uma borda reconfigurada.)
 * @param header - o valor bruto do cabeçalho, ou `undefined`.
 * @returns o endereço da borda, ou `undefined` quando não há nenhum utilizável.
 */
export declare function edgeForwardedAddress(header: string | undefined): string | undefined;
/** Stable pseudonymous key. Session ids must come from server-side authentication, never from an untrusted cookie. */
export declare function rateLimitKey(request: IncomingMessage, forwardedAddress?: string, authenticatedSessionId?: string): string;
//# sourceMappingURL=rate-limit.d.ts.map