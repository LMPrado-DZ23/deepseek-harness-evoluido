export declare const SESSION_COOKIE = "dz23_studio_session";
/** Legacy marker expired on logout; clients no longer read cookies for login generation. */
export declare const SESSION_GENERATION_COOKIE = "dz23_studio_session_generation";
/** Legacy name retained only so existing client cookies can be expired. */
export declare const CSRF_COOKIE = "dz23_studio_csrf";
export declare function parseCookieValues(header: string | undefined, name: string): readonly string[];
export declare function parseCookies(header: string | undefined): Readonly<Record<string, string>>;
//# sourceMappingURL=cookies.d.ts.map