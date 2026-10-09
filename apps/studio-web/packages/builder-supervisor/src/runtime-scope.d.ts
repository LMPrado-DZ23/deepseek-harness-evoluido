export declare const BUILDER_RUNTIME_SCOPE_DOMAIN = "com.dz23.studio.builder.runtime-scope";
export declare const BUILDER_RUNTIME_SCOPE_VERSION = 1;
export declare const BUILDER_UNIX_SOCKET_MAX_BYTES = 107;
export type BuilderRuntimeScopeId = `s_${string}`;
export interface BuilderRuntimeScopeInput {
    readonly installationId: string;
    readonly tenantId: string;
    readonly instanceId: string;
}
export declare function deriveBuilderRuntimeScopeId(input: BuilderRuntimeScopeInput): BuilderRuntimeScopeId;
export declare function isBuilderRuntimeScopeId(value: unknown): value is BuilderRuntimeScopeId;
export declare function builderRuntimeSocketPath(socketRoot: string, scopeId: BuilderRuntimeScopeId): string;
export declare function isInstallationId(value: unknown): value is string;
export declare function isRuntimeIdentifier(value: unknown): value is string;
//# sourceMappingURL=runtime-scope.d.ts.map