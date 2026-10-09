/**
 * Legacy command name kept for compatibility. Parsing, verification, restore,
 * cancellation and report sanitisation belong exclusively to the packaged
 * operator; this file deliberately contains no second destructive path.
 */
import { parseOperatorCommand, runOperator, sanitizeOperatorError } from '../apps/studio-runtime/operator.mjs'

const controller = new AbortController()
const cancel = (): void => controller.abort(new Error('Operação cancelada.'))
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)

let command: ReturnType<typeof parseOperatorCommand> | undefined
try {
  command = parseOperatorCommand(['restore', ...process.argv.slice(2)])
  const report = await runOperator(command, { signal: controller.signal })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  const dsn = command?.dsnRef === undefined ? undefined : process.env[command.dsnRef]
  process.stderr.write(`${JSON.stringify({ status: 'failed', error: sanitizeOperatorError(error, dsn === undefined ? [] : [dsn]) })}\n`)
  process.exitCode = 1
} finally {
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
}
