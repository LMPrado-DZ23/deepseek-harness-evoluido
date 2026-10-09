import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, posix } from 'node:path'
import {
  ArtifactIngressUnixClientError,
  PRODUCTION_BUILDER_ROOT_POLICY,
  classifyArtifactIngressUnixClientFailure,
  classifyBuilderUnixClientFailure,
  createArtifactIngressUnixClient,
  createVerifiedBuildArchive,
  createBuilderUnixClient,
  deriveBuilderRuntimeScopeId,
  loadBuilderRuntimeRegistry,
  loadPinnedBuilderSupervisorConfig,
  type BuilderRuntimeRegistry,
  type BuilderSupervisorResolvedConfig,
  type BuilderSupervisorRootPolicy,
  type BuilderUnixClient,
  type ArtifactIngressUnixClient,
} from '@dz23-studio/builder-supervisor'
import { roleAllows } from '@dz23-studio/policy'
import type { PromptToAppActor } from './service.js'
import {
  BuilderLifecycleError,
  managedBuild,
  type BuilderLifecycleFinished,
  type BuilderLifecycleResolverPort,
  type BuilderLifecycleSession,
} from './builder-lifecycle.js'

export const PROMPT_APP_BUILDER_INSTANCE_ID = 'prompt_app_v1'

export interface BuilderLifecycleResolverOptions {
  readonly registryReference: `file:${string}`
  readonly roots?: BuilderSupervisorRootPolicy
  readonly instanceId?: typeof PROMPT_APP_BUILDER_INSTANCE_ID
  readonly dependencies?: Partial<BuilderLifecycleResolverDependencies>
}

export interface BuilderLifecycleResolverDependencies {
  readonly loadRegistry: typeof loadBuilderRuntimeRegistry
  readonly loadConfig: typeof loadPinnedBuilderSupervisorConfig
  readonly createClient: typeof createBuilderUnixClient
  readonly createArtifactClient: typeof createArtifactIngressUnixClient
  readonly createArchive: typeof createVerifiedBuildArchive
  readonly openArchive: typeof open
  readonly readCredential: (reference: string, signal: AbortSignal) => Promise<string>
}

const DEFAULT_DEPENDENCIES: BuilderLifecycleResolverDependencies = {
  loadRegistry: loadBuilderRuntimeRegistry,
  loadConfig: loadPinnedBuilderSupervisorConfig,
  createClient: createBuilderUnixClient,
  createArtifactClient: createArtifactIngressUnixClient,
  createArchive: createVerifiedBuildArchive,
  openArchive: open,
  readCredential: readSecureLifecycleCredential,
}

export class ManagedBuilderLifecycleResolver implements BuilderLifecycleResolverPort<PromptToAppActor> {
  readonly #roots: BuilderSupervisorRootPolicy
  readonly #instanceId: typeof PROMPT_APP_BUILDER_INSTANCE_ID
  readonly #dependencies: BuilderLifecycleResolverDependencies

  constructor(private readonly options: BuilderLifecycleResolverOptions) {
    this.#roots = options.roots ?? PRODUCTION_BUILDER_ROOT_POLICY
    this.#instanceId = options.instanceId ?? PROMPT_APP_BUILDER_INSTANCE_ID
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  }

  async forActor(actor: PromptToAppActor): Promise<BuilderLifecycleSession> {
    if (!roleAllows(actor.role, 'project.write')) throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'BUILDER_ROLE_REQUIRED')
    try {
      const registry = await this.#dependencies.loadRegistry(this.options.registryReference, this.#roots)
      const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
      const scopeId = deriveBuilderRuntimeScopeId({ installationId: registry.installationId, tenantId, instanceId: this.#instanceId })
      const slots = registry.slots.filter(candidate => candidate.scopeId === scopeId && candidate.state === 'active')
      if (slots.length !== 1) unavailable('BUILDER_SCOPE_UNAVAILABLE')
      const slot = slots[0]!
      const config = await this.#dependencies.loadConfig(slot.configReference, slot.configSha256, this.#roots)
      assertResolvedScope(config, registry, tenantId, this.#instanceId, scopeId)
      const credentialReference = `file:${posix.join(this.#roots.secretRoot, 'instances', scopeId, 'token')}`
      const client = this.#dependencies.createClient({
        socketPath: config.socketPath,
        credentialRef: credentialReference,
        credentials: { resolve: (reference, signal) => this.#dependencies.readCredential(reference, signal) },
      })
      const artifactClient = this.#dependencies.createArtifactClient({
        socketPath: config.socketPath,
        credentialRef: credentialReference,
        credentials: { resolve: (reference, signal) => this.#dependencies.readCredential(reference, signal) },
      })
      const lifecycleScope: BuilderLifecycleResolvedScope = {
        scopeId: config.scopeId,
        imageDigest: config.imageDigest,
        policySha256: config.policySha256,
        exportRoot: config.exportRoot,
      }
      return lifecycleSession(client, artifactClient, lifecycleScope, this.#dependencies.createArchive, this.#dependencies.openArchive)
    } catch (error) {
      if (error instanceof BuilderLifecycleError) throw error
      throw new BuilderLifecycleError('BLOCKED_EXTERNAL', 'BUILDER_SCOPE_UNAVAILABLE', { cause: error })
    }
  }
}

type BuilderLifecycleResolvedScope = Pick<BuilderSupervisorResolvedConfig, 'scopeId' | 'imageDigest' | 'policySha256'> & { readonly exportRoot?: string }

function lifecycleSession(client: BuilderUnixClient, artifactClient: ArtifactIngressUnixClient, config: BuilderLifecycleResolvedScope, createArchive: typeof createVerifiedBuildArchive, openArchive: typeof open): BuilderLifecycleSession {
  const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action() }
    catch (error) {
      if (error instanceof BuilderLifecycleError) throw error
      const classification = error instanceof ArtifactIngressUnixClientError
        ? classifyArtifactIngressUnixClientFailure(error)
        : classifyBuilderUnixClientFailure(error)
      const state = classification.state === 'INTERNAL' ? 'INTERRUPTED' : classification.state
      throw new BuilderLifecycleError(state, classification.code, { cause: error })
    }
  }
  const requestId = () => `req_${randomBytes(16).toString('hex')}`
  const callSignal = (signal?: AbortSignal) => signal ?? AbortSignal.timeout(240_000)
  return {
    preflight: async signal => {
      try {
        const result = await client.preflight({ request_id: requestId() }, { signal: callSignal(signal) })
        if (result.state !== 'OK' || result.scope_id !== config.scopeId || result.image_id !== config.imageDigest || result.policy_sha256 !== config.policySha256) {
          return { state: 'BLOCKED_EXTERNAL' }
        }
        return { state: 'OK' }
      } catch { return { state: 'BLOCKED_EXTERNAL' } }
    },
    prepare: (sourceDirectory, buildId, signal) => invoke(async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(buildId)) throw new BuilderLifecycleError('INTERRUPTED', 'INVALID_BUILD_ID')
      const call = callSignal(signal)
      const archive = await createArchive(dirname(sourceDirectory), basename(sourceDirectory), undefined, call)
      let uploadRef: string | undefined
      let transferred = false
      let archiveDisposed = false
      let handle: FileHandle | undefined
      try {
        const begun = await artifactClient.begin({ requestId: requestId(), buildId, contentLength: archive.archiveBytes, wireSha256: archive.wireSha256 }, call)
        uploadRef = begun.uploadRef
        handle = await openArchive(archive.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const before = await handle.stat()
        if (!before.isFile() || before.nlink !== 1 || before.size !== archive.archiveBytes) throw new ArtifactIngressUnixClientError('INVALID_REQUEST')
        const uploaded = await artifactClient.upload({ uploadRef, contentLength: archive.archiveBytes, source: archiveChunks(handle, archive.archiveBytes, call) }, call)
        if (uploaded.uploadRef !== uploadRef || uploaded.state !== 'READY') throw new ArtifactIngressUnixClientError('INVALID_RESPONSE')
        const after = await handle.stat()
        if (!sameArchiveStat(before, after)) throw new ArtifactIngressUnixClientError('INVALID_REQUEST')
        await handle.close(); handle = undefined
        try { await archive.dispose(); archiveDisposed = true }
        catch { throw new ArtifactIngressUnixClientError('CLEANUP_INCOMPLETE') }
        const prepared = await client.prepare({ request_id: requestId(), build_id: buildId, upload_ref: uploadRef }, { signal: call })
        transferred = true
        return { buildRef: prepared.build_ref }
      } finally {
        let cleanupFailed = false
        if (handle !== undefined) try { await handle.close() } catch { cleanupFailed = true }
        if (uploadRef !== undefined && !transferred) try { await artifactClient.abort({ requestId: requestId(), uploadRef }, AbortSignal.timeout(30_000)) } catch { cleanupFailed = true }
        if (!archiveDisposed) try { await archive.dispose() } catch { cleanupFailed = true }
        if (cleanupFailed) throw new ArtifactIngressUnixClientError('CLEANUP_INCOMPLETE')
      }
    }),
    execute: (buildRef, step, signal) => invoke(async () => {
      const value = await client.execute({ request_id: requestId(), build_ref: buildRef, step }, { signal: callSignal(signal) })
      return { state: value.state, step: value.step, result: value.result }
    }),
    cancel: (buildRef, signal) => invoke(async () => { await client.cancel({ request_id: requestId(), build_ref: buildRef }, { signal: callSignal(signal) }) }),
    finish: (buildRef, signal) => invoke(async () => {
      const value = await client.finish({ request_id: requestId(), build_ref: buildRef }, { signal: callSignal(signal) })
      return {
        ...caminhoDaExportacao(config.exportRoot, value.exported),
        finalState: value.final_state,
        exported: value.exported,
        cleanupPending: value.cleanup_pending,
        cleaned: value.cleaned,
        // A imagem e a política vêm do escopo RESOLVIDO, e o `preflight` já
        // recusou a sessão em que o supervisor respondeu outra imagem ou outra
        // política. São, portanto, os valores sob os quais este artefato foi
        // realmente construído - e não uma cópia da configuração pedida.
        attestation: {
          image_digest: config.imageDigest,
          policy_sha256: config.policySha256,
          scope_id: config.scopeId,
        },
      } satisfies BuilderLifecycleFinished
    }),
    listManaged: signal => invoke(async () => (await client.listManaged({ request_id: requestId() }, { signal: callSignal(signal) })).builds.map(managedBuild)),
  }
}

async function* archiveChunks(handle: FileHandle, expected: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let offset = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  while (offset < expected) {
    signal.throwIfAborted()
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, expected - offset), offset)
    if (bytesRead === 0) throw new ArtifactIngressUnixClientError('INVALID_REQUEST')
    offset += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

function sameArchiveStat(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.nlink === 1 && right.nlink === 1 && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function assertResolvedScope(
  config: BuilderSupervisorResolvedConfig,
  registry: BuilderRuntimeRegistry,
  tenantId: string,
  instanceId: string,
  scopeId: string,
): void {
  if (config.installationId !== registry.installationId || config.tenantId !== tenantId || config.instanceId !== instanceId || config.scopeId !== scopeId) unavailable('BUILDER_SCOPE_MISMATCH')
}

export function opaqueTenantIdentity(orgId: string, tenantId: string): string {
  if (![orgId, tenantId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/u.test(value))) unavailable('INVALID_ACTOR_SCOPE')
  const canonical = JSON.stringify({ domain: 'com.dz23.studio.prompt-app.scope', version: 1, org_id: orgId, tenant_id: tenantId })
  return `t_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 48)}`
}

export interface LifecycleCredentialRuntime {
  readonly platform: NodeJS.Platform
  readonly uid: number | undefined
  readonly noFollowFlag: number
  readonly open: (path: string, flags: number) => Promise<FileHandle>
  readonly lstat: (path: string) => Promise<Stats>
  readonly realpath: (path: string) => Promise<string>
}

const DEFAULT_CREDENTIAL_RUNTIME: LifecycleCredentialRuntime = {
  platform: process.platform,
  uid: process.getuid?.(),
  noFollowFlag: constants.O_NOFOLLOW,
  open,
  lstat,
  realpath,
}

export async function readSecureLifecycleCredential(reference: string, signal: AbortSignal, runtime: LifecycleCredentialRuntime = DEFAULT_CREDENTIAL_RUNTIME): Promise<string> {
  let handle: FileHandle | undefined
  let credential = ''
  let failure: BuilderLifecycleError | undefined
  try {
    signal.throwIfAborted()
    if (runtime.platform !== 'linux' || runtime.uid === undefined || typeof reference !== 'string' || !reference.startsWith('file:')) unavailable('CREDENTIAL_UNAVAILABLE')
    const path = reference.slice(5)
    if (!posix.isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.includes('://') || posix.normalize(path) !== path) unavailable('CREDENTIAL_UNAVAILABLE')
    handle = await runtime.open(path, constants.O_RDONLY | runtime.noFollowFlag)
    const openedBefore = await handle.stat()
    const linkedBefore = await runtime.lstat(path)
    if (!secureCredentialStat(openedBefore, runtime.uid) || !sameCredentialStat(openedBefore, linkedBefore) || await runtime.realpath(path) !== path) unavailable('CREDENTIAL_UNAVAILABLE')
    const bytes = await handle.readFile()
    signal.throwIfAborted()
    const openedAfter = await handle.stat()
    const linkedAfter = await runtime.lstat(path)
    if (!sameCredentialStat(openedBefore, openedAfter) || !sameCredentialStat(openedAfter, linkedAfter) || await runtime.realpath(path) !== path || bytes.byteLength < 43 || bytes.byteLength > 202 || bytes.includes(0)) unavailable('CREDENTIAL_UNAVAILABLE')
    let decoded: string
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { return unavailable('CREDENTIAL_UNAVAILABLE') }
    const token = decoded.endsWith('\r\n') ? decoded.slice(0, -2) : decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded
    if (!/^[A-Za-z0-9_-]{43,200}$/u.test(token)) unavailable('CREDENTIAL_UNAVAILABLE')
    credential = token
  } catch (error) {
    failure = error instanceof BuilderLifecycleError
      ? error
      : new BuilderLifecycleError('BLOCKED_EXTERNAL', 'CREDENTIAL_UNAVAILABLE', { cause: error })
  }
  if (handle !== undefined) {
    try { await handle.close() }
    catch (error) {
      if (failure === undefined) failure = new BuilderLifecycleError('BLOCKED_EXTERNAL', 'CREDENTIAL_UNAVAILABLE', { cause: error })
    }
  }
  if (failure !== undefined) throw failure
  return credential
}

function secureCredentialStat(stat: Stats, uid: number): boolean {
  const mode = stat.mode & 0o7777
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.uid === 0 || stat.uid === uid) && (mode === 0o400 || mode === 0o600)
}
function sameCredentialStat(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino && left.nlink === 1 && right.nlink === 1 && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function unavailable(code: string): never { throw new BuilderLifecycleError('BLOCKED_EXTERNAL', code) }

/**
 * O caminho da exportação publicada, quando há uma e ela tem a forma que o
 * construtor publica (`exports/build_<32 hex>`). Qualquer outra forma é
 * ignorada — e a execução segue sem a importação, que a faz reprovar pela
 * conferência, e não por um caminho inventado.
 * @param raiz - a raiz de exportação do escopo.
 * @param exportado - o que o construtor devolveu.
 * @returns `{ exportedPath }`, ou nada.
 */
export function caminhoDaExportacao(raiz: string | undefined, exportado: { readonly relative_path: string } | null): { readonly exportedPath?: string } {
  if (raiz === undefined || exportado === null || !/^exports\/build_[a-f0-9]{32}$/u.test(exportado.relative_path)) return {}
  return { exportedPath: posix.join(raiz, exportado.relative_path) }
}
