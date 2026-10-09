import { BuilderProvisionError, provisionBuilderSupervisor } from './store-provision.js';
export const BUILDER_PROVISION_EXIT = Object.freeze({ ok: 0, usage: 64, failed: 70 });
const DEFAULT_DEPENDENCIES = {
    provision: provisionBuilderSupervisor,
    output: value => { process.stdout.write(`${value}\n`); },
    error: value => { process.stderr.write(`${value}\n`); },
};
export async function executeBuilderProvisionCli(argv, overrides = {}) {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
    let values;
    try {
        values = parseArguments(argv);
    }
    catch {
        dependencies.error(JSON.stringify({ event: 'builder-provision-error', code: 'INVALID_ARGUMENTS' }));
        return BUILDER_PROVISION_EXIT.usage;
    }
    try {
        const result = await dependencies.provision({
            installationId: values['--installation-id'],
            tenantId: values['--tenant'],
            instanceId: values['--instance'],
            sourceRoot: values['--source-root'],
            manifestReference: values['--manifest'],
            manifestSha256: values['--manifest-sha256'],
            imageDigest: values['--image-digest'],
            policySha256: values['--policy-sha256'],
        });
        dependencies.output(publicResult(result));
        return BUILDER_PROVISION_EXIT.ok;
    }
    catch (error) {
        const code = error instanceof BuilderProvisionError ? error.code : 'PROVISION_FAILED';
        dependencies.error(JSON.stringify({ event: 'builder-provision-error', code }));
        return BUILDER_PROVISION_EXIT.failed;
    }
}
function parseArguments(argv) {
    const expected = ['--installation-id', '--tenant', '--instance', '--source-root', '--manifest', '--manifest-sha256', '--image-digest', '--policy-sha256'];
    if (argv.length !== expected.length * 2)
        invalidArguments();
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (key === undefined || !expected.includes(key) || value === undefined || value.length === 0 || values[key] !== undefined)
            invalidArguments();
        values[key] = value;
    }
    if (expected.some(key => values[key] === undefined))
        invalidArguments();
    return values;
}
function publicResult(result) {
    return JSON.stringify({
        event: 'builder-provisioned',
        state: result.state,
        scope_id: result.scope_id,
    });
}
function invalidArguments() { throw new Error('INVALID_ARGUMENTS'); }
//# sourceMappingURL=provision-main.js.map