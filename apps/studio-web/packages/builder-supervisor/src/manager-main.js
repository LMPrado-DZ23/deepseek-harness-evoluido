import { posix } from 'node:path';
import { FairGlobalBuilderCapacity } from './manager-capacity.js';
import { FileBuilderRuntimeHealthStore, runtimeHealth, sanitizeRuntimeHealthCode, } from './manager-health.js';
import { BuilderRuntimeRegistryError, loadBuilderRuntimeRegistry, } from './manager-registry.js';
import { FileBuilderManagerAuthority, } from './manager-state.js';
import { isBuilderRuntimeScopeId, isInstallationId } from './runtime-scope.js';
import { composeBuilderSupervisor, } from './supervisor-main.js';
import { loadPinnedBuilderSupervisorConfig, PRODUCTION_BUILDER_ROOT_POLICY, validateBuilderSupervisorRootPolicy, } from './supervisor-config.js';
import { listenBuilderUnix } from './unix-server.js';
import { raizesDoConstrutorEm } from './installer.js';
import { DEFAULT_SLOT_STARTUP_TIMEOUT_MS } from './manager-timeouts.js';
import { isTerminalState } from './model.js';
import { DockerEngine } from './docker-engine.js';
import { ensureTemplateStoreVolume } from './template-store-volume.js';
export const BUILDER_MANAGER_EXIT = Object.freeze({ ok: 0, usage: 64, startup: 70, shutdown: 74 });
export const BUILDER_MANAGER_MAX_SLOTS = 512;
const DEFAULT_LISTENER_INITIALIZATION_TIMEOUT_MS = 30_000;
/**
 * Por quanto tempo uma vaga global reservada por `prepare` continua valendo
 * sem nenhum sinal de vida daquele build.
 *
 * Uma hora, e e generoso de proposito: este prazo NAO existe para disciplinar
 * build lento — existe para que trabalho ABANDONADO nao segure a vaga para
 * sempre. Um build vivo renova o prazo a cada chamada; um cliente que sumiu
 * nao renova nada.
 */
const HELD_SLOT_TTL_MS = 60 * 60_000;
/**
 * O registro de vagas seguradas, COMPARTILHADO por quem divide a capacidade.
 *
 * `WeakMap` para o registro morrer junto com a capacidade: um mapa global por
 * nome vazaria entre instalacoes dentro do mesmo processo, que e justamente o
 * tipo de acoplamento que este arquivo evita em todo o resto.
 */
const HELD_SLOTS = new WeakMap();
function heldSlotsFor(capacity) {
    const existing = HELD_SLOTS.get(capacity);
    if (existing !== undefined)
        return existing;
    const created = new Set();
    HELD_SLOTS.set(capacity, created);
    return created;
}
const DEFAULT_SLOT_START_RUNTIME = {
    loadConfig: loadPinnedBuilderSupervisorConfig,
    createEngine: createBuilderDockerEngine,
    ensureTemplateStore: ensureTemplateStoreVolume,
    compose: composeBuilderSupervisor,
    listen: listenBuilderUnix,
    scheduleTimeout: setTimeout,
    clearScheduledTimeout: clearTimeout,
};
class RuntimeCleanupIncomplete extends Error {
}
export class BuilderRuntimeManager {
    options;
    #runtimes = new Map();
    #health = new Map();
    #acceptedSlots = new Map();
    #uncertainStarts = new Set();
    #capacity;
    #installationId;
    #generation = -1;
    #registrySha256;
    #reloadPending = false;
    #reloadExecution;
    #stopped = false;
    #lease;
    #checkpointLoaded = false;
    #initialized = false;
    constructor(options) {
        this.options = options;
        if (![options.drainTimeoutMs, options.reloadTimeoutMs, options.slotStartupTimeoutMs ?? DEFAULT_SLOT_STARTUP_TIMEOUT_MS, options.listenerInitializationTimeoutMs ?? DEFAULT_LISTENER_INITIALIZATION_TIMEOUT_MS, options.maximumGlobalBuilds].every(value => Number.isSafeInteger(value) && value > 0))
            throw new BuilderRuntimeRegistryError();
        this.#capacity = new FairGlobalBuilderCapacity(options.maximumGlobalBuilds);
    }
    snapshot() {
        return {
            installationId: this.#installationId,
            generation: this.#generation,
            activeScopes: [...this.#runtimes.keys()].filter(scopeId => this.#health.get(scopeId)?.state === 'HEALTHY').sort(),
            health: [...this.#health.values()].sort((left, right) => left.scope_id.localeCompare(right.scope_id)),
        };
    }
    async initialize() {
        if (this.#initialized)
            return;
        const execution = this.#reloadExecution ?? this.#reload();
        this.#reloadExecution = execution;
        try {
            await execution;
            this.#initialized = true;
        }
        catch (error) {
            this.#reloadPending = false;
            this.#abortUncertainStarts('MANAGER_INITIALIZATION_FAILED');
            const cleanup = await this.#cleanupOwnedWork();
            if (cleanup)
                await this.#releaseLease();
            throw error;
        }
        finally {
            this.#reloadExecution = undefined;
        }
    }
    requestReload() {
        if (this.#stopped)
            return Promise.resolve();
        if (!this.#initialized)
            return Promise.reject(new Error('MANAGER_NOT_INITIALIZED'));
        this.#reloadPending = true;
        this.#reloadExecution ??= this.#drainReloadRequests();
        return this.#reloadExecution;
    }
    async shutdown() {
        this.#stopped = true;
        this.#abortUncertainStarts('MANAGER_SHUTDOWN');
        await this.#reloadExecution?.catch(() => undefined);
        if (!await this.#cleanupOwnedWork())
            throw new Error('MANAGER_SHUTDOWN_FAILED');
        await this.#releaseLease();
    }
    async #drainReloadRequests() {
        try {
            while (this.#reloadPending && !this.#stopped) {
                this.#reloadPending = false;
                try {
                    await this.#reload();
                }
                catch {
                    this.options.dependencies.error('REGISTRY_RELOAD_FAILED');
                }
            }
        }
        finally {
            this.#reloadExecution = undefined;
        }
    }
    async #reload() {
        const registry = await deadline(this.options.dependencies.loadRegistry(this.options.registryReference, this.options.roots), this.options.reloadTimeoutMs, 'REGISTRY_RELOAD_TIMEOUT');
        await this.#ensureAuthority(registry.installationId);
        this.#validateTransition(registry);
        if (registry.generation > this.#generation) {
            const remembered = new Map(this.#acceptedSlots);
            for (const slot of registry.slots)
                remembered.set(slot.scopeId, slot);
            await this.options.dependencies.checkpoint.save({
                version: 1,
                installationId: registry.installationId,
                generation: registry.generation,
                registrySha256: registry.sha256,
                slots: [...remembered.values()].map(slot => ({ scopeId: slot.scopeId, configReference: slot.configReference, configSha256: slot.configSha256 })),
            }, this.options.roots);
            this.#installationId = registry.installationId;
            this.#generation = registry.generation;
            this.#registrySha256 = registry.sha256;
            for (const slot of remembered.values())
                this.#acceptedSlots.set(slot.scopeId, slot);
        }
        const desired = new Map(registry.slots.map(slot => [slot.scopeId, slot]));
        const retiring = [...this.#runtimes].filter(([scopeId]) => desired.get(scopeId)?.state !== 'active');
        const starting = registry.slots.filter(slot => slot.state === 'active' && !this.#runtimes.has(slot.scopeId));
        for (const slot of starting) {
            await this.#setHealth(slot.scopeId, 'STARTING');
            try {
                const runtime = await this.#startBounded(slot, registry.installationId);
                const current = { slot, runtime };
                this.#runtimes.set(slot.scopeId, current);
                if (runtime.scopeId !== slot.scopeId) {
                    await this.#discardStartedRuntime(slot.scopeId, current);
                    throw new Error('SLOT_SCOPE_MISMATCH');
                }
                try {
                    await this.#setHealth(slot.scopeId, 'HEALTHY');
                }
                catch (error) {
                    await this.#discardStartedRuntime(slot.scopeId, current);
                    throw error;
                }
            }
            catch (error) {
                const status = error instanceof RuntimeCleanupIncomplete ? { state: 'DEGRADED', code: 'DRAIN_FAILED' } : sanitizeRuntimeHealthCode(error);
                await this.#setHealth(slot.scopeId, status.state, status.code);
                if (error instanceof RuntimeCleanupIncomplete)
                    throw error;
            }
        }
        for (const scopeId of this.#acceptedSlots.keys()) {
            if (!this.#runtimes.has(scopeId) && desired.get(scopeId)?.state !== 'active' && this.#health.get(scopeId)?.state !== 'STOPPED')
                await this.#setHealth(scopeId, 'STOPPED');
        }
        await Promise.allSettled(retiring.map(([scopeId, current]) => this.#retire(scopeId, current)));
    }
    async #ensureAuthority(installationId) {
        if (this.#lease === undefined)
            this.#lease = await this.options.dependencies.lease.acquire(installationId, this.options.roots);
        if (this.#checkpointLoaded)
            return;
        const checkpoint = await this.options.dependencies.checkpoint.load(installationId, this.options.roots);
        if (checkpoint !== undefined) {
            this.#installationId = checkpoint.installationId;
            this.#generation = checkpoint.generation;
            this.#registrySha256 = checkpoint.registrySha256;
            for (const slot of checkpoint.slots)
                this.#acceptedSlots.set(slot.scopeId, slot);
        }
        this.#checkpointLoaded = true;
    }
    async #releaseLease() {
        const lease = this.#lease;
        if (lease === undefined)
            return;
        await lease.close();
        this.#lease = undefined;
    }
    async #startBounded(slot, installationId) {
        const controller = new AbortController();
        const outcome = Promise.resolve()
            .then(() => this.options.dependencies.startSlot(slot, installationId, this.options.roots, this.#capacity, this.options.drainTimeoutMs, controller.signal, this.options.listenerInitializationTimeoutMs ?? DEFAULT_LISTENER_INITIALIZATION_TIMEOUT_MS))
            .then(runtime => ({ kind: 'runtime', runtime }), error => ({ kind: 'error', error }));
        const pending = { controller, outcome, cleanup: undefined };
        this.#uncertainStarts.add(pending);
        try {
            const settled = await deadline(outcome, this.options.slotStartupTimeoutMs ?? DEFAULT_SLOT_STARTUP_TIMEOUT_MS, 'SLOT_START_TIMEOUT');
            if (settled.kind === 'error')
                throw settled.error;
            pending.runtime = settled.runtime;
            if (controller.signal.aborted)
                throw new Error('SLOT_START_CANCELLED');
            this.#uncertainStarts.delete(pending);
            return settled.runtime;
        }
        catch (error) {
            controller.abort(new Error('SLOT_START_CANCELLED'));
            try {
                await this.#cleanupUncertainStartBounded(pending);
            }
            catch {
                throw new RuntimeCleanupIncomplete();
            }
            throw error;
        }
    }
    #abortUncertainStarts(code) {
        for (const pending of this.#uncertainStarts)
            pending.controller.abort(new Error(code));
    }
    async #cleanupOwnedWork() {
        const runtimes = [...this.#runtimes];
        const uncertain = [...this.#uncertainStarts];
        const results = await Promise.allSettled([
            ...runtimes.map(([scopeId, current]) => this.#retire(scopeId, current)),
            ...uncertain.map(pending => this.#cleanupUncertainStartBounded(pending)),
        ]);
        return results.every(result => result.status === 'fulfilled') && this.#runtimes.size === 0 && this.#uncertainStarts.size === 0;
    }
    #cleanupUncertainStart(pending) {
        if (pending.cleanup !== undefined)
            return pending.cleanup;
        const execution = (async () => {
            const outcome = await pending.outcome;
            if (outcome.kind === 'error') {
                if (outcome.error instanceof RuntimeCleanupIncomplete)
                    throw outcome.error;
                this.#uncertainStarts.delete(pending);
                return;
            }
            pending.runtime ??= outcome.runtime;
            await pending.runtime.retire(this.options.drainTimeoutMs);
            this.#uncertainStarts.delete(pending);
        })();
        pending.cleanup = execution;
        execution.then(() => { pending.cleanup = undefined; }, () => { pending.cleanup = undefined; });
        return execution;
    }
    async #cleanupUncertainStartBounded(pending) {
        const execution = this.#cleanupUncertainStart(pending);
        try {
            await deadline(execution, this.options.drainTimeoutMs + 250, 'SLOT_START_CLEANUP_TIMEOUT');
        }
        catch (error) {
            void execution.catch(() => undefined);
            throw error;
        }
    }
    #validateTransition(registry) {
        const scopes = new Set(registry.slots.map(slot => slot.scopeId));
        const references = new Set(registry.slots.map(slot => slot.configReference));
        if (!isInstallationId(registry.installationId) || !Number.isSafeInteger(registry.generation) || registry.generation < 0 || !/^[a-f0-9]{64}$/u.test(registry.sha256) || registry.slots.length > BUILDER_MANAGER_MAX_SLOTS || scopes.size !== registry.slots.length || references.size !== registry.slots.length || registry.slots.some(slot => !isBuilderRuntimeScopeId(slot.scopeId) || !/^[a-f0-9]{64}$/u.test(slot.configSha256) || (slot.state !== 'active' && slot.state !== 'retiring') || slot.configReference !== `file:${posix.join(this.options.roots.configRoot, 'instances', slot.scopeId, 'supervisor.json')}`))
            throw new BuilderRuntimeRegistryError();
        if (this.#installationId !== undefined && registry.installationId !== this.#installationId)
            throw new BuilderRuntimeRegistryError();
        if (registry.generation < this.#generation)
            throw new BuilderRuntimeRegistryError();
        if (registry.generation === this.#generation) {
            if (registry.sha256 !== this.#registrySha256)
                throw new BuilderRuntimeRegistryError();
            return;
        }
        const next = new Map(registry.slots.map(slot => [slot.scopeId, slot]));
        for (const [scopeId, current] of this.#acceptedSlots) {
            const candidate = next.get(scopeId);
            if (candidate !== undefined && (candidate.configReference !== current.configReference || candidate.configSha256 !== current.configSha256))
                throw new BuilderRuntimeRegistryError();
        }
    }
    async #retire(scopeId, current) {
        await this.#setHealth(scopeId, 'RETIRING');
        try {
            await deadline(current.runtime.retire(this.options.drainTimeoutMs), this.options.drainTimeoutMs + 250, 'SLOT_DRAIN_TIMEOUT');
            this.#runtimes.delete(scopeId);
            await this.#setHealth(scopeId, 'STOPPED');
        }
        catch {
            await this.#setHealth(scopeId, 'DEGRADED', 'DRAIN_FAILED');
            throw new Error('SLOT_DRAIN_FAILED');
        }
    }
    async #discardStartedRuntime(scopeId, current) {
        try {
            await deadline(current.runtime.retire(this.options.drainTimeoutMs), this.options.drainTimeoutMs + 250, 'SLOT_DRAIN_TIMEOUT');
        }
        catch {
            throw new RuntimeCleanupIncomplete();
        }
        this.#runtimes.delete(scopeId);
    }
    async #setHealth(scopeId, state, code = 'NONE') {
        const next = runtimeHealth(scopeId, state, this.#health.get(scopeId), code, this.options.dependencies.now());
        await this.options.dependencies.health.write(next);
        this.#health.set(scopeId, next);
    }
}
export async function runBuilderRuntimeManager(options) {
    const roots = options.roots ?? PRODUCTION_BUILDER_ROOT_POLICY;
    const runtime = options.runtime ?? { signals: process, setInterval, clearInterval };
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const reloadTimeoutMs = options.reloadTimeoutMs ?? 5_000;
    const slotStartupTimeoutMs = options.slotStartupTimeoutMs ?? DEFAULT_SLOT_STARTUP_TIMEOUT_MS;
    const listenerInitializationTimeoutMs = options.listenerInitializationTimeoutMs ?? DEFAULT_LISTENER_INITIALIZATION_TIMEOUT_MS;
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    const maximumGlobalBuilds = options.maximumGlobalBuilds ?? 4;
    if (![pollIntervalMs, reloadTimeoutMs, slotStartupTimeoutMs, listenerInitializationTimeoutMs, drainTimeoutMs, maximumGlobalBuilds].every(value => Number.isSafeInteger(value) && value > 0))
        return BUILDER_MANAGER_EXIT.usage;
    const health = new FileBuilderRuntimeHealthStore(`${roots.stateRoot}/manager-health`);
    const authority = new FileBuilderManagerAuthority();
    const dependencies = {
        loadRegistry: loadBuilderRuntimeRegistry,
        startSlot: createBuilderRuntimeSlotStarter(),
        health,
        lease: authority,
        checkpoint: authority,
        now: () => new Date(),
        error: code => { process.stderr.write(`${JSON.stringify({ event: 'builder-manager-error', code })}\n`); },
        ...options.dependencies,
    };
    const manager = new BuilderRuntimeManager({
        registryReference: options.registryReference,
        roots,
        drainTimeoutMs,
        reloadTimeoutMs,
        slotStartupTimeoutMs,
        listenerInitializationTimeoutMs,
        maximumGlobalBuilds,
        dependencies,
    });
    let resolveShutdown;
    const shutdown = new Promise(resolve => { resolveShutdown = resolve; });
    let requested = false;
    const requestShutdown = () => { if (!requested) {
        requested = true;
        resolveShutdown();
    } };
    const reload = () => { void manager.requestReload(); };
    let signalsRegistered = false;
    let poll;
    try {
        await manager.initialize();
        runtime.signals.on('SIGHUP', reload);
        runtime.signals.on('SIGINT', requestShutdown);
        runtime.signals.on('SIGTERM', requestShutdown);
        signalsRegistered = true;
        poll = runtime.setInterval(reload, pollIntervalMs);
        poll.unref?.();
        await shutdown;
        try {
            await manager.shutdown();
            return BUILDER_MANAGER_EXIT.ok;
        }
        catch {
            dependencies.error('SHUTDOWN_FAILED');
            return BUILDER_MANAGER_EXIT.shutdown;
        }
    }
    catch (error) {
        dependencies.error(error instanceof BuilderRuntimeRegistryError ? 'INVALID_RUNTIME_REGISTRY' : 'MANAGER_STARTUP_FAILED');
        return error instanceof BuilderRuntimeRegistryError ? BUILDER_MANAGER_EXIT.usage : BUILDER_MANAGER_EXIT.startup;
    }
    finally {
        if (poll !== undefined)
            runtime.clearInterval(poll);
        if (signalsRegistered) {
            runtime.signals.off('SIGHUP', reload);
            runtime.signals.off('SIGINT', requestShutdown);
            runtime.signals.off('SIGTERM', requestShutdown);
        }
        if (!requested)
            await manager.shutdown().catch(() => undefined);
    }
}
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
export function argumentosDoGerente(argv) {
    if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== '--registry' || typeof argv[1] !== 'string' || !argv[1].startsWith('file:/'))
        return undefined;
    if (argv.length === 2)
        return { registryReference: argv[1] };
    if (argv[2] !== '--roots-base' || typeof argv[3] !== 'string')
        return undefined;
    try {
        const roots = raizesDoConstrutorEm(argv[3]);
        validateBuilderSupervisorRootPolicy(roots);
        return { registryReference: argv[1], roots };
    }
    catch {
        return undefined;
    }
}
export async function executeBuilderRuntimeManagerCli(argv, 
// Injetável só para o teste conferir que as raízes CHEGAM ao gerente: a
// montagem é onde elas se perdiam (ver `argumentosDoGerente`).
run = runBuilderRuntimeManager) {
    const argumentos = argumentosDoGerente(argv);
    if (argumentos === undefined)
        return BUILDER_MANAGER_EXIT.usage;
    return run(argumentos);
}
export function createBuilderRuntimeSlotStarter(runtime = DEFAULT_SLOT_START_RUNTIME) {
    return async (slot, installationId, roots, capacity, drainTimeoutMs, signal, listenerInitializationTimeoutMs = DEFAULT_LISTENER_INITIALIZATION_TIMEOUT_MS) => {
        signal.throwIfAborted();
        const config = await runtime.loadConfig(slot.configReference, slot.configSha256, roots);
        signal.throwIfAborted();
        if (config.scopeId !== slot.scopeId || config.installationId !== installationId || config.templateStoreManifest === undefined)
            throw new BuilderRuntimeRegistryError();
        const engine = runtime.createEngine(config);
        try {
            await runtime.ensureTemplateStore({
                engine,
                installationId: config.installationId,
                scopeId: config.scopeId,
                version: config.templateStoreVersion,
                treeSha256: config.templateStoreSha256,
                imageDigest: config.imageDigest,
                sourceEnvelope: posix.join(roots.stateRoot, 'instances', config.scopeId, 'template-store', config.templateStoreVersion),
                manifest: config.templateStoreManifest,
            }, signal);
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'TEMPLATE_STORE_CLEANUP_INCOMPLETE')
                throw new RuntimeCleanupIncomplete();
            signal.throwIfAborted();
            throw Object.assign(new Error('BLOCKED_EXTERNAL'), { code: 'BLOCKED_EXTERNAL' });
        }
        signal.throwIfAborted();
        const composition = wrapBuilderSupervisorWithGlobalCapacity(config.scopeId, runtime.compose(config, engine), capacity);
        await composition.methods.initialize(signal);
        signal.throwIfAborted();
        return listenManagedRuntime(config, composition, drainTimeoutMs, listenerInitializationTimeoutMs, signal, runtime);
    };
}
export function wrapBuilderSupervisorWithGlobalCapacity(scopeId, composition, capacity, 
/** Só para teste: o relógio que decide o vencimento de uma vaga reservada. */
now = () => Date.now()) {
    // A vaga global tem PRAZO, e antes nao tinha.
    //
    // `prepare` adquire a vaga; a liberacao so acontecia em `execute` com estado
    // terminal, `cancel` ou `finish`. Um cliente que chamasse `prepare` e sumisse
    // — conexao morta, processo do Studio derrubado, `execute` lancando sem
    // estado terminal — deixava a vaga pendurada no mapa para sempre, sem TTL,
    // sem varredura e sem limite de tempo. Com o padrao de quatro vagas globais,
    // QUATRO preparacoes abandonadas travavam os builds da instalacao inteira ate
    // alguem reiniciar o supervisor.
    //
    // O prazo e generoso de proposito: ele nao existe para disciplinar build
    // lento, existe para que trabalho abandonado nao seja eterno. Toda atividade
    // sobre aquele build renova.
    // As vagas seguradas ficam num registro COMPARTILHADO por quem divide a mesma
    // capacidade, e nao num mapa por embrulho.
    //
    // Cada escopo tem o proprio embrulho, e um mapa por embrulho so seria varrido
    // quando AQUELE escopo voltasse a preparar — que e exatamente o que um escopo
    // abandonado nunca faz. A vaga presa por quem sumiu ficaria presa ate ele
    // voltar, e ele nao volta. Com o registro compartilhado, a proxima preparacao
    // de QUALQUER escopo devolve a vaga vencida.
    const held = heldSlotsFor(capacity);
    const releases = new Map();
    const release = (buildRef) => {
        const current = releases.get(buildRef);
        if (current !== undefined) {
            releases.delete(buildRef);
            held.delete(current);
            current.release();
        }
    };
    // Renova o prazo de quem deu sinal de vida. Sem isto, um build legitimo e
    // demorado perderia a vaga no meio — trocando um problema raro por um comum.
    const touch = (buildRef) => { const current = releases.get(buildRef); if (current !== undefined)
        current.expiresAt = now() + HELD_SLOT_TTL_MS; };
    // Varre na ENTRADA de `prepare`, e nao por temporizador: sem relogio de fundo
    // nao ha trabalho periodico para testar, e a unica hora em que a vaga vencida
    // importa e quando alguem precisa de uma.
    const sweep = () => {
        const at = now();
        for (const slot of [...held]) {
            if (slot.expiresAt > at)
                continue;
            held.delete(slot);
            slot.forget();
            slot.release();
        }
    };
    const methods = composition.methods;
    return { ...(composition.artifactIngress === undefined ? {} : { artifactIngress: composition.artifactIngress }), methods: {
            initialize: methods.initialize.bind(methods),
            preflight: methods.preflight.bind(methods),
            prepare: async (body, signal) => {
                sweep();
                const acquired = await capacity.acquire(scopeId, signal);
                try {
                    const result = await methods.prepare(body, signal);
                    const previous = releases.get(result.build_ref);
                    if (previous === undefined) {
                        const slot = { release: acquired, expiresAt: now() + HELD_SLOT_TTL_MS, forget: () => { releases.delete(result.build_ref); } };
                        releases.set(result.build_ref, slot);
                        held.add(slot);
                    }
                    else {
                        acquired();
                        previous.expiresAt = now() + HELD_SLOT_TTL_MS;
                    }
                    return result;
                }
                catch (error) {
                    acquired();
                    throw error;
                }
            },
            execute: async (body, signal) => {
                touch(body.build_ref);
                const result = await methods.execute(body, signal);
                if (isTerminalState(result.state))
                    release(result.build_ref);
                else
                    touch(result.build_ref);
                return result;
            },
            cancel: async (body, signal) => {
                const result = await methods.cancel(body, signal);
                release(body.build_ref);
                return result;
            },
            finish: async (body, signal) => {
                const result = await methods.finish(body, signal);
                if (result.cleaned && !result.cleanup_pending)
                    release(body.build_ref);
                return result;
            },
            listManaged: methods.listManaged.bind(methods),
        }, releaseAll: () => { for (const current of releases.values()) {
            held.delete(current);
            current.release();
        } releases.clear(); } };
}
async function listenManagedRuntime(config, composition, drainTimeoutMs, listenerInitializationTimeoutMs, managerSignal, runtime) {
    const controller = new AbortController();
    const cancel = () => controller.abort(managerSignal.reason);
    managerSignal.addEventListener('abort', cancel, { once: true });
    let listener;
    const listening = runtime.listen({
        socketPath: config.socketPath,
        bearerToken: config.bearerToken,
        // initialize() already proved service readiness, adapter preflight, and attestation.
        // Exposing only the RPC surface makes the standalone listener's optional lifecycle hook inert.
        methods: initializedRpcMethods(composition.methods),
        scopeId: config.scopeId,
        policySha256: config.policySha256,
        replayRoot: config.replayRoot,
        ...(composition.artifactIngress === undefined ? {} : { artifactIngress: composition.artifactIngress }),
        signal: controller.signal,
    });
    try {
        listener = await deadline(listening, listenerInitializationTimeoutMs, 'LISTENER_INITIALIZATION_TIMEOUT');
    }
    catch (error) {
        controller.abort(new Error('RUNTIME_START_FAILED'));
        composition.releaseAll();
        const outcome = listening.then(late => ({ kind: 'listener', listener: late }), listenerError => ({ kind: 'error', error: listenerError }));
        let settled;
        try {
            settled = await deadline(outcome, drainTimeoutMs + 250, 'LISTENER_START_CLEANUP_TIMEOUT');
        }
        catch {
            throw new RuntimeCleanupIncomplete();
        }
        if (settled.kind === 'listener') {
            try {
                await deadline(settled.listener.close(), drainTimeoutMs + 250, 'LISTENER_START_CLEANUP_TIMEOUT');
            }
            catch {
                throw new RuntimeCleanupIncomplete();
            }
        }
        if (settled.kind === 'error' && isListenerCleanupIncomplete(settled.error))
            throw new RuntimeCleanupIncomplete();
        throw error;
    }
    finally {
        managerSignal.removeEventListener('abort', cancel);
    }
    let closing;
    let closed = false;
    const beginClose = () => {
        const attempt = listener.close(() => controller.abort(new Error('RUNTIME_RETIRING')));
        const observed = attempt.then(() => { closed = true; composition.releaseAll(); }, error => { closing = undefined; throw error; });
        closing = observed;
        return observed;
    };
    return {
        scopeId: config.scopeId,
        retire: async (timeoutMs) => {
            if (closed)
                return;
            const current = closing ?? beginClose();
            const forced = runtime.scheduleTimeout(() => { controller.abort(new Error('RUNTIME_DRAIN_TIMEOUT')); listener.server.closeAllConnections(); listener.server.closeIdleConnections(); }, Math.min(timeoutMs, drainTimeoutMs));
            try {
                await deadline(current, Math.min(timeoutMs, drainTimeoutMs) + 200, 'RUNTIME_DRAIN_TIMEOUT');
            }
            finally {
                runtime.clearScheduledTimeout(forced);
            }
        },
    };
}
function initializedRpcMethods(methods) {
    return {
        preflight: methods.preflight.bind(methods),
        prepare: methods.prepare.bind(methods),
        execute: methods.execute.bind(methods),
        cancel: methods.cancel.bind(methods),
        finish: methods.finish.bind(methods),
        listManaged: methods.listManaged.bind(methods),
    };
}
function isListenerCleanupIncomplete(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'LISTENER_CLEANUP_INCOMPLETE';
}
function createBuilderDockerEngine(config) { return new DockerEngine(config.dockerSocketPath); }
export const BUILDER_MANAGER_TEST_ONLY = Object.freeze({ createBuilderDockerEngine });
async function deadline(execution, timeoutMs, code) {
    let timer;
    try {
        return await Promise.race([
            execution,
            new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs); timer.unref?.(); }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=manager-main.js.map