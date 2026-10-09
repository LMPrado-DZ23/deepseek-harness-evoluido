import { BuilderSupervisorError } from './model.js';
export class RpcReplayGuard {
    maximum;
    #entries = new Map();
    constructor(maximum = 4_096) {
        this.maximum = maximum;
        if (!Number.isSafeInteger(maximum) || maximum < 1)
            throw new Error('INVALID_REPLAY_CONFIGURATION');
    }
    async run(requestId, fingerprint, operation) {
        const current = this.#entries.get(requestId);
        if (current !== undefined) {
            if (current.fingerprint !== fingerprint)
                throw new BuilderSupervisorError('REQUEST_ID_CONFLICT');
            return clone(await current.result);
        }
        if (this.#entries.size >= this.maximum)
            throw new BuilderSupervisorError('REPLAY_CAPACITY');
        const result = operation().then(clone);
        this.#entries.set(requestId, { fingerprint, result });
        try {
            return clone(await result);
        }
        catch (error) {
            this.#entries.delete(requestId);
            throw error;
        }
    }
}
function clone(value) { return { status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body) }; }
export class ReplayGuard {
    now;
    ttlMs;
    maximum;
    #claims = new Map();
    constructor(now = Date.now, ttlMs = 10 * 60_000, maximum = 4_096) {
        this.now = now;
        this.ttlMs = ttlMs;
        this.maximum = maximum;
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maximum) || maximum < 1) {
            throw new Error('INVALID_REPLAY_CONFIGURATION');
        }
    }
    async claim(requestId) {
        const now = this.now();
        for (const [id, expiresAt] of this.#claims)
            if (expiresAt <= now)
                this.#claims.delete(id);
        if (this.#claims.has(requestId))
            throw new BuilderSupervisorError('REQUEST_REPLAY');
        if (this.#claims.size >= this.maximum)
            throw new BuilderSupervisorError('REPLAY_CAPACITY');
        this.#claims.set(requestId, now + this.ttlMs);
    }
}
//# sourceMappingURL=replay.js.map