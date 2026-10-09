import { BuilderSupervisorError } from './model.js';
const TRANSITIONS = {
    install: ['PREPARED', 'INSTALLING', 'INSTALL_OK'],
    build: ['INSTALL_OK', 'BUILDING', 'BUILD_OK'],
    test: ['BUILD_OK', 'TEST_RUNNING', 'TEST_OK'],
    e2e: ['TEST_OK', 'E2E_RUNNING', 'E2E_OK'],
};
export function beginStep(state, step) {
    const [required, running] = TRANSITIONS[step];
    if (state !== required)
        throw new BuilderSupervisorError('INVALID_STEP_ORDER');
    return running;
}
export function completeStep(state, step, successful) {
    const [, running, completed] = TRANSITIONS[step];
    if (state !== running)
        throw new BuilderSupervisorError('INVALID_STEP_ORDER');
    return successful ? completed : 'FAILED';
}
//# sourceMappingURL=state-machine.js.map