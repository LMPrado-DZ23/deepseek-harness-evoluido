import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builderRuntimeRegistryPath } from '../src/manager-registry.js'
import { deriveBuilderRuntimeScopeId } from '../src/runtime-scope.js'
import { RUNTIME_ACTIVATION_TEST_ONLY, provisionAndActivateBuilderRuntime } from '../src/runtime-activation.js'
import { PRODUCTION_BUILDER_ROOT_POLICY, type BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'
import { computeTemplateTreeSha256, type TemplateManifestEntry } from '../src/store-security.js'
import type { BuilderProvisionRequest } from '../src/store-provision.js'

const linux = process.platform === 'linux' ? describe : describe.skip
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(async path => { await makeWritable(path); await rm(path, { recursive: true, force: true }) })) })

linux('provision and activate transaction boundary', () => {
  it('resolves explicit and production root policies without ambiguity', () => {
    const explicit = policy('/tmp/explicit-runtime-roots')
    expect(RUNTIME_ACTIVATION_TEST_ONLY.activationRoots(explicit)).toBe(explicit)
    expect(RUNTIME_ACTIVATION_TEST_ONLY.activationRoots(undefined)).toBe(PRODUCTION_BUILDER_ROOT_POLICY)
  })

  it('resumes a crash between config and registry without rotating token, scope or config digest', async () => {
    const fixture = await createFixture()
    await expect(provisionAndActivateBuilderRuntime(fixture.request, { afterConfigurationPublished: async () => { throw new Error('SIMULATED_CRASH') } })).rejects.toThrow('SIMULATED_CRASH')
    const configDir = posix.join(fixture.roots.configRoot, 'instances', fixture.scopeId)
    const secretDir = posix.join(fixture.roots.secretRoot, 'instances', fixture.scopeId)
    const tokenBefore = await readFile(posix.join(secretDir, 'token'))
    const configBefore = await readFile(posix.join(configDir, 'supervisor.json'))
    expect(await exists(builderRuntimeRegistryPath(fixture.roots))).toBe(false)

    const resumed = await provisionAndActivateBuilderRuntime(fixture.request)
    expect(resumed).toMatchObject({ provision: { scope_id: fixture.scopeId }, activation: { state: 'ACTIVATED', generation: 1, scopeId: fixture.scopeId } })
    expect(await readFile(posix.join(secretDir, 'token'))).toEqual(tokenBefore)
    expect(await readFile(posix.join(configDir, 'supervisor.json'))).toEqual(configBefore)
    expect(resumed.provision.config_sha256).toBe(fixtureDigest(resumed.provision.config_sha256))
    const repeated = await provisionAndActivateBuilderRuntime(fixture.request)
    expect(repeated.provision.config_sha256).toBe(resumed.provision.config_sha256)
    expect(repeated.activation).toMatchObject({ state: 'UNCHANGED', generation: 1 })
  })
})

interface Fixture { readonly root: string; readonly roots: BuilderSupervisorRootPolicy; readonly request: BuilderProvisionRequest; readonly scopeId: ReturnType<typeof deriveBuilderRuntimeScopeId> }
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(posix.join(tmpdir(), 'dra-')); cleanup.push(root)
  const managed = posix.join(root, 'm')
  const roots: BuilderSupervisorRootPolicy = { configRoot: posix.join(managed, 'c'), secretRoot: posix.join(managed, 's'), socketRoot: posix.join(managed, 'r'), artifactRoot: posix.join(managed, 'a'), exportRoot: posix.join(managed, 'e'), stateRoot: posix.join(managed, 't'), dockerSocketPath: posix.join(managed, 'docker.sock') }
  for (const path of [roots.configRoot, roots.secretRoot, roots.socketRoot, roots.artifactRoot, roots.exportRoot, roots.stateRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
  const source = posix.join(root, 'source'); await mkdir(posix.join(source, 'app'), { recursive: true, mode: 0o700 }); await writeFile(posix.join(source, 'app', 'package.json'), '{}\n', { mode: 0o600 })
  const content = '{}\n'; const entries: TemplateManifestEntry[] = [{ path: 'app', type: 'directory' }, { path: 'app/package.json', type: 'file', bytes: Buffer.byteLength(content), sha256: sha(content) }]
  const tree = computeTemplateTreeSha256('v1', entries)
  const raw = `${JSON.stringify({ version: 1, template_store_version: 'v1', tree_sha256: tree, entries })}\n`
  const manifest = posix.join(root, 'manifest.json'); await writeFile(manifest, raw, { mode: 0o600 })
  const installationId = 'd'.repeat(64); const tenantId = 'tenant'; const instanceId = 'instance'
  const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId })
  return { root, roots, scopeId, request: { installationId, tenantId, instanceId, sourceRoot: source, manifestReference: `file:${manifest}`, manifestSha256: sha(raw), imageDigest: `sha256:${'a'.repeat(64)}`, policySha256: 'b'.repeat(64), roots } }
}
function policy(root: string): BuilderSupervisorRootPolicy { return { configRoot: posix.join(root, 'c'), secretRoot: posix.join(root, 's'), socketRoot: posix.join(root, 'r'), artifactRoot: posix.join(root, 'a'), exportRoot: posix.join(root, 'e'), stateRoot: posix.join(root, 't'), dockerSocketPath: posix.join(root, 'docker.sock') } }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function fixtureDigest(value: string): string { expect(value).toMatch(/^[a-f0-9]{64}$/u); return value }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function makeWritable(path: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try { stat = await lstat(path) } catch { return }
  if (!stat.isDirectory()) { await chmod(path, 0o600).catch(() => undefined); return }
  await chmod(path, 0o700).catch(() => undefined)
  for (const name of await readdir(path).catch(() => [])) await makeWritable(posix.join(path, name))
}
