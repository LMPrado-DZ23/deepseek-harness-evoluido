import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BuilderSupervisorConfigError,
  loadBuilderSupervisorConfig,
  type BuilderSupervisorRootPolicy,
  type SupervisorConfigRuntime,
} from '../src/supervisor-config.js'

const linux = process.platform === 'linux' ? describe : describe.skip
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

linux('builder supervisor fail-closed configuration', () => {
  it('loads only the exact tenant-scoped paths and file-backed secret/digests', async () => {
    const fixture = await createFixture()
    const config = await loadBuilderSupervisorConfig(`file:${fixture.configPath}`, fixture.policy)
    expect(config).toEqual(fixture.expected)
    expect(JSON.stringify(config)).toContain(fixture.token)
    await chmod(fixture.tokenPath, 0o400)
    await expect(loadBuilderSupervisorConfig(`file:${fixture.configPath}`, fixture.policy)).resolves.toEqual(fixture.expected)
  })

  it('rejects extra fields, inline secrets, noncanonical paths and untrusted config locations', async () => {
    const fixture = await createFixture()
    await rewriteConfig(fixture, { bearer_token: fixture.token })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, {}, ['bearer_token_ref'])
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, { socket_path: `${fixture.expected.socketPath}/../builder.sock` })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await expectInvalid(`file:${fixture.root}/outside.json`, fixture.policy)
    await expectInvalid(fixture.configPath, fixture.policy)
  })

  it('rejects weak or linked credential files and never includes their contents in errors', async () => {
    const fixture = await createFixture()
    for (const mode of [0o000, 0o100, 0o500, 0o640, 0o644, 0o700, 0o4600]) {
      await chmod(fixture.tokenPath, mode)
      await expectInvalidWithoutSecret(fixture)
    }
    await chmod(fixture.tokenPath, 0o600)
    const target = `${fixture.tokenPath}.target`
    await writeFile(target, `${fixture.token}\n`, { mode: 0o600 })
    await unlink(fixture.tokenPath)
    await symlink(target, fixture.tokenPath)
    await expectInvalidWithoutSecret(fixture)
  })

  it('rejects malformed scalar files, identities, digests and root policies', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.imagePath, `sha256:${'A'.repeat(64)}\n`, { mode: 0o600 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await writeFile(fixture.imagePath, `sha256:${'a'.repeat(64)}\nextra\n`, { mode: 0o600 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, { tenant_id: '../tenant' })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, { version: 2 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await expectInvalid(`file:${fixture.configPath}`, { ...fixture.policy, dockerSocketPath: 'relative.sock' })
    await expectInvalid(`file:${fixture.configPath}`, { ...fixture.policy, stateRoot: fixture.policy.exportRoot })
    await expectInvalid(`file:${fixture.configPath}`, { ...fixture.policy, stateRoot: posix.join(fixture.policy.exportRoot, 'nested') })
    await expectInvalid(`file:${fixture.configPath}`, { ...fixture.policy, dockerSocketPath: posix.join(fixture.policy.stateRoot, 'docker.sock') })
  })

  it('rejects unsupported runtimes, malformed JSON and non-record configuration', async () => {
    const fixture = await createFixture()
    await expectInvalidWithRuntime(fixture, runtime({ platform: 'win32' }))
    await expectInvalidWithRuntime(fixture, runtime({ uid: undefined }))
    await writeFile(fixture.configPath, '{broken', { mode: 0o600 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await writeFile(fixture.configPath, '[]\n', { mode: 0o600 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
  })

  it('rejects wrong derived paths, references and scalar types before consuming authority', async () => {
    const fixture = await createFixture()
    const alternate = posix.join(posix.dirname(fixture.configPath), 'alternate.json')
    await writeFile(alternate, `${JSON.stringify(fixture.raw)}\n`, { mode: 0o600 })
    await expectInvalid(`file:${alternate}`, fixture.policy)
    await rewriteConfig(fixture, { socket_path: posix.join(fixture.policy.socketRoot, 'other', 'builder.sock') })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, { bearer_token_ref: `file:${fixture.tokenPath}.other` })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, { template_store_version: 1 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await rewriteConfig(fixture, { template_store_version: 'bad/version' })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
  })

  it('rejects weak authority values and unsafe file identities without disclosing values', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.tokenPath, 'short\n', { mode: 0o600 })
    await expectInvalidWithoutSecret(fixture)
    await writeFile(fixture.tokenPath, `${fixture.token}\n`, { mode: 0o600 })
    const storePath = referencePath(fixture.raw.template_store_sha256_ref)
    await writeFile(storePath, `${'z'.repeat(64)}\n`, { mode: 0o600 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await writeFile(storePath, `${'b'.repeat(64)}\n`, { mode: 0o600 })
    const policyPath = referencePath(fixture.raw.policy_sha256_ref)
    await writeFile(policyPath, `${'z'.repeat(64)}\n`, { mode: 0o600 })
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)

    await writeFile(policyPath, `${'c'.repeat(64)}\n`, { mode: 0o600 })
    const hardlink = `${fixture.configPath}.hardlink`
    await link(fixture.configPath, hardlink)
    await expectInvalid(`file:${fixture.configPath}`, fixture.policy)
    await unlink(hardlink)
    const actual = await lstat(fixture.configPath)
    await expectInvalidWithRuntime(fixture, runtime({
      lstat: (async path => path === fixture.configPath ? statWithInode(actual, actual.ino + 1) : lstat(path)) as typeof lstat,
    }))
    await expectInvalidWithRuntime(fixture, runtime({
      realpath: (async path => path === fixture.configPath ? `${path}.moved` : realpath(path)) as typeof realpath,
    }))
  })

  it('does not fall back to environment variables when a referenced secret is absent', async () => {
    const fixture = await createFixture()
    const previous = process.env.DZ23_BUILDER_SUPERVISOR_TOKEN
    process.env.DZ23_BUILDER_SUPERVISOR_TOKEN = fixture.token
    try {
      await unlink(fixture.tokenPath)
      await expectInvalidWithoutSecret(fixture)
    } finally {
      if (previous === undefined) delete process.env.DZ23_BUILDER_SUPERVISOR_TOKEN
      else process.env.DZ23_BUILDER_SUPERVISOR_TOKEN = previous
    }
  })
})

interface Fixture {
  readonly root: string
  readonly policy: BuilderSupervisorRootPolicy
  readonly configPath: string
  readonly tokenPath: string
  readonly imagePath: string
  readonly token: string
  readonly raw: Record<string, unknown>
  readonly expected: Record<string, unknown>
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(posix.join(tmpdir(), 'dz23-supervisor-config-')); roots.push(root)
  const policy = {
    configRoot: posix.join(root, 'config'),
    secretRoot: posix.join(root, 'secrets'),
    socketRoot: posix.join(root, 'run'),
    artifactRoot: posix.join(root, 'artifacts'),
    exportRoot: posix.join(root, 'exports'),
    stateRoot: posix.join(root, 'state'),
    dockerSocketPath: posix.join(root, 'docker.sock'),
  }
  const tenantId = 'tenant-one'; const instanceId = 'instance-one'
  const configDirectory = posix.join(policy.configRoot, tenantId, instanceId)
  const secretDirectory = posix.join(policy.secretRoot, tenantId, instanceId)
  await mkdir(configDirectory, { recursive: true, mode: 0o700 }); await mkdir(secretDirectory, { recursive: true, mode: 0o700 })
  const configPath = posix.join(configDirectory, 'supervisor.json')
  const tokenPath = posix.join(secretDirectory, 'token')
  const imagePath = posix.join(configDirectory, 'builder-image.sha256')
  const storePath = posix.join(configDirectory, 'template-store.sha256')
  const policyPath = posix.join(configDirectory, 'policy.sha256')
  const token = `token_${'T'.repeat(48)}`
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 })
  await writeFile(imagePath, `sha256:${'a'.repeat(64)}\n`, { mode: 0o600 })
  await writeFile(storePath, `${'b'.repeat(64)}\n`, { mode: 0o600 })
  await writeFile(policyPath, `${'c'.repeat(64)}\n`, { mode: 0o600 })
  const raw: Record<string, unknown> = {
    version: 1,
    tenant_id: tenantId,
    instance_id: instanceId,
    socket_path: posix.join(policy.socketRoot, tenantId, instanceId, 'builder.sock'),
    artifact_root: posix.join(policy.artifactRoot, tenantId, instanceId),
    export_root: posix.join(policy.exportRoot, tenantId, instanceId),
    journal_root: posix.join(policy.stateRoot, tenantId, instanceId, 'journal'),
    docker_socket_path: policy.dockerSocketPath,
    bearer_token_ref: `file:${tokenPath}`,
    image_digest_ref: `file:${imagePath}`,
    template_store_version: 'v2.0.0',
    template_store_sha256_ref: `file:${storePath}`,
    policy_sha256_ref: `file:${policyPath}`,
  }
  await writeFile(configPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 })
  return { root, policy, configPath, tokenPath, imagePath, token, raw, expected: {
    tenantId,
    instanceId,
    socketPath: raw.socket_path,
    artifactRoot: raw.artifact_root,
    exportRoot: raw.export_root,
    journalRoot: raw.journal_root,
    dockerSocketPath: raw.docker_socket_path,
    bearerToken: token,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    templateStoreVersion: 'v2.0.0',
    templateStoreSha256: 'b'.repeat(64),
    policySha256: 'c'.repeat(64),
  } }
}

async function rewriteConfig(fixture: Fixture, additions: Record<string, unknown>, removals: readonly string[] = []): Promise<void> {
  const value = { ...fixture.raw, ...additions }
  for (const key of removals) delete value[key]
  await writeFile(fixture.configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

async function expectInvalid(reference: string, policy: BuilderSupervisorRootPolicy): Promise<void> {
  await expect(loadBuilderSupervisorConfig(reference, policy)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_SUPERVISOR_CONFIGURATION', message: 'INVALID_SUPERVISOR_CONFIGURATION' }))
}

async function expectInvalidWithoutSecret(fixture: Fixture): Promise<void> {
  try { await loadBuilderSupervisorConfig(`file:${fixture.configPath}`, fixture.policy); throw new Error('EXPECTED_REJECTION') }
  catch (error) {
    expect(error).toBeInstanceOf(BuilderSupervisorConfigError)
    expect(String(error)).not.toContain(fixture.token)
    expect(JSON.stringify(error)).not.toContain(fixture.token)
  }
}

function runtime(overrides: Partial<SupervisorConfigRuntime> = {}): SupervisorConfigRuntime {
  return { platform: process.platform, uid: process.getuid?.(), noFollowFlag: constants.O_NOFOLLOW, open, lstat, realpath, ...overrides }
}

async function expectInvalidWithRuntime(fixture: Fixture, selected: SupervisorConfigRuntime): Promise<void> {
  await expect(loadBuilderSupervisorConfig(`file:${fixture.configPath}`, fixture.policy, selected)).rejects.toBeInstanceOf(BuilderSupervisorConfigError)
}

function referencePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('file:')) throw new Error('INVALID_TEST_FIXTURE')
  return value.slice(5)
}

function statWithInode(stat: Awaited<ReturnType<typeof lstat>>, ino: number): Awaited<ReturnType<typeof lstat>> {
  return new Proxy(stat, { get(target, property) { return property === 'ino' ? ino : Reflect.get(target, property, target) } })
}
