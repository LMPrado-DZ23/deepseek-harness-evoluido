import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { provisionBuilderSupervisor, type BuilderProvisionRequest, type BuilderProvisionRuntime } from '../../src/store-provision.js'

const [, , requestPath, mode, readyPath, gatePath, resultPath] = process.argv
if (requestPath === undefined || mode === undefined) process.exit(64)
const request = JSON.parse(await readFile(requestPath, 'utf8')) as BuilderProvisionRequest

async function signalReadyAndWait(): Promise<void> {
  if (readyPath === undefined || gatePath === undefined) process.exit(65)
  const ready = await open(readyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  await ready.writeFile('ready\n', 'utf8')
  await ready.sync()
  await ready.close()
  for (;;) {
    try { await readFile(gatePath); return }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

const runtime: BuilderProvisionRuntime = mode === 'crash-before-unlink'
  ? { beforeStaleLockPathUnlink: async () => { process.kill(process.pid, 'SIGKILL') } }
  : mode === 'crash-after-unlink'
    ? { afterStaleLockPathUnlink: async () => { process.kill(process.pid, 'SIGKILL') } }
    : mode === 'crash-during-store'
      ? { afterTemplateStoreEntryCopied: async () => { process.kill(process.pid, 'SIGKILL') } }
    : mode === 'pause-acquire'
      ? { afterProvisionCoordinatorAcquired: async phase => { if (phase === 'acquire') await signalReadyAndWait() } }
      : mode === 'pause-release'
        ? { beforeProvisionLockRelease: signalReadyAndWait }
        : {}

let result: unknown
try { result = await provisionBuilderSupervisor(request, runtime) }
catch (error) { result = { error: error instanceof Error && 'code' in error ? (error as { code: unknown }).code : 'UNKNOWN' } }
if (resultPath !== undefined) {
  const output = await open(resultPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  await output.writeFile(`${JSON.stringify(result)}\n`, 'utf8')
  await output.sync()
  await output.close()
}
