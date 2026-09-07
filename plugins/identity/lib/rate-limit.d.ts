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
/** Stable pseudonymous key. Session ids must come from server-side authentication, never from an untrusted cookie. */
export declare function rateLimitKey(request: IncomingMessage, forwardedAddress?: string, authenticatedSessionId?: string): string;
//# sourceMappingURL=rate-limit.d.ts.map