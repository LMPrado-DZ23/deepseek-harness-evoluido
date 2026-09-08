export type TlsPolicy = 'off' | 'require' | 'verify-full';
export declare const TLS_POLICIES: readonly TlsPolicy[];
export declare function assertTlsPolicy(value: string): TlsPolicy;
export interface PostgresTlsOptions {
    rejectUnauthorized: boolean;
    ca?: string;
    cert?: string;
    key?: string;
    passphrase?: string;
}
export interface PostgresClientConnection {
    /** DSN with every TLS parameter removed, so nothing in it can override the policy. */
    connectionString: string;
    /** The single TLS decision, already resolved. */
    ssl: false | PostgresTlsOptions;
}
/**
 * Connection settings for `pg`. The returned `connectionString` carries no TLS
 * parameter at all, so `ssl` here is the whole truth: `false` means plaintext,
 * `rejectUnauthorized: true` means the chain AND the host name are verified.
 * A CA or client certificate named in the DSN is still honoured — it is
 * material, not policy — and is read into the options instead of being left
 * for the connection string to reinterpret.
 */
export declare function postgresClientConnection(dsn: string, policy: TlsPolicy): Promise<PostgresClientConnection>;
/**
 * The DSN with every TLS parameter removed, for callers that already hold a
 * resolved `ssl` option object. Without this, `pg` lets the string override the
 * object and the caller's decision is not the one that reaches the socket.
 */
export declare function withoutTlsParams(dsn: string): string;
export interface PostgresToolConnection {
    /** Safe to put in `argv`: no password, no TLS parameter. */
    dsn: string;
    /** Everything secret or policy-bearing, for the child's environment only. */
    env: NodeJS.ProcessEnv;
}
export declare function postgresToolConnection(dsn: string, policy: TlsPolicy, base?: NodeJS.ProcessEnv): PostgresToolConnection;
//# sourceMappingURL=dsn.d.ts.map