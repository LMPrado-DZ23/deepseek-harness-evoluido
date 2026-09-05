import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'

const CONFIG_KEYS = [
  'artifact_root',
  'bearer_token_ref',
  'docker_socket_path',
  'export_root',
  'image_digest_ref',
  'instance_id',
  'journal_root',
  'policy_sha256_ref',
  'socket_path',
  'template_store_sha256_ref',
  'template_store_version',
  'tenant_id',
  'version',
] as const

export class BuilderSupervisorConfigError extends Error {
  readonly code = 'INVALID_SUPERVISOR_CONFIGURATION'
  constructor() { super('INVALID_SUPERVISOR_CONFIGURATION') }
}

export interface BuilderSupervisorRootPolicy {
  readonly configRoot: string
  readonly secretRoot: string
  readonly socketRoot: string
  readonly artifactRoot: string
  readonly exportRoot: string
  readonly stateRoot: string
  readonly dockerSocketPath: string
}

export const PRODUCTION_BUILDER_ROOT_POLICY: BuilderSupervisorRootPolicy = Object.freeze({
  configRoot: '/etc/dz23-studio/builder',
  secretRoot: '/run/secrets/dz23-studio/builder',
  socketRoot: '/run/dz23-studio/builder',
  artifactRoot: '/srv/dz23-studio/generated-runs',
  exportRoot: '/srv/dz23-studio/builder-exports',
  stateRoot: '/var/lib/dz23-studio/builder',
  dockerSocketPath: '/var/run/docker.sock',
})

export interface BuilderSupervisorResolvedConfig {
  readonly tenantId: string
  readonly instanceId: string
  readonly socketPath: string
  readonly artifactRoot: string
  readonly exportRoot: string
  readonly journalRoot: string
  readonly dockerSocketPath: string
  readonly bearerToken: string
  readonly imageDigest: `sha256:${string}`
  readonly templateStoreVersion: string
  readonly templateStoreSha256: string
  readonly policySha256: string
}

export interface SupervisorConfigRuntime {
  readonly platform: NodeJS.Platform
  readonly uid: number | undefined
  readonly noFollowFlag: number
  readonly open: (path: string, flags: number) => Promise<FileHandle>
  readonly lstat: (path: string) => Promise<Stats>
  readonly realpath: (path: string) => Promise<string>
}

const DEFAULT_RUNTIME: SupervisorConfigRuntime = {
  platform: process.platform,
  uid: process.getuid?.(),
  noFollowFlag: process.platform === 'linux' ? constants.O_NOFOLLOW : 0,
  open,
  lstat,
  realpath,
}

export async function loadBuilderSupervisorConfig(
  configReference: string,
  roots: BuilderSupervisorRootPolicy = PRODUCTION_BUILDER_ROOT_POLICY,
  runtime: SupervisorConfigRuntime = DEFAULT_RUNTIME,
): Promise<BuilderSupervisorResolvedConfig> {
  try {
    if (runtime.platform !== 'linux' || runtime.uid === undefined) invalid()
    validateRootPolicy(roots)
    const configPath = referencePath(configReference)
    if (!beneath(roots.configRoot, configPath)) invalid()
    const raw = await readSecureFile(configPath, 'config', runtime)
    const value = strictRecord(JSON.parse(raw), CONFIG_KEYS)
    if (value.version !== 1) invalid()
    const tenantId = identifier(value.tenant_id)
    const instanceId = identifier(value.instance_id)
    const configDirectory = posix.join(roots.configRoot, tenantId, instanceId)
    const secretDirectory = posix.join(roots.secretRoot, tenantId, instanceId)
    if (configPath !== posix.join(configDirectory, 'supervisor.json')) invalid()

    const socketPath = exactPath(value.socket_path, posix.join(roots.socketRoot, tenantId, instanceId, 'builder.sock'))
    const artifactRoot = exactPath(value.artifact_root, posix.join(roots.artifactRoot, tenantId, instanceId))
    const exportRoot = exactPath(value.export_root, posix.join(roots.exportRoot, tenantId, instanceId))
    const journalRoot = exactPath(value.journal_root, posix.join(roots.stateRoot, tenantId, instanceId, 'journal'))
    const dockerSocketPath = exactPath(value.docker_socket_path, roots.dockerSocketPath)
    const bearerTokenRef = exactReference(value.bearer_token_ref, posix.join(secretDirectory, 'token'))
    const imageDigestRef = exactReference(value.image_digest_ref, posix.join(configDirectory, 'builder-image.sha256'))
    const templateStoreSha256Ref = exactReference(value.template_store_sha256_ref, posix.join(configDirectory, 'template-store.sha256'))
    const policySha256Ref = exactReference(value.policy_sha256_ref, posix.join(configDirectory, 'policy.sha256'))
    const templateStoreVersion = scalar(value.template_store_version)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u.test(templateStoreVersion)) invalid()

    const [bearerToken, imageDigest, templateStoreSha256, policySha256] = await Promise.all([
      readSecureFile(referencePath(bearerTokenRef), 'secret', runtime),
      readSecureFile(referencePath(imageDigestRef), 'config', runtime),
      readSecureFile(referencePath(templateStoreSha256Ref), 'config', runtime),
      readSecureFile(referencePath(policySha256Ref), 'config', runtime),
    ])
    if (!/^[A-Za-z0-9_-]{43,200}$/u.test(bearerToken)) invalid()
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) invalid()
    if (!/^[a-f0-9]{64}$/u.test(templateStoreSha256) || !/^[a-f0-9]{64}$/u.test(policySha256)) invalid()
    return {
      tenantId,
      instanceId,
      socketPath,
      artifactRoot,
      exportRoot,
      journalRoot,
      dockerSocketPath,
      bearerToken,
      imageDigest: imageDigest as `sha256:${string}`,
      templateStoreVersion,
      templateStoreSha256,
      policySha256,
    }
  } catch (error) {
    if (error instanceof BuilderSupervisorConfigError) throw error
    throw new BuilderSupervisorConfigError()
  }
}

async function readSecureFile(path: string, kind: 'config' | 'secret', runtime: SupervisorConfigRuntime): Promise<string> {
  let handle: FileHandle | undefined
  try {
    handle = await runtime.open(path, constants.O_RDONLY | runtime.noFollowFlag)
    const opened = await handle.stat()
    const linked = await runtime.lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.size < 1 || opened.size > 16_384) invalid()
    if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino || await runtime.realpath(path) !== path) invalid()
    const mode = opened.mode & 0o7777
    if ((opened.uid !== 0 && opened.uid !== runtime.uid) || (opened.mode & 0o022) !== 0 || (kind === 'secret' && mode !== 0o400 && mode !== 0o600)) invalid()
    const value = await handle.readFile('utf8')
    const normalized = value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value
    if (normalized.length === 0 || normalized.trim() !== normalized || /[\r\n\0]/u.test(normalized)) invalid()
    return normalized
  } finally {
    await handle?.close()
  }
}

function validateRootPolicy(roots: BuilderSupervisorRootPolicy): void {
  const paths = [roots.configRoot, roots.secretRoot, roots.socketRoot, roots.artifactRoot, roots.exportRoot, roots.stateRoot, roots.dockerSocketPath]
  for (const path of paths) canonicalAbsolute(path)
  if (new Set(paths).size !== paths.length) invalid()
  const directories = paths.slice(0, -1)
  for (let index = 0; index < directories.length; index += 1) {
    for (let other = index + 1; other < directories.length; other += 1) {
      if (beneath(directories[index]!, directories[other]!) || beneath(directories[other]!, directories[index]!)) invalid()
    }
  }
  if (directories.some(root => beneath(root, roots.dockerSocketPath))) invalid()
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) invalid()
  return row
}

function identifier(value: unknown): string {
  const item = scalar(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(item)) invalid()
  return item
}

function scalar(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\r\n\0]/u.test(value)) return invalid()
  return value
}

function referencePath(reference: string): string {
  if (typeof reference !== 'string' || !reference.startsWith('file:')) return invalid()
  return canonicalAbsolute(reference.slice(5))
}

function exactReference(value: unknown, expectedPath: string): string {
  const reference = scalar(value)
  if (referencePath(reference) !== expectedPath) invalid()
  return reference
}

function exactPath(value: unknown, expected: string): string {
  const path = canonicalAbsolute(scalar(value))
  if (path !== expected) invalid()
  return path
}

function canonicalAbsolute(value: string): string {
  if (!posix.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.includes('://') || posix.normalize(value) !== value || value !== '/' && value.endsWith('/')) return invalid()
  return value
}

function beneath(root: string, value: string): boolean { return value.startsWith(`${root}/`) }
function invalid(): never { throw new BuilderSupervisorConfigError() }
