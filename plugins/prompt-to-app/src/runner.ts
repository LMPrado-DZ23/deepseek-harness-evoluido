import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { t } from './i18n.js'

export const PROCESS_OUTPUT_BYTE_LIMIT = 512 * 1024

export type ProcessTerminationReason = 'timeout' | 'output_limit'
export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** Present on enforced termination; optional to preserve third-party ProcessPort compatibility. */
  readonly terminationReason?: ProcessTerminationReason
  readonly outputLimitExceeded?: boolean
}
export interface ProcessPort { run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> }

export class NodeProcessPort implements ProcessPort {
  run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { reject(new Error('PROCESS_TIMEOUT_INVALID')); return }
      const child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // A separate POSIX process group lets us terminate grandchildren too.
        detached: process.platform !== 'win32',
      })
      const stdout: Buffer[] = []; const stderr: Buffer[] = []
      let capturedBytes = 0
      let terminationReason: ProcessTerminationReason | undefined
      let terminationPromise: Promise<void> | undefined
      let settled = false

      const terminate = (reason: ProcessTerminationReason) => {
        if (terminationReason !== undefined) return
        terminationReason = reason
        terminationPromise = terminateProcessTree(child)
      }
      const capture = (target: Buffer[], chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = PROCESS_OUTPUT_BYTE_LIMIT - capturedBytes
        if (remaining > 0) {
          const accepted = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining)
          target.push(Buffer.from(accepted))
          capturedBytes += accepted.length
        }
        if (bytes.length > remaining) terminate('output_limit')
        // Keep the listener attached after overflow so OS pipes remain drained.
      }
      child.stdout.on('data', (chunk: Buffer | string) => { capture(stdout, chunk) })
      child.stderr.on('data', (chunk: Buffer | string) => { capture(stderr, chunk) })
      const timer = setTimeout(() => { terminate('timeout') }, timeoutMs)
      child.once('error', error => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        void (async () => {
          await terminationPromise
          if (settled) return
          settled = true
          resolveResult({
            exitCode: code ?? -1,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut: terminationReason === 'timeout',
            ...(terminationReason === undefined ? {} : { terminationReason }),
            outputLimitExceeded: terminationReason === 'output_limit',
          })
        })()
      })
    })
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) { child.kill('SIGKILL'); return }
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    return
  }
  await new Promise<void>(resolveTaskkill => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(fallback)
      child.kill('SIGKILL')
      resolveTaskkill()
    }
    const fallback = setTimeout(() => { killer.kill('SIGKILL'); finish() }, 5_000)
    killer.once('error', finish)
    killer.once('close', finish)
  })
}

export interface BuilderLimits { readonly pids: number; readonly memory: string; readonly cpus: string; readonly timeoutMs: number }
export interface ContainerBuilderConfig {
  readonly engine: 'docker' | 'podman'
  readonly imageDigest: `sha256:${string}`
  readonly templateStore: string
  readonly user: `${number}:${number}`
  readonly limits: BuilderLimits
}

export interface BuilderPreflight { readonly state: 'OK' | 'BLOCKED_EXTERNAL'; readonly message: string }
export interface BuilderStepResult extends ProcessResult { readonly command: string; readonly securityArgs: readonly string[] }

export class BuilderContainerCleanupError extends Error {
  readonly code = 'BUILDER_CONTAINER_CLEANUP_FAILED'
  constructor(readonly containerName: string, options?: ErrorOptions) { super('BUILDER_CONTAINER_CLEANUP_FAILED', options) }
}

export class ContainerBuilder {
  constructor(private readonly config: ContainerBuilderConfig, private readonly process: ProcessPort = new NodeProcessPort()) {}

  async preflight(): Promise<BuilderPreflight> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(this.config.imageDigest)) return { state: 'BLOCKED_EXTERNAL', message: t('errors.builderImage') }
    const checks: readonly (readonly string[])[] = [
      ['version', '--format', '{{.Server.Version}}'],
      ['image', 'inspect', this.config.imageDigest, '--format', '{{.Id}}'],
    ]
    for (const args of checks) {
      try {
        const result = await this.process.run(this.config.engine, args, 15_000)
        if (result.exitCode !== 0 || result.timedOut) return blocked()
      } catch { return blocked() }
    }
    return { state: 'OK', message: t('errors.builderAvailable') }
  }

  commandArgs(runDirectory: string, command: string, containerName = uniqueContainerName()): readonly string[] {
    const security = [
      '--network', 'none', '--user', this.config.user, '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--pids-limit', String(this.config.limits.pids),
      '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/.config', '--env', 'CI=true',
      '--env', 'NEXT_TELEMETRY_DISABLED=1',
      '--shm-size', '256m',
      '--memory', this.config.limits.memory, '--cpus', this.config.limits.cpus,
    ]
    return [
      'run', '--rm', '--name', containerName, ...security,
      '--mount', `type=bind,src=${resolve(runDirectory)},dst=/workspace`,
      '--mount', `type=bind,src=${resolve(this.config.templateStore)},dst=/template-store,readonly`,
      '--workdir', '/workspace', this.config.imageDigest, 'sh', '-lc', command,
    ]
  }

  async execute(runDirectory: string, command: string): Promise<BuilderStepResult> {
    const root = await realpath(runDirectory)
    const containerName = uniqueContainerName()
    const args = this.commandArgs(root, command, containerName)
    let result: ProcessResult
    try {
      result = await this.process.run(this.config.engine, args, this.config.limits.timeoutMs)
    } catch (error) {
      await this.removeContainer(containerName, error)
      throw error
    }
    if (result.timedOut || result.terminationReason === 'output_limit' || result.outputLimitExceeded === true) {
      await this.removeContainer(containerName)
    }
    return { ...result, command, securityArgs: args }
  }

  private async removeContainer(containerName: string, originalError?: unknown): Promise<void> {
    try {
      const cleanup = await this.process.run(this.config.engine, ['rm', '-f', containerName], 15_000)
      if (cleanup.exitCode === 0 && !cleanup.timedOut && cleanup.outputLimitExceeded !== true) return
      const inspect = await this.process.run(this.config.engine, ['inspect', containerName], 15_000)
      if (inspect.exitCode !== 0 && !inspect.timedOut && inspect.outputLimitExceeded !== true) return
      throw new Error('CONTAINER_REMOVE_UNCONFIRMED')
    } catch (cleanupError) {
      throw new BuilderContainerCleanupError(containerName, { cause: originalError ?? cleanupError })
    }
  }
}

function uniqueContainerName(): string { return `dz23-build-${randomUUID()}` }

function blocked(): BuilderPreflight { return { state: 'BLOCKED_EXTERNAL', message: t('errors.builderUnavailable') } }

export async function hashTree(root: string, ignored: ReadonlySet<string> = new Set()): Promise<string> {
  const files = await listTreeFiles(root)
  const hash = createHash('sha256')
  for (const relative of files) {
    if (ignored.has(relative)) continue
    hash.update(relative).update('\0').update(await readFile(resolve(root, relative))).update('\0')
  }
  return hash.digest('hex')
}

export async function listTreeFiles(root: string): Promise<readonly string[]> {
  const absoluteRoot = resolve(root)
  const rootInfo = await lstat(absoluteRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(t('errors.templateSymlink', { path: absoluteRoot }))
  return (await walk(absoluteRoot)).map(path => path.slice(absoluteRoot.length + 1).replaceAll('\\', '/'))
}

export const PREVIEW_ARTIFACT_RELATIVE_PATH = '.dz23/preview-artifact-v1'
const PREVIEW_ARTIFACT_FILE_LIMIT = 20_000
const PREVIEW_ARTIFACT_BYTE_LIMIT = 128 * 1024 * 1024

/**
 * Materializes the only files the preview runtime may execute. The deployment
 * tree is separate from the pnpm workspace so dependency symlinks and build
 * caches never cross the supervisor boundary.
 */
export async function materializePreviewArtifact(runDirectory: string): Promise<{ readonly path: string; readonly sha256: string }> {
  const root = await realpath(runDirectory)
  const target = resolve(root, PREVIEW_ARTIFACT_RELATIVE_PATH)
  await mkdir(dirname(target), { recursive: true, mode: 0o755 })
  await mkdir(target, { mode: 0o755 })
  const sources = [
    { source: resolve(root, '.next', 'standalone'), target: resolve(target, '.next', 'standalone'), required: true },
    { source: resolve(root, '.next', 'static'), target: resolve(target, '.next', 'static'), required: true },
    { source: resolve(root, 'public'), target: resolve(target, 'public'), required: false },
  ] as const
  const budget = { files: 0, bytes: 0 }
  for (const item of sources) await copyDeploymentTree(item.source, item.target, item.required, budget, root, new Set())
  const server = await lstat(resolve(target, '.next', 'standalone', 'server.js')).catch(() => undefined)
  if (server === undefined || !server.isFile() || server.isSymbolicLink()) throw new Error('PREVIEW_ARTIFACT_SERVER_MISSING')
  return { path: target, sha256: await hashTree(target) }
}

async function copyDeploymentTree(source: string, target: string, required: boolean, budget: { files: number; bytes: number }, allowedRoot: string, active: Set<string>): Promise<void> {
  const rootInfo = await lstat(source).catch(() => undefined)
  if (rootInfo === undefined) {
    if (required) throw new Error('PREVIEW_ARTIFACT_SOURCE_MISSING')
    return
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('PREVIEW_ARTIFACT_SOURCE_INVALID')
  const realSource = await realpath(source)
  if (!isWithin(allowedRoot, realSource) || active.has(realSource)) throw new Error('PREVIEW_ARTIFACT_LINK_INVALID')
  active.add(realSource)
  await mkdir(target, { recursive: true, mode: 0o755 })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const from = resolve(source, entry.name)
    const to = resolve(target, entry.name)
    if (relative(target, to).startsWith('..')) throw new Error('PREVIEW_ARTIFACT_PATH_INVALID')
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      const linked = await realpath(from)
      if (!isWithin(allowedRoot, linked)) throw new Error('PREVIEW_ARTIFACT_LINK_OUTSIDE_RUN')
      const linkedInfo = await lstat(linked)
      if (linkedInfo.isDirectory()) await copyDeploymentTree(linked, to, true, budget, allowedRoot, active)
      else await copyDeploymentFile(linked, to, linkedInfo, budget)
      continue
    }
    if (info.isDirectory()) { await copyDeploymentTree(from, to, true, budget, allowedRoot, active); continue }
    await copyDeploymentFile(from, to, info, budget)
  }
  active.delete(realSource)
}

async function copyDeploymentFile(source: string, target: string, info: Stats, budget: { files: number; bytes: number }): Promise<void> {
  if (!info.isFile()) throw new Error('PREVIEW_ARTIFACT_ENTRY_INVALID')
  budget.files += 1; budget.bytes += info.size
  if (budget.files > PREVIEW_ARTIFACT_FILE_LIMIT || budget.bytes > PREVIEW_ARTIFACT_BYTE_LIMIT) throw new Error('PREVIEW_ARTIFACT_LIMIT')
  await copyFile(source, target, 1)
}

function isWithin(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`) }

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    const path = resolve(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(t('errors.templateSymlink', { path }))
    if (entry.isDirectory()) return walk(path)
    const info = await stat(path)
    return info.isFile() ? [path] : []
  }))
  return nested.flat()
}

export const OFFLINE_PIPELINE_COMMANDS = [
  'pnpm install --offline --frozen-store --frozen-lockfile --trust-lockfile --store-dir /template-store --ignore-scripts',
  'pnpm run build',
  'pnpm run test',
  'pnpm run test:e2e',
] as const
