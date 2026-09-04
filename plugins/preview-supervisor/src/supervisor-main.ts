import { readFile } from 'node:fs/promises'
import { DockerEngine } from './docker-engine.js'
import { DockerPreviewSupervisor } from './docker-manager.js'
import { listenSupervisorUnix } from './unix-server.js'

const tokenFile = requiredPath('DZ23_SUPERVISOR_TOKEN_FILE')
const manager = new DockerPreviewSupervisor({
  engine: new DockerEngine({ socketPath: requiredPath('DZ23_DOCKER_SOCKET') }),
  artifactRoot: requiredPath('DZ23_ARTIFACT_ROOT'),
  proxySocketRoot: requiredPath('DZ23_PROXY_SOCKET_ROOT'),
  proxySocketMount: { type: 'volume', source: requiredName('DZ23_PROXY_SOCKET_VOLUME') },
  runtimeImageDigest: requiredDigest('DZ23_RUNTIME_IMAGE_DIGEST'),
  proxyImageDigest: requiredDigest('DZ23_PROXY_IMAGE_DIGEST'),
  instanceId: requiredName('DZ23_INSTANCE_ID'),
})
const token = (await readFile(tokenFile, 'utf8')).trim()
const controller = new AbortController()
await manager.preflight(controller.signal)
await manager.drain(AbortSignal.timeout(30_000))
const listener = await listenSupervisorUnix({
  socketPath: requiredPath('DZ23_SUPERVISOR_SOCKET'), bearerToken: token, manager, signal: controller.signal,
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (stopping) return
  stopping = true
  controller.abort()
  void (async () => {
    let failed = false
    try { await listener.close() } catch { failed = true }
    try { await manager.drain(AbortSignal.timeout(30_000)) } catch { failed = true }
    process.exit(failed ? 1 : 0)
  })()
})

function requiredPath(name: string): string {
  const value = process.env[name]
  if (value === undefined || !value.startsWith('/') || value.includes('\0') || value.includes('\\')) throw new Error(`INVALID_${name}`)
  return value
}
function requiredName(name: string): string {
  const value = process.env[name]
  if (value === undefined || !/^[a-zA-Z0-9_.-]{3,100}$/u.test(value)) throw new Error(`INVALID_${name}`)
  return value
}
function requiredDigest(name: string): `sha256:${string}` {
  const value = process.env[name]
  if (value === undefined || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`INVALID_${name}`)
  return value as `sha256:${string}`
}
