import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneratedFileRejectedError, validateGeneratedPath, writeGeneratedFiles } from '../src/generator.js'
import {
  BuilderContainerCleanupError,
  ContainerBuilder,
  hashTree,
  NodeProcessPort,
  OFFLINE_PIPELINE_COMMANDS,
  PROCESS_OUTPUT_BYTE_LIMIT,
  type ProcessPort,
} from '../src/runner.js'
import { isValidCpf, scanGeneratedContent } from '../src/security.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function temp() { const path = await mkdtemp(join(tmpdir(), 'dz23-p32-')); temporary.push(path); return path }

function config(imageDigest = `sha256:${'a'.repeat(64)}` as const) {
  return { engine: 'docker' as const, imageDigest, templateStore: '/store', user: '1000:1000' as const, limits: { pids: 128, memory: '2g', cpus: '2', timeoutMs: 5_000 } }
}

describe('generated file fence', () => {
  it('accepts only unique files below src and content', async () => {
    const root = await temp(); await mkdir(join(root, 'src')); await mkdir(join(root, 'content'))
    await expect(writeGeneratedFiles(root, [{ path: 'src/App.tsx', content: 'ok' }, { path: 'content/app.json', content: '{}' }], { plannedPaths: ['src/App.tsx', 'content/app.json'] })).resolves.toEqual(['src/App.tsx', 'content/app.json'])
    expect(await readFile(join(root, 'src/App.tsx'), 'utf8')).toBe('ok')
    await expect(writeGeneratedFiles(root, [{ path: 'src/App.tsx', content: 'again' }])).rejects.toThrow()
    await expect(writeGeneratedFiles(root, [{ path: 'src/a.ts', content: '' }, { path: 'src/a.ts', content: '' }])).rejects.toBeInstanceOf(GeneratedFileRejectedError)
  })

  it('allows only plan-listed changes to generated files and never overwrites template files', async () => {
    const root = await temp(); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/existing.ts'), 'old')
    const file = [{ path: 'src/existing.ts', content: 'new' }]
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/other.ts'], mutableGeneratedPaths: ['src/existing.ts'] })).rejects.toThrow('fora do plano')
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/existing.ts'], mutableGeneratedPaths: ['src/existing.ts'], protectedTemplatePaths: ['src/existing.ts'] })).rejects.toThrow('protegido do template')
    await expect(writeGeneratedFiles(root, file, { plannedPaths: ['src/existing.ts'], mutableGeneratedPaths: ['src/existing.ts'] })).resolves.toEqual(['src/existing.ts'])
    expect(await readFile(join(root, 'src/existing.ts'), 'utf8')).toBe('new')
  })

  it.each(['/tmp/x', '../x', 'src/../x', 'package.json', 'src//x', 'C:\\x'])('rejects unsafe path %s', value => {
    expect(() => validateGeneratedPath(value)).toThrow(GeneratedFileRejectedError)
  })

  it.each(['src/evil.css', 'src/evil.module.css', 'src/evil.scss', 'content/other.json', 'content/app.md'])(
    'rejects an unreviewed generated file type or content path: %s',
    value => expect(() => validateGeneratedPath(value)).toThrow(GeneratedFileRejectedError),
  )
})

describe('container builder', () => {
  it('fails closed when digest or engine/image checks are unavailable', async () => {
    const invalid = new ContainerBuilder(config('sha256:no' as `sha256:${string}`), { run: vi.fn() })
    await expect(invalid.preflight()).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const failed: ProcessPort = { run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '', timedOut: false }) }
    await expect(new ContainerBuilder(config(), failed).preflight()).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const thrown: ProcessPort = { run: vi.fn().mockRejectedValue(new Error('missing')) }
    await expect(new ContainerBuilder(config(), thrown).preflight()).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
  })

  it('pins every required security control and never exposes network or docker socket', async () => {
    const process: ProcessPort = { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) }
    const root = await temp(); const store = await temp()
    const builder = new ContainerBuilder({ ...config(), templateStore: store }, process)
    await expect(builder.preflight()).resolves.toMatchObject({ state: 'OK' })
    const result = await builder.execute(root, 'pnpm run build')
    const args = result.securityArgs.join(' ')
    expect(args).toContain('--network none'); expect(args).toContain('--cap-drop ALL')
    expect(args).toContain('--security-opt no-new-privileges'); expect(args).toContain('--read-only')
    expect(args).toContain('/template-store,readonly'); expect(args).toContain('dst=/workspace')
    expect(args).toContain('HOME=/tmp'); expect(args).toContain('XDG_CONFIG_HOME=/tmp/.config')
    expect(args).toContain('CI=true'); expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--frozen-store')
    expect(args).toContain('--shm-size'); expect(args).toContain('256m')
    expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--trust-lockfile'); expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--ignore-scripts')
    expect(args).not.toContain('docker.sock'); expect(args).not.toContain('--privileged')
    expect(OFFLINE_PIPELINE_COMMANDS[0]).toContain('--offline')
  })

  it('assigns a unique name and force-removes a container after enforced termination', async () => {
    const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = []
    const processPort: ProcessPort = {
      run: vi.fn(async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs })
        if (args[0] === 'run') {
          return { exitCode: -1, stdout: 'bounded', stderr: '', timedOut: false, terminationReason: 'output_limit' as const, outputLimitExceeded: true }
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      }),
    }
    const builder = new ContainerBuilder(config(), processPort)
    const root = await temp()
    await expect(builder.execute(root, 'pnpm run build')).resolves.toMatchObject({ terminationReason: 'output_limit' })
    expect(calls).toHaveLength(2)
    const nameIndex = calls[0]!.args.indexOf('--name')
    const containerName = calls[0]!.args[nameIndex + 1]
    expect(containerName).toMatch(/^dz23-build-[0-9a-f-]{36}$/u)
    expect(calls[1]).toMatchObject({ command: 'docker', args: ['rm', '-f', containerName], timeoutMs: 15_000 })
  })

  it('uses a different container name on every execution', async () => {
    const names: string[] = []
    const processPort: ProcessPort = {
      run: vi.fn(async (_command, args) => {
        if (args[0] === 'run') names.push(args[args.indexOf('--name') + 1]!)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      }),
    }
    const builder = new ContainerBuilder(config(), processPort)
    const root = await temp()
    await builder.execute(root, 'pnpm run build')
    await builder.execute(root, 'pnpm run test')
    expect(new Set(names).size).toBe(2)
  })

  it('fails closed when a force-remove cannot be confirmed', async () => {
    const processPort: ProcessPort = {
      run: vi.fn(async (_command, args) => args[0] === 'run'
        ? { exitCode: -1, stdout: '', stderr: '', timedOut: true, terminationReason: 'timeout' as const }
        : args[0] === 'rm'
          ? { exitCode: 1, stdout: '', stderr: 'remove failed', timedOut: false }
          : { exitCode: 0, stdout: 'still exists', stderr: '', timedOut: false }),
    }
    const builder = new ContainerBuilder(config(), processPort)
    await expect(builder.execute(await temp(), 'pnpm run build')).rejects.toBeInstanceOf(BuilderContainerCleanupError)
  })

  it('accepts a missing container as already cleaned after rm races with --rm', async () => {
    const processPort: ProcessPort = {
      run: vi.fn(async (_command, args) => args[0] === 'run'
        ? { exitCode: -1, stdout: '', stderr: '', timedOut: true, terminationReason: 'timeout' as const }
        : { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false }),
    }
    const builder = new ContainerBuilder(config(), processPort)
    await expect(builder.execute(await temp(), 'pnpm run build')).resolves.toMatchObject({ terminationReason: 'timeout' })
    expect(processPort.run).toHaveBeenCalledTimes(3)
  })

  it('hashes immutable trees, rejects symlinks and scans secrets and valid CPF without blocking phones', async () => {
    const root = await temp(); await writeFile(join(root, 'a'), 'one'); const first = await hashTree(root)
    expect(first).toMatch(/^[a-f0-9]{64}$/u); await writeFile(join(root, 'a'), 'two'); expect(await hashTree(root)).not.toBe(first)
    const holder = await temp(); const linkedRoot = join(holder, 'linked-root'); await symlink(root, linkedRoot, 'dir')
    await expect(hashTree(linkedRoot)).rejects.toThrow('Link simbólico')
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('111.444.777-35')).toBe(true)
    expect(isValidCpf('123.456.789-00')).toBe(false)
    expect(isValidCpf('11111111111')).toBe(false)
    expect(isValidCpf('123')).toBe(false)
    expect(isValidCpf('52998224724')).toBe(false)
    expect(scanGeneratedContent({ 'src/a.ts': 'const key="sk-abcdefghijklmnopqrstuvwxyz"', 'content/a': 'CPF 529.982.247-25' })).toEqual(['src/a.ts:SECRET_PATTERN', 'content/a:PII_PATTERN'])
    expect(scanGeneratedContent({ 'content/a': 'CPF informado: 52998224725' })).toEqual(['content/a:PII_PATTERN'])
    expect(scanGeneratedContent({ 'src/a.ts': 'Telefone 11987654321', 'content/a': 'CPF 123.456.789-00' })).toEqual([])
  })
})

describe('node process port', () => {
  it('caps combined stdout and stderr and reports output_limit structurally', async () => {
    const script = [
      "const fs = require('node:fs')",
      `fs.writeSync(1, Buffer.alloc(${Math.floor(PROCESS_OUTPUT_BYTE_LIMIT * 0.75)}, 97))`,
      `fs.writeSync(2, Buffer.alloc(${Math.floor(PROCESS_OUTPUT_BYTE_LIMIT * 0.75)}, 98))`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const result = await new NodeProcessPort().run(process.execPath, ['-e', script], 5_000)
    expect(result).toMatchObject({ timedOut: false, terminationReason: 'output_limit', outputLimitExceeded: true })
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(PROCESS_OUTPUT_BYTE_LIMIT)
  })

  it('times out and terminates the spawned process tree', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(String(child.pid) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const result = await new NodeProcessPort().run(process.execPath, ['-e', script], 300)
    expect(result).toMatchObject({ timedOut: true, terminationReason: 'timeout', outputLimitExceeded: false })
    const descendantPid = Number.parseInt(result.stdout.trim(), 10)
    expect(Number.isSafeInteger(descendantPid)).toBe(true)
    await expect(waitUntilDead(descendantPid)).resolves.toBeUndefined()
  })

  it('rejects an invalid timeout before spawning', async () => {
    await expect(new NodeProcessPort().run(process.execPath, ['-e', ''], 0)).rejects.toThrow('PROCESS_TIMEOUT_INVALID')
  })
})

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`DESCENDANT_PROCESS_STILL_ALIVE:${pid}`)
}
