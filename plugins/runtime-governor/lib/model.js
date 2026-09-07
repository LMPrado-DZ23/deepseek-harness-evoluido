export const CAPACITY_RESOURCES = ['prompt-job', 'build', 'preview'];
export class CapacityGovernorError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'CapacityGovernorError';
    }
}
export function isDistributedCapacityGovernor(value) {
    return typeof value.takeover === 'function';
}
export const DEFAULT_CAPACITY_LIMITS = Object.freeze({
    'prompt-job': Object.freeze({ global: 4, perTenant: 2, perProject: 1 }),
    build: Object.freeze({ global: 1, perTenant: 1, perProject: 1 }),
    preview: Object.freeze({ global: 4, perTenant: 2, perProject: 1 }),
});
export const DEFAULT_LEASE_TTL_MS = 120_000;
export const MIN_LEASE_TTL_MS = 1_000;
export const MAX_LEASE_TTL_MS = 3_600_000;
