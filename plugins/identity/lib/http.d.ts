import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionRecord } from './model.js';
import { type StudioIdentityService } from './service.js';
import { InMemoryIdentityRateLimiter } from './rate-limit.js';
export declare const COOKIE_HEADER_LIMIT_BYTES: number;
export { CSRF_COOKIE, parseCookies, parseCookieValues, SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_GENERATION_COOKIE, sessionCookieName } from './cookies.js';
export declare const IDENTITY_ROUTE_CONTRACTS: readonly [{
    readonly method: "POST";
    readonly path: "/magic/start";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "POST";
    readonly path: "/magic/verify";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "POST";
    readonly path: "/passkey/login/options";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "POST";
    readonly path: "/passkey/login/verify";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "GET";
    readonly path: "/session";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "identity";
}, {
    readonly method: "GET";
    readonly path: "/csrf";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "GET";
    readonly path: "/harness/session";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/logout";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/register/options";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/register/verify";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/step-up/options";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/step-up/verify";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "GET";
    readonly path: "/devices";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/devices/revoke";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/devices/revoke-all";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}];
export interface IdentityHttpConfig {
    readonly service: StudioIdentityService;
    readonly bindHost: '127.0.0.1' | '0.0.0.0';
    readonly allowedHosts: readonly string[];
    readonly allowedOrigins: readonly string[];
    readonly edgeRequired?: boolean;
    readonly resolveEdgeSecret?: () => Promise<string | undefined>;
    readonly harnessAuthenticationUrl?: (baseUrl: string) => string | undefined;
    readonly rateLimiter?: InMemoryIdentityRateLimiter;
    readonly secureCookies?: boolean;
    readonly createSessionGeneration?: () => string;
}
export declare function serializeSessionCookies(token: string, csrfToken: string, secure?: boolean): readonly string[];
export declare function clearSessionCookies(secure?: boolean): readonly string[];
export declare function createIdentityHttpHandler(config: IdentityHttpConfig): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export declare function authenticatedMutation(request: IncomingMessage, service: StudioIdentityService): Promise<SessionRecord>;
export declare function requiredSessionToken(request: IncomingMessage, service: StudioIdentityService): string;
export declare function assertRequestTrust(request: IncomingMessage, config: Pick<IdentityHttpConfig, 'allowedHosts' | 'allowedOrigins'>): void;
export declare function singleHeader(value: string | string[] | undefined): string | undefined;
export declare function deviceOf(request: IncomingMessage, label: string): {
    label: string;
    userAgent: string;
    ipTruncated: string;
};
//# sourceMappingURL=http.d.ts.map