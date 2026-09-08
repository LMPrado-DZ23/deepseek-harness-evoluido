import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  TEMPLATE_MANIFEST_MAX_BYTES,
  canonicalSignedTemplateStoreManifestBytes,
  parseTemplateStoreManifest,
  type TemplateStoreManifest,
} from './store-security.js'
import {
  builderRuntimeSocketPath,
  deriveBuilderRuntimeScopeId,
  isInstallationId,
  isRuntimeIdentifier,
  type BuilderRuntimeScopeId,
} from './runtime-scope.js'

const CONFIG_KEYS_V1 = [
  'artifact_root',
  'bearer_token_ref',
  'docker_socket_path',
  'export_root',
  'image_digest_ref',
  'installation_id',
  'instance_id',
  'journal_root',
  'policy_sha256_ref',
  'replay_root',
  'socket_path',
  'template_store_sha256_ref',
  'template_store_version',
  'tenant_id',
  'version',
] as const

const CONFIG_KEYS_V2 = [...CONFIG_KEYS_V1, 'template_store_manifest_ref'] as const

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
  readonly installationId: string
  readonly tenantId: string
  readonly instanceId: string
  readonly scopeId: BuilderRuntimeScopeId
  readonly socketPath: string
  readonly artifactRoot: string
  readonly exportRoot: string
  readonly journalRoot: string
  readonly replayRoot: string
  readonly dockerSocketPath: string
  readonly bearerToken: string
  readonly imageDigest: `sha256:${string}`
  readonly templateStoreVersion: string
  readonly templateStoreSha256: string
  readonly templateStoreManifest?: TemplateStoreManifest
  readonly templateStoreManifestReference?: `file:${string}`
  readonly policySha256: string
}

export interface BuilderSupervisorConfigEnvelope {
  readonly config: BuilderSupervisorResolvedConfig
  readonly envelopeSha256: string
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
  noFollowFlag: constants.O_NOFOLLOW,
  open,
  lstat,
  realpath,
}

export async function loadBuilderSupervisorConfig(
  configReference: string,
  roots: BuilderSupervisorRootPolicy = PRODUCTION_BUILDER_ROOT_POLICY,
  runtime: SupervisorConfigRuntime = DEFAULT_RUNTIME,
): Promise<BuilderSupervisorResolvedConfig> {
  return (await loadResolvedConfig(configReference, roots, runtime)).config
}

export async function loadBuilderSupervisorConfigEnvelope(
  configReference: string,
  roots: BuilderSupervisorRootPolicy = PRODUCTION_BUILDER_ROOT_POLICY,
  runtime: SupervisorConfigRuntime = DEFAULT_RUNTIME,
): Promise<BuilderSupervisorConfigEnvelope> {
  return loadResolvedConfig(configReference, roots, runtime)
}

/**
 * Loads the supervisor configuration and its immutable referenced pins from the
 * exact file descriptors whose raw bytes form `expectedEnvelopeSha256`.
 * The bearer token is deliberately excluded so credentials can be rotated.
 */
export async function loadPinnedBuilderSupervisorConfig(
  configReference: string,
  expectedEnvelopeSha256: string,
  roots: BuilderSupervisorRootPolicy = PRODUCTION_BUILDER_ROOT_POLICY,
  runtime: SupervisorConfigRuntime = DEFAULT_RUNTIME,
): Promise<BuilderSupervisorResolvedConfig> {
  if (!/^[a-f0-9]{64}$/u.test(expectedEnvelopeSha256)) throw new BuilderSupervisorConfigError()
  return (await loadResolvedConfig(configReference, roots, runtime, expectedEnvelopeSha256)).config
}

async function loadResolvedConfig(
  configReference: string,
  roots: BuilderSupervisorRootPolicy,
  runtime: SupervisorConfigRuntime,
  expectedEnvelopeSha256?: string,
): Promise<BuilderSupervisorConfigEnvelope> {
  try {
    if (runtime.platform !== 'linux' || runtime.uid === undefined) invalid()
    validateBuilderSupervisorRootPolicy(roots)
    const configPath = referencePath(configReference)
    if (!beneath(roots.configRoot, configPath)) invalid()
    const configBytes = await readSecureFileBytes(configPath, 'config', runtime)
    const raw = secureText(configBytes)
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalid()
    const rawVersion = (parsed as Record<string, unknown>).version
    if (rawVersion !== 1 && rawVersion !== 2) invalid()
    const version = rawVersion
    const value = strictRecord(parsed, version === 1 ? CONFIG_KEYS_V1 : CONFIG_KEYS_V2)
    const installationId = installationIdentifier(value.installation_id)
    const tenantId = identifier(value.tenant_id)
    const instanceId = identifier(value.instance_id)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId })
    const configDirectory = posix.join(roots.configRoot, 'instances', scopeId)
    const secretDirectory = posix.join(roots.secretRoot, 'instances', scopeId)
    if (configPath !== posix.join(configDirectory, 'supervisor.json')) invalid()

    const socketPath = exactPath(value.socket_path, builderRuntimeSocketPath(roots.socketRoot, scopeId))
    const artifactRoot = exactPath(value.artifact_root, posix.join(roots.artifactRoot, 'instances', scopeId))
    const exportRoot = exactPath(value.export_root, posix.join(roots.exportRoot, 'instances', scopeId))
    const stateDirectory = posix.join(roots.stateRoot, 'instances', scopeId)
    const journalRoot = exactPath(value.journal_root, posix.join(stateDirectory, 'journal'))
    const replayRoot = exactPath(value.replay_root, posix.join(stateDirectory, 'rpc-replay'))
    const dockerSocketPath = exactPath(value.docker_socket_path, roots.dockerSocketPath)
    const bearerTokenRef = exactReference(value.bearer_token_ref, posix.join(secretDirectory, 'token'))
    const imageDigestRef = exactReference(value.image_digest_ref, posix.join(configDirectory, 'builder-image.sha256'))
    const templateStoreSha256Ref = exactReference(value.template_store_sha256_ref, posix.join(configDirectory, 'template-store.sha256'))
    const templateStoreManifestRef = version === 2
      ? exactReference(value.template_store_manifest_ref, posix.join(configDirectory, 'template-store.manifest.json'))
      : undefined
    const policySha256Ref = exactReference(value.policy_sha256_ref, posix.join(configDirectory, 'policy.sha256'))
    const templateStoreVersion = scalar(value.template_store_version)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u.test(templateStoreVersion)) invalid()

    const [bearerTokenBytes, imageDigestBytes, templateStoreSha256Bytes, templateStoreManifestBytes, policySha256Bytes] = await Promise.all([
      readSecureFileBytes(referencePath(bearerTokenRef), 'secret', runtime),
      readSecureFileBytes(referencePath(imageDigestRef), 'config', runtime),
      readSecureFileBytes(referencePath(templateStoreSha256Ref), 'config', runtime),
      templateStoreManifestRef === undefined ? Promise.resolve(undefined) : readSecureFileBytes(referencePath(templateStoreManifestRef), 'manifest', runtime, TEMPLATE_MANIFEST_MAX_BYTES),
      readSecureFileBytes(referencePath(policySha256Ref), 'config', runtime),
    ])
    const envelopeSha256 = version === 1
      ? computeBuilderSupervisorConfigEnvelopeSha256({ configBytes, imageDigestBytes, templateStoreSha256Bytes, policySha256Bytes })
      : computeBuilderSupervisorConfigEnvelopeV2Sha256({ configBytes, imageDigestBytes, templateStoreSha256Bytes, templateStoreManifestBytes: templateStoreManifestBytes!, policySha256Bytes })
    if (expectedEnvelopeSha256 !== undefined && envelopeSha256 !== expectedEnvelopeSha256) invalid()
    const bearerToken = secureText(bearerTokenBytes)
    const imageDigest = secureText(imageDigestBytes)
    const templateStoreSha256 = secureText(templateStoreSha256Bytes)
    const policySha256 = secureText(policySha256Bytes)
    if (!/^[A-Za-z0-9_-]{43,200}$/u.test(bearerToken)) invalid()
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) invalid()
    if (!/^[a-f0-9]{64}$/u.test(templateStoreSha256) || !/^[a-f0-9]{64}$/u.test(policySha256)) invalid()
    let templateStoreManifest: TemplateStoreManifest | undefined
    if (templateStoreManifestBytes !== undefined) {
      templateStoreManifest = parseTemplateStoreManifest(JSON.parse(secureJsonText(templateStoreManifestBytes)) as unknown)
      if (!canonicalSignedTemplateStoreManifestBytes(templateStoreManifest).equals(templateStoreManifestBytes) || templateStoreManifest.template_store_version !== templateStoreVersion || templateStoreManifest.tree_sha256 !== templateStoreSha256) invalid()
    }
    const config: BuilderSupervisorResolvedConfig = {
      installationId,
      tenantId,
      instanceId,
      scopeId,
      socketPath,
      artifactRoot,
      exportRoot,
      journalRoot,
      replayRoot,
      dockerSocketPath,
      bearerToken,
      imageDigest: imageDigest as `sha256:${string}`,
      templateStoreVersion,
      templateStoreSha256,
      ...(templateStoreManifest === undefined ? {} : { templateStoreManifest, templateStoreManifestReference: templateStoreManifestRef as `file:${string}` }),
      policySha256,
    }
    return { config, envelopeSha256 }
  } catch (error) {
    if (error instanceof BuilderSupervisorConfigError) throw error
    throw new BuilderSupervisorConfigError()
  }
}

export function computeBuilderSupervisorConfigEnvelopeSha256(input: {
  readonly configBytes: Uint8Array
  readonly imageDigestBytes: Uint8Array
  readonly templateStoreSha256Bytes: Uint8Array
  readonly policySha256Bytes: Uint8Array
}): string {
  const hash = createHash('sha256').update('dz23-builder-config-envelope-v1\0')
  for (const [label, bytes] of [
    ['supervisor.json', input.configBytes],
    ['builder-image.sha256', input.imageDigestBytes],
    ['template-store.sha256', input.templateStoreSha256Bytes],
    ['policy.sha256', input.policySha256Bytes],
  ] as const) hash.update(label).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes)
  return hash.digest('hex')
}

export function computeBuilderSupervisorConfigEnvelopeV2Sha256(input: {
  readonly configBytes: Uint8Array
  readonly imageDigestBytes: Uint8Array
  readonly templateStoreSha256Bytes: Uint8Array
  readonly templateStoreManifestBytes: Uint8Array
  readonly policySha256Bytes: Uint8Array
}): string {
  return computeEnvelope('dz23-builder-config-envelope-v2\0', [
    ['supervisor.json', input.configBytes],
    ['builder-image.sha256', input.imageDigestBytes],
    ['template-store.sha256', input.templateStoreSha256Bytes],
    ['template-store.manifest.json', input.templateStoreManifestBytes],
    ['policy.sha256', input.policySha256Bytes],
  ])
}

function computeEnvelope(domain: string, entries: ReadonlyArray<readonly [string, Uint8Array]>): string {
  const hash = createHash('sha256').update(domain)
  for (const [label, bytes] of entries) hash.update(label).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes)
  return hash.digest('hex')
}

async function readSecureFileBytes(path: string, kind: 'config' | 'secret' | 'manifest', runtime: SupervisorConfigRuntime, maximumBytes = 16_384): Promise<Buffer> {
  let handle: FileHandle | undefined
  try {
    handle = await runtime.open(path, constants.O_RDONLY | runtime.noFollowFlag)
    const opened = await handle.stat()
    const linked = await runtime.lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.size < 1 || opened.size > maximumBytes) invalid()
    if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino || await runtime.realpath(path) !== path) invalid()
    const mode = opened.mode & 0o7777
    if ((opened.uid !== 0 && opened.uid !== runtime.uid) || (opened.mode & 0o022) !== 0 || (kind === 'secret' && mode !== 0o400 && mode !== 0o600) || (kind === 'manifest' && mode !== 0o600)) invalid()
    const value = await handle.readFile()
    if (value.byteLength === 0 || value.includes(0)) invalid()
    return value
  } finally {
    await handle?.close()
  }
}

function secureText(value: Uint8Array): string {
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(value) }
  catch { return invalid() }
  const normalized = decoded.endsWith('\r\n') ? decoded.slice(0, -2) : decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded
  if (normalized.length === 0 || normalized.trim() !== normalized || /[\r\n\0]/u.test(normalized)) invalid()
  return normalized
}

function secureJsonText(value: Uint8Array): string {
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(value) }
  catch { return invalid() }
  if (!decoded.endsWith('\n') || decoded.endsWith('\n\n') || decoded.includes('\r') || decoded.includes('\0')) invalid()
  return decoded.slice(0, -1)
}

export function validateBuilderSupervisorRootPolicy(roots: BuilderSupervisorRootPolicy): void {
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
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) invalid()
  return row
}

function identifier(value: unknown): string {
  const item = scalar(value)
  if (!isRuntimeIdentifier(item)) invalid()
  return item
}

function installationIdentifier(value: unknown): string {
  const item = scalar(value)
  if (!isInstallationId(item)) invalid()
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
