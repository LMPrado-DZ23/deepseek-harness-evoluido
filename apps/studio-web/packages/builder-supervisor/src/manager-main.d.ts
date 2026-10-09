import { type GlobalBuilderCapacityPort } from './manager-capacity.js';
import { type BuilderRuntimeHealth, type BuilderRuntimeHealthPort } from './manager-health.js';
import { type BuilderRuntimeRegistry, type BuilderRuntimeRegistrySlot } from './manager-registry.js';
import { type BuilderManagerCheckpointPort, type BuilderManagerLeasePort } from './manager-state.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import { composeBuilderSupervisor, type BuilderSupervisorComposition, type BuilderSupervisorListener, type BuilderSupervisorSignalSource } from './supervisor-main.js';
import { loadPinnedBuilderSupervisorConfig, type BuilderSupervisorResolvedConfig, type BuilderSupervisorRootPolicy } from './supervisor-config.js';
import { listenBuilderUnix } from './unix-server.js';
import { type DockerEnginePort } from './docker-engine.js';
import { ensureTemplateStoreVolume } from './template-store-volume.js';
export declare const BUILDER_MANAGER_EXIT: Readonly<{
    ok: 0;
    usage: 64;
    startup: 70;
    shutdown: 74;
}>;
export declare const BUILDER_MANAGER_MAX_SLOTS = 512;
type ManagerSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';
export interface BuilderManagedRuntime {
    readonly scopeId: BuilderRuntimeScopeId;
    retire(timeoutMs: number): Promise<void>;
}
export interface BuilderRuntimeManagerSnapshot {
    readonly installationId: string | undefined;
    readonly generation: number;
    readonly activeScopes: readonly BuilderRuntimeScopeId[];
    readonly health: readonly BuilderRuntimeHealth[];
}
export interface BuilderRuntimeManagerDependencies {
    readonly loadRegistry: (reference: string, roots: BuilderSupervisorRootPolicy) => Promise<BuilderRuntimeRegistry>;
    readonly startSlot: (slot: BuilderRuntimeRegistrySlot, installationId: string, roots: BuilderSupervisorRootPolicy, capacity: GlobalBuilderCapacityPort, drainTimeoutMs: number, signal: AbortSignal, listenerInitializationTimeoutMs?: number) => Promise<BuilderManagedRuntime>;
    readonly health: BuilderRuntimeHealthPort;
    readonly lease: BuilderManagerLeasePort;
    readonly checkpoint: BuilderManagerCheckpointPort;
    readonly now: () => Date;
    readonly error: (code: string) => void;
}
export interface BuilderRuntimeSlotStartRuntime {
    readonly loadConfig: typeof loadPinnedBuilderSupervisorConfig;
    readonly createEngine: (config: BuilderSupervisorResolvedConfig) => DockerEnginePort;
    readonly ensureTemplateStore: typeof ensureTemplateStoreVolume;
    readonly compose: typeof composeBuilderSupervisor;
    readonly listen: (options: Parameters<typeof listenBuilderUnix>[0]) => Promise<BuilderSupervisorListener>;
    readonly scheduleTimeout: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
    readonly clearScheduledTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}
export declare class BuilderRuntimeManager {
    #private;
    private readonly options;
    constructor(options: {
        readonly registryReference: string;
        readonly roots: BuilderSupervisorRootPolicy;
        readonly drainTimeoutMs: number;
        readonly reloadTimeoutMs: number;
        readonly slotStartupTimeoutMs?: number;
        readonly listenerInitializationTimeoutMs?: number;
        readonly maximumGlobalBuilds: number;
        readonly dependencies: BuilderRuntimeManagerDependencies;
    });
    snapshot(): BuilderRuntimeManagerSnapshot;
    initialize(): Promise<void>;
    requestReload(): Promise<void>;
    shutdown(): Promise<void>;
}
export interface BuilderRuntimeManagerSignalSource extends BuilderSupervisorSignalSource {
    on(signal: ManagerSignal, listener: () => void): void;
    off(signal: ManagerSignal, listener: () => void): void;
}
export interface BuilderRuntimeManagerRuntime {
    readonly signals: BuilderRuntimeManagerSignalSource;
    readonly setInterval: typeof setInterval;
    readonly clearInterval: typeof clearInterval;
}
export declare function runBuilderRuntimeManager(options: {
    readonly registryReference: string;
    readonly roots?: BuilderSupervisorRootPolicy;
    readonly pollIntervalMs?: number;
    readonly reloadTimeoutMs?: number;
    readonly slotStartupTimeoutMs?: number;
    readonly listenerInitializationTimeoutMs?: number;
    readonly drainTimeoutMs?: number;
    readonly maximumGlobalBuilds?: number;
    readonly dependencies?: Partial<BuilderRuntimeManagerDependencies>;
    readonly runtime?: BuilderRuntimeManagerRuntime;
}): Promise<number>;
/**
 * Os argumentos do gerente, ou `undefined` quando eles não servem.
 *
 * `--roots-base` existe porque o gerente só sabia as raízes de PRODUÇÃO
 * (`/etc`, `/var/lib`, `/run`), e o instalador — que prepara uma instalação
 * pessoal sob a pasta de dados, sem root — o iniciava com o registro gravado
 * lá: o registro não batia com as raízes de produção e o gerente morria em
 * `INVALID_RUNTIME_REGISTRY`. Medido em 19/09/2026, na primeira instalação
 * real. As raízes saem da MESMA função que o instalador usa
 * (`raizesDoConstrutorEm`), e passam pela mesma validação de sempre.
 * @param argv - os argumentos.
 * @returns o registro e, quando pedidas, as raízes.
 */
export declare function argumentosDoGerente(argv: readonly string[]): {
    readonly registryReference: string;
    readonly roots?: BuilderSupervisorRootPolicy;
} | undefined;
export declare function executeBuilderRuntimeManagerCli(argv: readonly string[], run?: typeof runBuilderRuntimeManager): Promise<number>;
export declare function createBuilderRuntimeSlotStarter(runtime?: BuilderRuntimeSlotStartRuntime): BuilderRuntimeManagerDependencies['startSlot'];
export declare function wrapBuilderSupervisorWithGlobalCapacity(scopeId: BuilderRuntimeScopeId, composition: BuilderSupervisorComposition, capacity: GlobalBuilderCapacityPort, 
/** Só para teste: o relógio que decide o vencimento de uma vaga reservada. */
now?: () => number): BuilderSupervisorComposition & {
    releaseAll(): void;
};
declare function createBuilderDockerEngine(config: BuilderSupervisorResolvedConfig): DockerEnginePort;
export declare const BUILDER_MANAGER_TEST_ONLY: Readonly<{
    createBuilderDockerEngine: typeof createBuilderDockerEngine;
}>;
export {};
//# sourceMappingURL=manager-main.d.ts.map