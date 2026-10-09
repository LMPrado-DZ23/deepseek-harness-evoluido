export const BUILD_STEPS = ['install', 'build', 'test', 'e2e'];
export class BuilderSupervisorError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export function isTerminalState(state) {
    return state === 'E2E_OK' || state === 'FAILED' || state === 'CANCELLED';
}
//# sourceMappingURL=model.js.map