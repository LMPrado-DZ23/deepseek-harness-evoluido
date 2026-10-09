import { MemoryBuilderRuntimeHealthStore } from '../../src/manager-health.js'
import { BuilderRuntimeManager } from '../../src/manager-main.js'
import { FileBuilderManagerAuthority } from '../../src/manager-state.js'
import type { BuilderRuntimeRegistry } from '../../src/manager-registry.js'
import type { BuilderSupervisorRootPolicy } from '../../src/supervisor-config.js'

const [stateRoot, installationId, mode] = process.argv.slice(2)
if (stateRoot === undefined || installationId === undefined) process.exit(64)

const roots: BuilderSupervisorRootPolicy = {
  configRoot: '/config',
  secretRoot: '/secret',
  socketRoot: '/run',
  artifactRoot: '/artifact',
  exportRoot: '/export',
  stateRoot,
  dockerSocketPath: '/docker.sock',
}
const registry: BuilderRuntimeRegistry = { version: 1, installationId, generation: 1, sha256: 'b'.repeat(64), slots: [] }
const authority = new FileBuilderManagerAuthority()
const manager = new BuilderRuntimeManager({
  registryReference: 'file:/config/manager/runtime-registry.json',
  roots,
  drainTimeoutMs: 100,
  reloadTimeoutMs: 1_000,
  maximumGlobalBuilds: 1,
  dependencies: {
    loadRegistry: async () => registry,
    startSlot: async () => { throw new Error('UNEXPECTED_SLOT') },
    health: new MemoryBuilderRuntimeHealthStore(),
    lease: authority,
    checkpoint: authority,
    now: () => new Date(),
    error: () => undefined,
  },
})
if (mode === 'barrier') {
  process.stdout.write('BOOTED\n')
  await new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
}
try { await manager.initialize() }
catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { readonly code: unknown }).code) : 'UNKNOWN'
  await new Promise<void>(resolve => process.stdout.write(`ERROR:${code}\n`, () => resolve()))
  process.exit(1)
}
process.stdout.write('READY\n')
const keepAlive = setInterval(() => undefined, 60_000)
const stop = async () => { clearInterval(keepAlive); await manager.shutdown(); process.exit(0) }
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
