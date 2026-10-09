import { provisionBuilderSupervisor } from './store-provision.js';
export declare const BUILDER_PROVISION_EXIT: Readonly<{
    ok: 0;
    usage: 64;
    failed: 70;
}>;
export interface BuilderProvisionCliDependencies {
    readonly provision: typeof provisionBuilderSupervisor;
    readonly output: (value: string) => void;
    readonly error: (value: string) => void;
}
export declare function executeBuilderProvisionCli(argv: readonly string[], overrides?: Partial<BuilderProvisionCliDependencies>): Promise<number>;
//# sourceMappingURL=provision-main.d.ts.map