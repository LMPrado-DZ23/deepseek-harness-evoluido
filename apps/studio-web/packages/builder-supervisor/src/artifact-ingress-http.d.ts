import type { ArtifactIngressPort } from './artifact-ingress.js';
export interface ArtifactIngressHttpInput {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal: AbortSignal;
}
export interface ArtifactIngressHttpOutput {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
}
export declare function createArtifactIngressHttpHandler(options: {
    readonly bearerToken: string;
    readonly ingress: ArtifactIngressPort;
    readonly idleTimeoutMs?: number;
    readonly totalTimeoutMs?: number;
}): {
    handle: (input: ArtifactIngressHttpInput) => Promise<ArtifactIngressHttpOutput>;
};
//# sourceMappingURL=artifact-ingress-http.d.ts.map