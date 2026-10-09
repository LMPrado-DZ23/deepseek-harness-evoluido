import type { Server } from 'node:http';
import { type ArtifactIngressPort } from './artifact-ingress.js';
import { type DockerEnginePort } from './docker-engine.js';
import type { BuilderRpcMethods } from './protocol.js';
import { type BuilderSupervisorResolvedConfig, type BuilderSupervisorRootPolicy } from './supervisor-config.js';
import { listenBuilderUnix } from './unix-server.js';
export declare const BUILDER_SUPERVISOR_EXIT: Readonly<{
    ok: 0;
    usage: 64;
    startup: 70;
    shutdown: 74;
}>;
type SupervisorSignal = 'SIGINT' | 'SIGTERM';
export interface BuilderSupervisorSignalSource {
    on(signal: SupervisorSignal, listener: () => void): void;
    off(signal: SupervisorSignal, listener: () => void): void;
}
export interface BuilderSupervisorListener {
    readonly server: Pick<Server, 'close' | 'closeAllConnections' | 'closeIdleConnections'>;
    close(afterStopAccepting?: () => void): Promise<void>;
}
export interface BuilderSupervisorLifecycleMethods extends BuilderRpcMethods {
    initialize(signal: AbortSignal): Promise<void>;
}
export interface BuilderSupervisorComposition {
    readonly methods: BuilderSupervisorLifecycleMethods;
    readonly artifactIngress?: ArtifactIngressPort;
}
export interface BuilderSupervisorMainDependencies {
    readonly loadConfig: (reference: string, roots: BuilderSupervisorRootPolicy) => Promise<BuilderSupervisorResolvedConfig>;
    readonly compose: (config: BuilderSupervisorResolvedConfig) => BuilderSupervisorComposition;
    readonly listen: (options: Parameters<typeof listenBuilderUnix>[0]) => Promise<BuilderSupervisorListener>;
    readonly signals: BuilderSupervisorSignalSource;
    readonly error: (code: string) => void;
}
export declare function composeBuilderSupervisor(config: BuilderSupervisorResolvedConfig, engine?: DockerEnginePort): BuilderSupervisorComposition;
export declare function runBuilderSupervisorMain(options: {
    readonly configReference: string;
    readonly roots?: BuilderSupervisorRootPolicy;
    readonly dependencies?: Partial<BuilderSupervisorMainDependencies>;
}): Promise<number>;
export declare function executeBuilderSupervisorCli(argv: readonly string[], dependencies?: Partial<BuilderSupervisorMainDependencies>): Promise<number>;
export declare function applyBuilderSupervisorExitCode(execution: Promise<number>, target?: {
    exitCode?: string | number | null | undefined;
}): Promise<void>;
export {};
//# sourceMappingURL=supervisor-main.d.ts.map