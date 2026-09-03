import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { t } from './i18n.js'

export interface ProcessResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export interface ProcessPort { run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> }

export class NodeProcessPort implements ProcessPort {
  run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''; let stderr = ''; let timedOut = false
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += String(chunk) })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk) })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolveResult({ exitCode: code ?? -1, stdout, stderr, timedOut }) })
    })
  }
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

  commandArgs(runDirectory: string, command: string): readonly string[] {
    const security = [
      '--network', 'none', '--user', this.config.user, '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--pids-limit', String(this.config.limits.pids),
      '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/.config', '--env', 'CI=true',
      '--shm-size', '256m',
      '--memory', this.config.limits.memory, '--cpus', this.config.limits.cpus,
    ]
    return [
      'run', '--rm', ...security,
      '--mount', `type=bind,src=${resolve(runDirectory)},dst=/workspace`,
      '--mount', `type=bind,src=${resolve(this.config.templateStore)},dst=/template-store,readonly`,
      '--workdir', '/workspace', this.config.imageDigest, 'sh', '-lc', command,
    ]
  }

  async execute(runDirectory: string, command: string): Promise<BuilderStepResult> {
    const root = await realpath(runDirectory)
    const args = this.commandArgs(root, command)
    const result = await this.process.run(this.config.engine, args, this.config.limits.timeoutMs)
    return { ...result, command, securityArgs: args }
  }
}

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
  return (await walk(absoluteRoot)).map(path => path.slice(absoluteRoot.length + 1).replaceAll('\\', '/'))
}

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
