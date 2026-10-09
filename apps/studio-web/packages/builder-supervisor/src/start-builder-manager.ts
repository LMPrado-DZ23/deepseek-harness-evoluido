import { BUILDER_MANAGER_EXIT, executeBuilderRuntimeManagerCli } from './manager-main.js'

try { process.exitCode = await executeBuilderRuntimeManagerCli(process.argv.slice(2)) }
catch { process.exitCode = BUILDER_MANAGER_EXIT.startup }
