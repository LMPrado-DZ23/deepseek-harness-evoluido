import { randomBytes } from 'node:crypto';
import { ArtifactIngressError } from './artifact-ingress.js';
import { BuilderSupervisorError, isTerminalState } from './model.js';
import { ReplayGuard } from './replay.js';
import { Semaphore } from './semaphore.js';
import { beginStep, completeStep } from './state-machine.js';
export class BuilderSupervisor {
    options;
    #builds = new Map();
    #buildIds = new Set();
    #buildRefs = new Set();
    #controllers = new Map();
    #finishes = new Map();
    #replay;
    #createReference;
    #steps;
    #prepares = new Semaphore(1);
    #maxBuilds;
    #buildClaims;
    #initialized = false;
    #initializing;
    constructor(options) {
        this.options = options;
        this.#replay = options.replay ?? new ReplayGuard();
        this.#createReference = options.createReference ?? (() => `build_${randomBytes(16).toString('hex')}`);
        this.#maxBuilds = options.maxBuilds ?? 32;
        this.#buildClaims = options.buildClaims;
        this.#steps = new Semaphore(options.maxConcurrentSteps ?? 2);
        if (!Number.isSafeInteger(this.#maxBuilds) || this.#maxBuilds < 1 || this.#maxBuilds > 1_000)
            throw new Error('INVALID_BUILD_LIMIT');
    }
    async initialize(signal) {
        if (this.#initialized)
            return;
        this.#initializing ??= (async () => {
            const journal = await this.#buildClaims.list();
            const journalById = new Map(journal.map(item => [item.build_id, item]));
            const journalByRef = new Map(journal.map(item => [item.build_ref, item]));
            if (journalById.size !== journal.length || journalByRef.size !== journal.length)
                throw new BuilderSupervisorError('RECOVERY_FAILED');
            const recovered = await this.options.adapter.reconcile(journal.map(item => ({ build_id: item.build_id, build_ref: item.build_ref })), signal);
            const recoveredRefs = new Set(recovered.map(item => item.build_ref));
            for (const item of recovered) {
                const byId = journalById.get(item.build_id);
                const byRef = journalByRef.get(item.build_ref);
                if (byId?.build_ref !== item.build_ref || byRef?.build_id !== item.build_id)
                    throw new BuilderSupervisorError('RECOVERY_FAILED');
            }
            for (const item of journalById.values()) {
                let record = item;
                if (record.finish_result === null && record.finish_error === null) {
                    const finalState = isTerminalState(record.build_state) ? record.build_state : 'CANCELLED';
                    let exported = record.exported;
                    if (finalState === 'E2E_OK') {
                        try {
                            const recoveredExport = await this.options.adapter.exportArtifact(record.build_ref, cleanupSignal());
                            if (exported !== null && JSON.stringify(exported) !== JSON.stringify(recoveredExport))
                                throw new BuilderSupervisorError('RECOVERY_FAILED');
                            exported = recoveredExport;
                        }
                        catch (error) {
                            if (!(error instanceof BuilderSupervisorError) || error.code !== 'BUILD_NOT_FOUND')
                                throw error;
                            record = { ...record, build_state: finalState, cleanup_pending: false, finish_error: 'EXPORT_INVALID' };
                            await this.#buildClaims.complete(record);
                            this.#buildIds.add(record.build_id);
                            this.#buildRefs.add(record.build_ref);
                            this.#builds.set(record.build_ref, mutable(record));
                            continue;
                        }
                    }
                    if (recoveredRefs.has(record.build_ref) || record.cleanup_pending) {
                        record = { ...record, build_state: finalState, exported, cleanup_pending: true };
                        await this.#buildClaims.update(record);
                        try {
                            await this.options.adapter.cleanup(record.build_ref, cleanupSignal());
                        }
                        catch {
                            throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
                        }
                        record = { ...record, cleanup_pending: false };
                        await this.#buildClaims.update(record);
                    }
                    const result = recoveredResult(record.build_ref, finalState, exported);
                    if (exported !== null)
                        await this.options.adapter.commitArtifact(record.build_ref, pinnedExportRefs(journalById.values(), record.build_ref), cleanupSignal());
                    record = recoveredRecord(record.build_id, record.build_ref, finalState, result);
                    await this.#buildClaims.complete(record);
                }
                else if (recoveredRefs.has(record.build_ref) || record.cleanup_pending) {
                    try {
                        await this.options.adapter.cleanup(record.build_ref, cleanupSignal());
                    }
                    catch {
                        throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
                    }
                }
                this.#buildIds.add(record.build_id);
                this.#buildRefs.add(record.build_ref);
                this.#builds.set(record.build_ref, mutable(record));
            }
            this.#initialized = true;
        })();
        try {
            await this.#initializing;
        }
        finally {
            if (!this.#initialized)
                this.#initializing = undefined;
        }
    }
    async preflight(body, signal) {
        await this.#claim(body.request_id);
        return this.options.adapter.preflight(signal);
    }
    async prepare(body, signal) {
        await this.#claim(body.request_id);
        const release = await this.#prepares.acquire(signal);
        try {
            const activeBuilds = [...this.#builds.values()].filter(build => build.finish_result === undefined && build.finish_error === undefined).length;
            if (activeBuilds >= this.#maxBuilds)
                throw new BuilderSupervisorError('CAPACITY_EXCEEDED');
            if (this.#buildIds.has(body.build_id)) {
                await this.#pruneCompleted();
                if (this.#buildIds.has(body.build_id))
                    throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS');
            }
            const buildRef = this.#createReference();
            if (this.#buildRefs.has(buildRef))
                await this.#pruneCompleted();
            if (!/^build_[a-f0-9]{32}$/u.test(buildRef) || this.#builds.has(buildRef) || this.#buildRefs.has(buildRef) || (await this.options.adapter.listManaged(signal)).includes(buildRef)) {
                throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS');
            }
            let claimed;
            try {
                if (this.options.artifactIngress === undefined)
                    throw new BuilderSupervisorError('RECOVERY_FAILED');
                const attestation = await this.options.adapter.preflight(signal);
                claimed = await this.options.artifactIngress.claim(body.upload_ref, { buildId: body.build_id, attestation });
            }
            catch (error) {
                throw ingressFailure(error);
            }
            try {
                await this.#buildClaims.claim(body.build_id, buildRef);
                this.#buildIds.add(body.build_id);
            }
            catch (error) {
                await settleFailed(claimed);
                throw error;
            }
            try {
                await this.options.adapter.prepare(buildRef, body.build_id, claimed.artifact, signal);
            }
            catch (error) {
                let rollbackFailed = false;
                if (error instanceof BuilderSupervisorError && error.code === 'CLEANUP_INCOMPLETE') {
                    this.#buildRefs.add(buildRef);
                    const failed = { build_ref: buildRef, build_id: body.build_id, state: 'CANCELLED', cleanup_pending: true };
                    this.#builds.set(buildRef, failed);
                    try {
                        await this.#buildClaims.update(this.#record(failed));
                    }
                    catch {
                        rollbackFailed = true;
                    }
                }
                else {
                    try {
                        await this.#buildClaims.release(body.build_id);
                        this.#buildIds.delete(body.build_id);
                    }
                    catch {
                        rollbackFailed = true;
                    }
                }
                try {
                    await claimed.fail();
                }
                catch {
                    rollbackFailed = true;
                }
                if (rollbackFailed)
                    throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
                throw error;
            }
            this.#buildRefs.add(buildRef);
            const prepared = { build_ref: buildRef, build_id: body.build_id, state: 'PREPARED', cleanup_pending: false };
            this.#builds.set(buildRef, prepared);
            try {
                await this.#buildClaims.update(this.#record(prepared));
            }
            catch (error) {
                await this.#rollbackUnpublishedPrepare(prepared, claimed);
                throw error;
            }
            try {
                await claimed.complete();
            }
            catch {
                await this.#rollbackUnpublishedPrepare(prepared);
                throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
            }
            return { build_ref: buildRef, state: 'PREPARED' };
        }
        finally {
            release();
        }
    }
    async execute(body, signal) {
        await this.#claim(body.request_id);
        const build = this.#build(body.build_ref);
        build.state = beginStep(build.state, body.step);
        await this.#buildClaims.update(this.#record(build));
        const controller = new AbortController();
        this.#controllers.set(body.build_ref, controller);
        const combined = AbortSignal.any([signal, controller.signal]);
        let release;
        try {
            release = await this.#steps.acquire(combined);
            const result = await this.options.adapter.execute(body.build_ref, body.step, combined);
            if (build.state !== 'CANCELLED') {
                build.state = completeStep(build.state, body.step, result.exit_code === 0 && !result.timed_out && !result.output_limit_exceeded);
                await this.#buildClaims.update(this.#record(build));
            }
            return { build_ref: body.build_ref, state: build.state, step: body.step, result };
        }
        catch (error) {
            if (build.state !== 'CANCELLED') {
                build.state = 'FAILED';
                await this.#buildClaims.update(this.#record(build));
            }
            throw error;
        }
        finally {
            release?.();
            this.#controllers.delete(body.build_ref);
        }
    }
    async cancel(body, _signal) {
        await this.#claim(body.request_id);
        const build = this.#build(body.build_ref);
        const finishing = this.#finishes.get(body.build_ref);
        if (finishing !== undefined) {
            const result = await finishing;
            if (result.final_state !== 'CANCELLED')
                throw new BuilderSupervisorError('INVALID_STEP_ORDER');
            return { build_ref: body.build_ref, state: 'CANCELLED' };
        }
        if (isTerminalState(build.state) && build.state !== 'CANCELLED')
            throw new BuilderSupervisorError('INVALID_STEP_ORDER');
        build.state = 'CANCELLED';
        build.cleanup_pending = true;
        await this.#buildClaims.update(this.#record(build));
        this.#controllers.get(body.build_ref)?.abort(new Error('BUILD_CANCELLED'));
        await this.options.adapter.cancel(body.build_ref, cleanupSignal());
        return { build_ref: body.build_ref, state: 'CANCELLED' };
    }
    async finish(body, signal) {
        await this.#claim(body.request_id);
        const build = this.#build(body.build_ref);
        if (build.finish_result !== undefined)
            return build.finish_result;
        if (build.finish_error !== undefined)
            throw new BuilderSupervisorError(build.finish_error);
        if (!isTerminalState(build.state))
            throw new BuilderSupervisorError('BUILD_NOT_TERMINAL');
        const current = this.#finishes.get(body.build_ref);
        if (current !== undefined)
            return current;
        signal.throwIfAborted();
        const operation = this.#finish(build, lifecycleSignal());
        this.#finishes.set(body.build_ref, operation);
        try {
            return await operation;
        }
        finally {
            this.#finishes.delete(body.build_ref);
        }
    }
    async #finish(build, signal) {
        const finalState = build.state;
        let exportError;
        if (finalState === 'E2E_OK' && build.exported === undefined) {
            try {
                build.exported = await this.options.adapter.exportArtifact(build.build_ref, signal);
                await this.#buildClaims.update(this.#record(build));
            }
            catch (error) {
                exportError = error;
            }
        }
        if (exportError !== undefined && !(exportError instanceof BuilderSupervisorError))
            throw exportError;
        build.cleanup_pending = true;
        await this.#buildClaims.update(this.#record(build));
        try {
            await this.options.adapter.cleanup(build.build_ref, cleanupSignal());
        }
        catch {
            await this.#buildClaims.update(this.#record(build));
            throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
        }
        build.cleanup_pending = false;
        await this.#buildClaims.update(this.#record(build));
        if (exportError instanceof BuilderSupervisorError && exportError.code === 'CLEANUP_INCOMPLETE') {
            try {
                build.exported = await this.options.adapter.exportArtifact(build.build_ref, cleanupSignal());
                exportError = undefined;
                await this.#buildClaims.update(this.#record(build));
            }
            catch (error) {
                exportError = error instanceof BuilderSupervisorError && error.code === 'BUILD_NOT_FOUND' ? new BuilderSupervisorError('EXPORT_INVALID') : error;
            }
        }
        if (exportError !== undefined && !(exportError instanceof BuilderSupervisorError))
            throw exportError;
        if (exportError !== undefined) {
            await this.#buildClaims.complete({ ...this.#record(build), finish_error: exportError.code });
            build.finish_error = exportError.code;
            throw new BuilderSupervisorError(build.finish_error);
        }
        const result = { build_ref: build.build_ref, final_state: finalState, exported: build.exported ?? null, cleanup_pending: false, cleaned: true };
        if (build.exported !== undefined)
            await this.options.adapter.commitArtifact(build.build_ref, this.#pinnedExportRefs(build.build_ref), cleanupSignal());
        await this.#buildClaims.complete({ ...this.#record(build), finish_result: result });
        build.finish_result = result;
        return result;
    }
    async listManaged(body, signal) {
        await this.#claim(body.request_id);
        const engineRefs = new Set(await this.options.adapter.listManaged(signal));
        const tracked = [...this.#builds.values()].filter(build => build.finish_result === undefined && build.finish_error === undefined);
        const resourceBacked = tracked.filter(build => build.recovered_cleaned !== true);
        if (engineRefs.size !== resourceBacked.length || resourceBacked.some(build => !engineRefs.has(build.build_ref)))
            throw new BuilderSupervisorError('RECOVERY_FAILED');
        return { builds: tracked.filter(build => body.build_id === undefined || build.build_id === body.build_id).map(build => ({ build_ref: build.build_ref, build_id: build.build_id, state: build.state, exported: build.exported !== undefined, cleanup_pending: build.cleanup_pending })).sort((left, right) => left.build_ref.localeCompare(right.build_ref)) };
    }
    #build(buildRef) {
        const build = this.#builds.get(buildRef);
        if (build === undefined)
            throw new BuilderSupervisorError('BUILD_NOT_FOUND');
        return build;
    }
    #record(build) { return { build_id: build.build_id, build_ref: build.build_ref, build_state: build.state, exported: build.exported ?? null, cleanup_pending: build.cleanup_pending, finish_result: build.finish_result ?? null, finish_error: build.finish_error ?? null }; }
    async #rollbackUnpublishedPrepare(build, claimed) {
        build.state = 'CANCELLED';
        build.cleanup_pending = true;
        await this.#buildClaims.update(this.#record(build)).catch(() => undefined);
        let cleanupFailed = false;
        try {
            await this.options.adapter.cleanup(build.build_ref, cleanupSignal());
        }
        catch {
            cleanupFailed = true;
        }
        if (claimed !== undefined)
            try {
                await claimed.fail();
            }
            catch {
                cleanupFailed = true;
            }
        if (cleanupFailed)
            throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
        build.cleanup_pending = false;
        const result = { build_ref: build.build_ref, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true };
        build.finish_result = result;
        await this.#buildClaims.complete({ ...this.#record(build), finish_result: result });
    }
    async #pruneCompleted() {
        const retained = new Set((await this.#buildClaims.list()).map(record => record.build_ref));
        for (const [buildRef, build] of this.#builds)
            if ((build.finish_result !== undefined || build.finish_error !== undefined) && !retained.has(buildRef)) {
                this.#builds.delete(buildRef);
                this.#buildIds.delete(build.build_id);
                this.#buildRefs.delete(buildRef);
            }
    }
    #pinnedExportRefs(current) {
        const pinned = new Set();
        for (const build of this.#builds.values())
            if (build.build_ref !== current && build.finish_result === undefined && build.finish_error === undefined && build.exported !== undefined)
                pinned.add(build.build_ref);
        return pinned;
    }
    async #claim(requestId) {
        if (!this.#initialized)
            await this.initialize(AbortSignal.timeout(30_000));
        await this.#replay.claim(requestId);
    }
}
function cleanupSignal() { return AbortSignal.timeout(30_000); }
async function settleFailed(claimed) { try {
    await claimed.fail();
}
catch {
    throw new BuilderSupervisorError('CLEANUP_INCOMPLETE');
} }
function ingressFailure(error) {
    if (!(error instanceof ArtifactIngressError))
        return error instanceof Error ? error : new BuilderSupervisorError('RECOVERY_FAILED');
    if (error.code === 'INVALID_CONFIGURATION')
        return new BuilderSupervisorError('RECOVERY_FAILED');
    return new BuilderSupervisorError(error.code);
}
function lifecycleSignal() { return AbortSignal.timeout(210_000); }
function pinnedExportRefs(records, current) {
    const pinned = new Set();
    for (const record of records)
        if (record.build_ref !== current && record.finish_result === null && record.finish_error === null && record.exported !== null)
            pinned.add(record.build_ref);
    return pinned;
}
function recoveredResult(buildRef, state, exported) { return { build_ref: buildRef, final_state: state, exported, cleanup_pending: false, cleaned: true }; }
function recoveredRecord(buildId, buildRef, state, result) { return { build_id: buildId, build_ref: buildRef, build_state: state, exported: result?.exported ?? null, cleanup_pending: false, finish_result: result, finish_error: null }; }
function mutable(record) { return { build_ref: record.build_ref, build_id: record.build_id, state: record.build_state, cleanup_pending: record.cleanup_pending, ...(record.exported === null ? {} : { exported: record.exported }), ...(record.finish_result === null ? {} : { finish_result: record.finish_result }), ...(record.finish_error === null ? {} : { finish_error: record.finish_error }), recovered_cleaned: true }; }
//# sourceMappingURL=service.js.map