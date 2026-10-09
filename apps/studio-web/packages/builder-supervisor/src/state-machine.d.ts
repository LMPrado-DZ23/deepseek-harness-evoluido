import type { BuildState, BuildStep } from './model.js';
export declare function beginStep(state: BuildState, step: BuildStep): BuildState;
export declare function completeStep(state: BuildState, step: BuildStep, successful: boolean): BuildState;
//# sourceMappingURL=state-machine.d.ts.map