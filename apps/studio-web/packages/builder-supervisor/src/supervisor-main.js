import { pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import { ArtifactIngressStore } from './artifact-ingress.js';
import { DockerBuilderAdapter } from './docker-adapter.js';
import { DockerEngine } from './docker-engine.js';
import { FileBuildIdGuard } from './persistent-replay.js';
import { BuilderSupervisor } from './service.js';
import { BuilderSupervisorConfigError, loadBuilderSupervisorConfig, PRODUCTION_BUILDER_ROOT_POLICY, } from './supervisor-config.js';
import { listenBuilderUnix } from './unix-server.js';
export const BUILDER_SUPERVISOR_EXIT = Object.freeze({ ok: 0, usage: 64, startup: 70, shutdown: 74 });
const DEFAULT_DEPENDENCIES = {
    loadConfig: loadBuilderSupervisorConfig,
    compose: composeBuilderSupervisor,
    listen: listenBuilderUnix,
    signals: process,
    error: code => { process.stderr.write(`${JSON.stringify({ event: 'builder-supervisor-error', code })}\n`); },
};
export function composeBuilderSupervisor(config, engine = new DockerEngine(config.dockerSocketPath)) {
    const adapter = new DockerBuilderAdapter({
        engine,
        imageDigest: config.imageDigest,
        installationId: config.installationId,
        scopeId: config.scopeId,
        exportRoot: config.exportRoot,
        templateStoreVersion: config.templateStoreVersion,
        templateStoreSha256: config.templateStoreSha256,
        diagnostico: evento => { process.stderr.write(`${JSON.stringify({ event: 'builder-export-diagnostic', ...evento })}\n`); },
    });
    const artifactIngress = new ArtifactIngressStore({
        spoolRoot: posix.join(config.journalRoot, 'artifact-ingress'),
        scopeId: config.scopeId,
        imageDigest: config.imageDigest,
        policySha256: config.policySha256,
    });
    const service = new BuilderSupervisor({ artifactIngress, adapter, buildClaims: new FileBuildIdGuard(config.journalRoot) });
    const initialize = async (signal) => {
        await artifactIngress.sweep();
        await service.initialize(signal);
        assertAttestation(await adapter.preflight(signal), config);
    };
    return { artifactIngress, methods: {
            initialize,
            preflight: service.preflight.bind(service),
            prepare: service.prepare.bind(service),
            execute: service.execute.bind(service),
            cancel: service.cancel.bind(service),
            finish: service.finish.bind(service),
            listManaged: service.listManaged.bind(service),
        } };
}
export async function runBuilderSupervisorMain(options) {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    const roots = options.roots ?? PRODUCTION_BUILDER_ROOT_POLICY;
    const controller = new AbortController();
    let listener;
    let shutdown;
    let shutdownRequested = false;
    let resolveShutdown;
    const requested = new Promise(resolve => { resolveShutdown = resolve; });
    const requestShutdown = () => {
        if (shutdownRequested) {
            listener?.server.closeAllConnections();
            return;
        }
        shutdownRequested = true;
        resolveShutdown();
        if (listener === undefined)
            controller.abort(new Error('SUPERVISOR_SHUTDOWN'));
        else
            shutdown = stopSupervisor(listener, controller);
    };
    dependencies.signals.on('SIGINT', requestShutdown);
    dependencies.signals.on('SIGTERM', requestShutdown);
    try {
        const config = await dependencies.loadConfig(options.configReference, roots);
        if (shutdownRequested)
            return BUILDER_SUPERVISOR_EXIT.ok;
        const composition = dependencies.compose(config);
        listener = await dependencies.listen({
            socketPath: config.socketPath,
            bearerToken: config.bearerToken,
            methods: composition.methods,
            scopeId: config.scopeId,
            policySha256: config.policySha256,
            replayRoot: config.replayRoot,
            ...(composition.artifactIngress === undefined ? {} : { artifactIngress: composition.artifactIngress }),
            signal: controller.signal,
        });
        if (shutdownRequested)
            shutdown = stopSupervisor(listener, controller);
        else
            await requested;
        try {
            await shutdown;
            return BUILDER_SUPERVISOR_EXIT.ok;
        }
        catch {
            dependencies.error('SHUTDOWN_FAILED');
            return BUILDER_SUPERVISOR_EXIT.shutdown;
        }
    }
    catch (error) {
        if (shutdownRequested)
            return BUILDER_SUPERVISOR_EXIT.ok;
        const code = error instanceof BuilderSupervisorConfigError ? 'INVALID_CONFIGURATION' : 'STARTUP_FAILED';
        dependencies.error(code);
        return error instanceof BuilderSupervisorConfigError ? BUILDER_SUPERVISOR_EXIT.usage : BUILDER_SUPERVISOR_EXIT.startup;
    }
    finally {
        dependencies.signals.off('SIGINT', requestShutdown);
        dependencies.signals.off('SIGTERM', requestShutdown);
    }
}
export async function executeBuilderSupervisorCli(argv, dependencies) {
    if (argv.length !== 2 || argv[0] !== '--config' || typeof argv[1] !== 'string' || !argv[1].startsWith('file:/')) {
        ;
        (dependencies?.error ?? DEFAULT_DEPENDENCIES.error)('INVALID_ARGUMENTS');
        return BUILDER_SUPERVISOR_EXIT.usage;
    }
    return runBuilderSupervisorMain({ configReference: argv[1], ...(dependencies === undefined ? {} : { dependencies }) });
}
export async function applyBuilderSupervisorExitCode(execution, target = process) {
    try {
        target.exitCode = await execution;
    }
    catch {
        target.exitCode = BUILDER_SUPERVISOR_EXIT.startup;
    }
}
async function stopSupervisor(listener, controller) {
    let stopped = false;
    try {
        await listener.close(() => { stopped = true; controller.abort(new Error('SUPERVISOR_SHUTDOWN')); });
    }
    finally {
        if (!stopped)
            controller.abort(new Error('SUPERVISOR_SHUTDOWN'));
    }
}
function assertAttestation(value, config) {
    if (value.state !== 'OK' || value.protocol_version !== 1 || value.scope_id !== config.scopeId || value.image_id !== config.imageDigest || value.policy_sha256 !== config.policySha256)
        throw new Error('BUILDER_ATTESTATION_FAILED');
}
const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
    void applyBuilderSupervisorExitCode(executeBuilderSupervisorCli(process.argv.slice(2)));
}
//# sourceMappingURL=supervisor-main.js.map