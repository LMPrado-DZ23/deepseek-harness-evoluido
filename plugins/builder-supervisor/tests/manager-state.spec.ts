import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { constants, type Stats } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, statfs, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BuilderManagerStateError,
  FileBuilderManagerAuthority,
  MemoryBuilderManagerCheckpointPort,
  MemoryBuilderManagerLeasePort,
  type BuilderManagerStateRuntime,
  type BuilderManagerCheckpoint,
} from '../src/manager-state.js'
import { MemoryBuilderRuntimeHealthStore } from '../src/manager-health.js'
import { BuilderRuntimeManager } from '../src/manager-main.js'
import type { BuilderRuntimeRegistry } from '../src/manager-registry.js'
import type { BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'

const linux = process.platform === 'linux'
const installationId = 'a'.repeat(64)
const scopeId = `s_${'1'.repeat(48)}` as const
const children = new Set<ChildProcessWithoutNullStreams>()

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...children].map(async child => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child)
  }))
  children.clear()
})

describe.skipIf(!linux)('manager authority on Linux', () => {
  it('provides deterministic in-memory lease and checkpoint ports for isolated manager tests', async () => {
    const leases = new MemoryBuilderManagerLeasePort()
    const first = await leases.acquire()
    await expect(leases.acquire()).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
    await first.close()
    const second = await leases.acquire(); await second.close()

    const checkpoints = new MemoryBuilderManagerCheckpointPort()
    expect(await checkpoints.load()).toBeUndefined()
    const saved = checkpoint(1); await checkpoints.save(saved)
    ;(saved.slots as BuilderManagerCheckpoint['slots'] & Array<unknown>).pop()
    expect((await checkpoints.load())?.slots).toHaveLength(1)
  })

  it('holds one real manager per installation across processes and SIGKILL releases it', async () => {
    await withRoot(async (root, roots) => {
      const child = spawnLeaseChild(root)
      children.add(child)
      await waitForLine(child, 'READY')
      const second = managerFor(roots)
      await expect(second.initialize()).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
      child.kill('SIGKILL')
      await waitForExit(child); children.delete(child)
      await retryInitialize(second)
      await second.shutdown()
    })
  })

  it('bootstraps one guard under a synchronized multiprocess storm without false invalid-state failures', async () => {
    await withRoot(async (root) => {
      const contenders = Array.from({ length: 8 }, () => spawnLeaseChild(root, 'barrier'))
      for (const child of contenders) children.add(child)
      await Promise.all(contenders.map(child => waitForLine(child, 'BOOTED')))
      const outcomes = contenders.map(child => waitForAnyLine(child))
      for (const child of contenders) child.stdin.write('GO\n')
      const lines = await Promise.all(outcomes)
      expect([...lines].sort()).toEqual(['ERROR:MANAGER_ALREADY_RUNNING', 'ERROR:MANAGER_ALREADY_RUNNING', 'ERROR:MANAGER_ALREADY_RUNNING', 'ERROR:MANAGER_ALREADY_RUNNING', 'ERROR:MANAGER_ALREADY_RUNNING', 'ERROR:MANAGER_ALREADY_RUNNING', 'ERROR:MANAGER_ALREADY_RUNNING', 'READY'])
      expect(lines).not.toContain('ERROR:INVALID_MANAGER_STATE')
      for (const child of contenders) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.all(contenders.map(waitForExit)); contenders.forEach(child => children.delete(child))
    })
  })

  it('serializes a same-process bootstrap race and maps flock process failures closed', async () => {
    await withRoot(async (_root, roots) => {
      const authorities = Array.from({ length: 8 }, () => new FileBuilderManagerAuthority())
      const outcomes = await Promise.allSettled(authorities.map(authority => authority.acquire(installationId, roots)))
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(result => result.status === 'rejected').every(result => result.reason instanceof BuilderManagerStateError)).toBe(true)
      for (const outcome of outcomes) if (outcome.status === 'fulfilled') await outcome.value.close()
    })

    for (const event of ['error', 'signal'] as const) {
      await withRoot(async (_root, roots) => {
        const fakeSpawn = (() => {
          const child = new EventEmitter()
          queueMicrotask(() => {
            if (event === 'error') { child.emit('error', new Error('private-detail')); child.emit('exit', 0, null) }
            else child.emit('exit', null, 'SIGKILL')
          })
          return child
        }) as unknown as typeof spawn
        await expect(new FileBuilderManagerAuthority({ spawnFlock: fakeSpawn }).acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      })
    }
  })

  it('creates a permanent private guard and rejects a hardlink added while held', async () => {
    await withRoot(async (root, roots) => {
      const authority = new FileBuilderManagerAuthority()
      const lease = await authority.acquire(installationId, roots)
      const guard = guardPath(root)
      expect((await lstat(guard)).mode & 0o7777).toBe(0o600)
      const linked = `${guard}.linked`
      await link(guard, linked)
      await expect(lease.close()).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
      await unlink(linked)
      await expect(lease.close()).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
    })
  })

  it('retains authority when guard close is inconclusive and permits a controlled close retry', async () => {
    await withRoot(async (_root, roots) => {
      let closeAttempts = 0
      const authority = new FileBuilderManagerAuthority(stateRuntime({
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode)
          if (String(path).endsWith('.manager.guard') && flags === constants.O_RDONLY + constants.O_NOFOLLOW) {
            return new Proxy(handle, { get(target, property) {
              if (property === 'close') return async () => {
                closeAttempts += 1
                if (closeAttempts === 1) throw new Error('close-inconclusive')
                await target.close()
              }
              return Reflect.get(target, property, target)
            } })
          }
          return handle
        },
      }))
      const lease = await authority.acquire(installationId, roots)
      await expect(lease.close()).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
      await expect(lease.close()).resolves.toBeUndefined()
      expect(closeAttempts).toBe(2)
      const replacement = await authority.acquire(installationId, roots)
      await replacement.close()
    })
  })

  it('persists an exact checkpoint with fsync-safe replacement and reloads it', async () => {
    await withRoot(async (_root, roots) => {
      const authority = new FileBuilderManagerAuthority()
      const lease = await authority.acquire(installationId, roots)
      const value = checkpoint(7)
      await authority.save(value, roots)
      expect(await authority.load(installationId, roots)).toEqual(value)
      await authority.save(checkpoint(8), roots)
      expect(await authority.load(installationId, roots)).toEqual(checkpoint(8))
      await lease.close()
      await expect(lease.close()).resolves.toBeUndefined()
    })
  })

  it('fails closed for corrupt JSON, invalid UTF-8, symlink, hardlink, mode and owner', async () => {
    const mutations: Array<(path: string, root: string) => Promise<void>> = [
      async path => { await writeFile(path, '{', { mode: 0o600 }) },
      async path => { await writeFile(path, Buffer.from([0xc3]), { mode: 0o600 }) },
      async (path, root) => { const target = `${root}/outside`; await writeFile(target, '{}', { mode: 0o600 }); await unlink(path); await symlink(target, path) },
      async path => { await link(path, `${path}.linked`) },
      async path => { await chmod(path, 0o644) },
    ]
    for (const mutate of mutations) {
      await withRoot(async (root, roots) => {
        const authority = new FileBuilderManagerAuthority(); const lease = await authority.acquire(installationId, roots)
        await authority.save(checkpoint(1), roots); const path = checkpointPath(root)
        await mutate(path, root)
        await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
        await lease.close().catch(() => undefined)
      })
    }
    await withRoot(async (_root, roots) => {
      const authority = new FileBuilderManagerAuthority(); const lease = await authority.acquire(installationId, roots)
      await authority.save(checkpoint(1), roots)
      const uid = process.getuid?.() ?? 0
      vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
      await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      vi.restoreAllMocks(); await lease.close()
    })
  })

  it('rejects an unsafe writable ancestor while allowing the root-owned sticky temp directory', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'dz23-manager-unsafe-'))
    try {
      await chmod(root, 0o770)
      await expect(new FileBuilderManagerAuthority().acquire(installationId, rootsFor(root))).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects malformed checkpoint values before publishing any bytes', async () => {
    await withRoot(async (root, roots) => {
      const authority = new FileBuilderManagerAuthority(); const lease = await authority.acquire(installationId, roots)
      await expect(authority.save({ ...checkpoint(1), registrySha256: 'secret' }, roots)).rejects.toBeInstanceOf(BuilderManagerStateError)
      await expect(readFile(checkpointPath(root))).rejects.toEqual(expect.objectContaining({ code: 'ENOENT' }))
      await lease.close()
    })
  })

  it('never reads or publishes a checkpoint outside its matching held lease', async () => {
    await withRoot(async (_root, roots) => {
      const authority = new FileBuilderManagerAuthority()
      await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await expect(authority.save(checkpoint(1), roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      const lease = await authority.acquire(installationId, roots)
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
      await lease.close()
    })
  })

  it('rejects invalid roots, unsupported filesystems, corrupt guard bootstrap, and missing Linux identity', async () => {
    const authority = new FileBuilderManagerAuthority()
    for (const stateRoot of ['/', '/tmp/../unsafe', 'relative', '/tmp/bad\\root']) {
      await expect(authority.acquire(installationId, { ...rootsFor('/tmp/safe'), stateRoot })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    }
    await expect(authority.acquire(installationId, { ...rootsFor('/tmp/safe'), configRoot: '/config/../unsafe' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    await expect(authority.acquire(installationId, rootsFor('/mnt/dz23-manager-state'))).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    await expect(authority.acquire(installationId, rootsFor('/proc/dz23-manager-state-denied'))).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))

    const sharedMemory = await mkdtemp('/dev/shm/dz23-manager-state-')
    try { await expect(authority.acquire(installationId, rootsFor(sharedMemory))).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' })) }
    finally { await rm(sharedMemory, { recursive: true, force: true }) }

    await withRoot(async (root, roots) => {
      const directory = posix.dirname(guardPath(root)); await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(posix.join(directory, 'checkpoint.json'), '{}', { mode: 0o600 })
      await expect(new FileBuilderManagerAuthority().acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
    await withRoot(async (root, roots) => {
      const directory = posix.dirname(guardPath(root)); await mkdir(directory, { recursive: true, mode: 0o700 })
      const outside = posix.join(root, 'outside'); await writeFile(outside, '', { mode: 0o600 }); await symlink(outside, guardPath(root))
      await expect(new FileBuilderManagerAuthority().acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
    await withRoot(async (_root, roots) => {
      vi.spyOn(process, 'getuid').mockReturnValue(undefined as never)
      await expect(new FileBuilderManagerAuthority().acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      vi.restoreAllMocks()
    })
  })

  it('fails closed on injected filesystem and trust-boundary failures', async () => {
    await withRoot(async (_root, roots) => {
      const authority = new FileBuilderManagerAuthority(stateRuntime({ statfs: async () => ({ type: 0 }) }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
    await withRoot(async (_root, roots) => {
      const authority = new FileBuilderManagerAuthority(stateRuntime({
        lstat: async path => {
          const stat = await lstat(path)
          return path === '/usr/bin/flock' ? statWith(stat, { mode: stat.mode & ~0o111 }) : stat
        },
      }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
    await withRoot(async (root, roots) => {
      const authority = new FileBuilderManagerAuthority(stateRuntime({ mkdir: async (path, options) => {
        if (String(path).startsWith(posix.join(root, 'manager'))) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return mkdir(path, options)
      } }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
    await withRoot(async (root, roots) => {
      const authority = new FileBuilderManagerAuthority(stateRuntime({ lstat: async path => {
        if (String(path).startsWith(posix.join(root, 'manager'))) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return lstat(path)
      } }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
    await withRoot(async (root, roots) => {
      const authority = new FileBuilderManagerAuthority(stateRuntime({ lstat: async path => {
        const stat = await lstat(path)
        return String(path).includes(posix.join('manager', installationId)) ? statWith(stat, { isDirectory: () => false }) : stat
      } }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })
  })

  it('maps unexpected checkpoint-open failures and rejects a non-array checkpoint slot list', async () => {
    await withRoot(async (root, roots) => {
      let denyCheckpoint = false
      const authority = new FileBuilderManagerAuthority(stateRuntime({ open: async (path, flags, mode) => {
        if (denyCheckpoint && path === checkpointPath(root)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return open(path, flags, mode)
      } }))
      const lease = await authority.acquire(installationId, roots)
      expect(await authority.load(installationId, roots)).toBeUndefined()
      denyCheckpoint = true
      await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      denyCheckpoint = false
      await expect(authority.save({ ...checkpoint(1), slots: 'bad' } as unknown as BuilderManagerCheckpoint, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await lease.close()
    })
  })

  it('handles guard creation races and refuses unprovable guard cleanup', async () => {
    await withRoot(async (root, roots) => {
      const guard = guardPath(root)
      const authority = new FileBuilderManagerAuthority(stateRuntime({ open: async (path, flags, mode) => {
        if (path === guard && typeof flags === 'number' && (flags & constants.O_CREAT) !== 0) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return open(path, flags, mode)
      } }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
    })

    await withRoot(async (root, roots) => {
      const guard = guardPath(root); let appeared = false
      const authority = new FileBuilderManagerAuthority(stateRuntime({ readdir: async path => {
        if (!appeared && path === posix.dirname(guard)) {
          appeared = true; const created = await open(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await created.close()
          return [posix.basename(guard)]
        }
        return readdir(path)
      } }))
      const lease = await authority.acquire(installationId, roots); await lease.close()
    })

    await withRoot(async (root, roots) => {
      const guard = guardPath(root); let leaked: Awaited<ReturnType<typeof open>> | undefined
      const authority = new FileBuilderManagerAuthority(stateRuntime({ open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        if (path === guard && typeof flags === 'number' && (flags & constants.O_CREAT) !== 0) {
          leaked = handle
          return new Proxy(handle, { get(target, property) {
            if (property === 'sync') return async () => { throw new Error('sync-failed') }
            if (property === 'close') return async () => { throw new Error('close-failed') }
            return Reflect.get(target, property, target)
          } })
        }
        return handle
      } }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await leaked?.close()
    })
  })

  it('retains local authority when cleanup of a failed flock acquisition cannot be proven', async () => {
    await withRoot(async (_root, roots) => {
      let guardHandle: Awaited<ReturnType<typeof open>> | undefined
      const fakeSpawn = (() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('flock-failed'))); return child }) as unknown as typeof spawn
      const authority = new FileBuilderManagerAuthority(stateRuntime({
        spawnFlock: fakeSpawn,
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode)
          if (String(path).endsWith('.manager.guard') && flags === constants.O_RDONLY + constants.O_NOFOLLOW) {
            guardHandle = handle
            return new Proxy(handle, { get(target, property) { if (property === 'close') return async () => { throw new Error('close-failed') }; return Reflect.get(target, property, target) } })
          }
          return handle
        },
      }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await expect(authority.acquire(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'MANAGER_ALREADY_RUNNING' }))
      await guardHandle?.close()
    })
  })

  it('rejects strict checkpoint schema mutations, embedded NUL, and unsafe replacement on save', async () => {
    await withRoot(async (root, roots) => {
      const authority = new FileBuilderManagerAuthority(); const lease = await authority.acquire(installationId, roots); const valid = checkpoint(1)
      const invalidValues = [
        { ...valid, version: 2 }, { ...valid, generation: -1 }, { ...valid, generation: 1.5 }, { ...valid, registrySha256: 'bad' },
        { ...valid, extra: true }, { ...valid, slots: [{ ...valid.slots[0]!, extra: true }] },
        { ...valid, slots: Array.from({ length: 513 }, () => valid.slots[0]!) },
        { ...valid, slots: [{ ...valid.slots[0]!, scopeId: 'tenant' }] },
        { ...valid, slots: [{ ...valid.slots[0]!, configSha256: 'bad' }] },
        { ...valid, slots: [{ ...valid.slots[0]!, configReference: 'file:/wrong' }] },
        { ...valid, slots: [valid.slots[0]!, valid.slots[0]!] },
      ]
      for (const value of invalidValues) await expect(authority.save(value as BuilderManagerCheckpoint, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))

      await authority.save(valid, roots); const path = checkpointPath(root)
      await writeFile(path, Buffer.from([0x7b, 0x00, 0x7d]), { mode: 0o600 })
      await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await writeFile(path, `${JSON.stringify({ ...serializedCheckpoint(valid), extra: true })}\n`, { mode: 0o600 })
      await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await writeFile(path, '[]\n', { mode: 0o600 })
      await expect(authority.load(installationId, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      const outside = posix.join(root, 'outside-checkpoint'); await writeFile(outside, '{}', { mode: 0o600 }); await unlink(path); await symlink(outside, path)
      await expect(authority.save(valid, roots)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_MANAGER_STATE' }))
      await lease.close()
    })
  })
})

function checkpoint(generation: number): BuilderManagerCheckpoint {
  return {
    version: 1,
    installationId,
    generation,
    registrySha256: 'b'.repeat(64),
    slots: [{ scopeId, configReference: `file:/config/instances/${scopeId}/supervisor.json`, configSha256: 'c'.repeat(64) }],
  }
}

function serializedCheckpoint(value: BuilderManagerCheckpoint): Record<string, unknown> {
  return { version: value.version, installation_id: value.installationId, generation: value.generation, registry_sha256: value.registrySha256, slots: value.slots.map(slot => ({ scope_id: slot.scopeId, config_ref: slot.configReference, config_sha256: slot.configSha256 })) }
}

async function withRoot(run: (root: string, roots: BuilderSupervisorRootPolicy) => Promise<void>): Promise<void> {
  const root = await mkdtemp(posix.join(tmpdir(), 'dz23-manager-state-'))
  try { await run(root, rootsFor(root)) } finally { await rm(root, { recursive: true, force: true }) }
}

function rootsFor(root: string): BuilderSupervisorRootPolicy {
  return { configRoot: '/config', secretRoot: '/secret', socketRoot: '/run', artifactRoot: '/artifact', exportRoot: '/export', stateRoot: root, dockerSocketPath: '/docker.sock' }
}

function stateRuntime(overrides: Partial<BuilderManagerStateRuntime>): BuilderManagerStateRuntime {
  return { spawnFlock: spawn, getuid: () => process.getuid?.(), open, lstat, mkdir, readdir, realpath, rename, statfs, unlink, ...overrides }
}

function statWith(stat: Stats, values: Partial<Stats>): Stats {
  return new Proxy(stat, { get(target, property) { return property in values ? values[property as keyof Stats] : Reflect.get(target, property, target) } })
}

function guardPath(root: string): string { return posix.join(root, 'manager', installationId, '.manager.guard') }
function checkpointPath(root: string): string { return posix.join(root, 'manager', installationId, 'checkpoint.json') }

function spawnLeaseChild(root: string, mode?: 'barrier'): ChildProcessWithoutNullStreams {
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const fixture = fileURLToPath(new URL('./fixtures/manager-lease-child.ts', import.meta.url))
  return spawn(process.execPath, ['--import', tsxLoader, fixture, root, installationId, ...(mode === undefined ? [] : [mode])], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  const line = await waitForAnyLine(child)
  expect(line).toBe(expected)
}

async function waitForAnyLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('CHILD_READY_TIMEOUT')), 15_000)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.includes('\n')) { clearTimeout(timer); resolve(output.trim()) } })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CHILD_EXIT_${String(code)}`)) })
  })
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('exit', exited); reject(new Error('CHILD_EXIT_TIMEOUT')) }, 5_000)
    const exited = () => { clearTimeout(timer); resolve() }
    child.once('exit', exited)
    if (child.exitCode !== null || child.signalCode !== null) { child.off('exit', exited); clearTimeout(timer); resolve() }
  })
}

function managerFor(roots: BuilderSupervisorRootPolicy): BuilderRuntimeManager {
  const authority = new FileBuilderManagerAuthority()
  const registry: BuilderRuntimeRegistry = { version: 1, installationId, generation: 1, slots: [], sha256: 'b'.repeat(64) }
  return new BuilderRuntimeManager({
    registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 1_000, maximumGlobalBuilds: 1,
    dependencies: { loadRegistry: async () => registry, startSlot: async () => { throw new Error('UNEXPECTED_SLOT') }, health: new MemoryBuilderRuntimeHealthStore(), lease: authority, checkpoint: authority, now: () => new Date(), error: () => undefined },
  })
}

async function retryInitialize(manager: BuilderRuntimeManager): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await manager.initialize() }
    catch (error) { if (!(error instanceof BuilderManagerStateError) || error.code !== 'MANAGER_ALREADY_RUNNING') throw error }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('LEASE_RELEASE_TIMEOUT')
}
