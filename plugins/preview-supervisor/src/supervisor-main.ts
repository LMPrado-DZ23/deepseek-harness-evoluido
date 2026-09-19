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
  ...proxyUserOption(process.env.DZ23_PROXY_USER),
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

/**
 * O dono do soquete do proxy. OPCIONAL: sem ele, `10001:10001`, como na
 * instalação em contêiner, em que o harness e o proxy são o mesmo usuário.
 *
 * Na instalação NATIVA (o FRIGG rodando como a pessoa, no WSL2) o harness é o
 * usuário dela, e o soquete 0660 de um proxy 10001 fica inalcançável sem criar
 * grupo no sistema. Este valor põe o proxy como o usuário do harness. Root é
 * recusado: o proxy fica na rede do aplicativo gerado, e root ali seria a
 * única coisa que o isolamento não pode aceitar.
 * @param value - `uid:gid`, ou nada.
 * @returns a opção do supervisor.
 */
export function proxyUserOption(value: string | undefined): { readonly proxyUser?: `${number}:${number}` } {
  if (value === undefined || value === '') return {}
  const match = /^(\d{1,10}):(\d{1,10})$/u.exec(value)
  if (match === null || Number(match[1]) === 0 || Number(match[2]) === 0) throw new Error('INVALID_DZ23_PROXY_USER')
  return { proxyUser: value as `${number}:${number}` }
}

