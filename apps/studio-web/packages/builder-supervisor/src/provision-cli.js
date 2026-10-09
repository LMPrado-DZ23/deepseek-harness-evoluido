import { BUILDER_PROVISION_EXIT, executeBuilderProvisionCli } from './provision-main.js';
void executeBuilderProvisionCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = BUILDER_PROVISION_EXIT.failed; });
//# sourceMappingURL=provision-cli.js.map