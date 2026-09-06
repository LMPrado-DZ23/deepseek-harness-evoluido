import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveBuilderRuntimeScopeId,
  BuilderUnixClientError,
  type BuilderAttestation,
  type BuilderRuntimeRegistry,
  type BuilderSupervisorResolvedConfig,
  type BuilderSupervisorRootPolicy,
  type BuilderUnixClient,
  type BuilderUnixClientOptions,
} from '@dz23-studio/builder-supervisor'
import { BuilderLifecycleError, managedBuild } from '../src/builder-lifecycle.js'
import {
  ManagedBuilderLifecycleResolver,
  opaqueTenantIdentity,
  PROMPT_APP_BUILDER_INSTANCE_ID,
  readSecureLifecycleCredential,
  type BuilderLifecycleResolverOptions,
  type LifecycleCredentialRuntime,
} from '../src/builder-resolver.js'
import type { PromptToAppActor } from '../src/service.js'

describe('builder lifecycle resolver', () => {
  const installationId = 'a'.repeat(64)
  const actor: PromptToAppActor = { userId: 'owner', orgId: 'org-a', tenantId: 'shared', role: 'owner' }

  it('derives organization-aware opaque scopes and rejects hostile identity text', () => {
    expect(opaqueTenantIdentity('org-a', 'same')).not.toBe(opaqueTenantIdentity('org-b', 'same'))
    expect(opaqueTenantIdentity('org-a', 'same')).toMatch(/^t_[a-f0-9]{48}$/u)
    expect(() => opaqueTenantIdentity('org\nspoof', 'same')).toThrow(BuilderLifecycleError)
  })

  it('rejects viewers before registry or transport access', async () => {
    const loadRegistry = vi.fn()
    const resolver = new ManagedBuilderLifecycleResolver({ registryReference: 'file:/config/manager/runtime-registry.json', dependencies: { loadRegistry } })
    await expect(resolver.forActor({ ...actor, role: 'viewer' })).rejects.toMatchObject({ code: 'BUILDER_ROLE_REQUIRED' })
    expect(loadRegistry).not.toHaveBeenCalled()
  })

  it('uses project.write policy so an admin can resolve while a viewer cannot', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const loadRegistry = vi.fn(async () => registryFixture(installationId, scopeId))
    const resolver = new ManagedBuilderLifecycleResolver({
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: { loadRegistry, loadConfig: vi.fn(async () => configFixture(installationId, tenantId, scopeId)), createClient: vi.fn(() => clientFixture(scopeId, [])), readCredential: vi.fn(async () => 'x'.repeat(43)) },
    })
    await expect(resolver.forActor({ ...actor, role: 'admin' })).resolves.toBeDefined()
    await expect(resolver.forActor({ ...actor, role: 'viewer' })).rejects.toMatchObject({ code: 'BUILDER_ROLE_REQUIRED' })
    expect(loadRegistry).toHaveBeenCalledOnce()
  })

  it('pins scope and attestation but keeps preflight blocked until authenticated ingress exists', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const readCredential = vi.fn(async () => 'x'.repeat(43))
    const executeBodies: unknown[] = []
    const fakeClient = clientFixture(scopeId, executeBodies)
    const createClient = vi.fn((options: BuilderUnixClientOptions) => credentialClient(options, readCredential, fakeClient))
    const resolver = new ManagedBuilderLifecycleResolver({
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: {
        loadRegistry: vi.fn(async () => registryFixture(installationId, scopeId)),
        loadConfig: vi.fn(async () => configFixture(installationId, tenantId, scopeId)),
        createClient,
        readCredential,
      },
    })
    const session = await resolver.forActor(actor)
    await expect(session.preflight()).resolves.toEqual({ state: 'BLOCKED_EXTERNAL' })
    expect(readCredential).toHaveBeenCalledOnce()
    expect(executeBodies).toEqual([])
    expect(fakeClient.execute).not.toHaveBeenCalled()
  })

  it('fails preflight closed when the transport throws', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const client = clientFixture(scopeId, [])
    client.preflight = vi.fn(async () => { throw new Error('transport detail') })
    await expect((await resolverFixture(actor, installationId, client).forActor(actor)).preflight()).resolves.toEqual({ state: 'BLOCKED_EXTERNAL' })
  })

  it.each([
    ['linux shared path', '/srv/shared/.staging-attack/source'],
    ['windows junction path', 'C:\\shared\\junction\\source'],
  ])('keeps filesystem ingress unavailable for %s without invoking prepare or touching the supplied path', async (_case, sourcePath) => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const client = clientFixture(scopeId, [])
    const adversarialOptions = {
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: {
        loadRegistry: vi.fn(async () => registryFixture(installationId, scopeId)),
        loadConfig: vi.fn(async () => configFixture(installationId, tenantId, scopeId)),
        createClient: vi.fn(() => client), readCredential: vi.fn(async () => 'x'.repeat(43)),
      },
      ingress: 'shared-filesystem',
    } satisfies BuilderLifecycleResolverOptions & { readonly ingress: 'shared-filesystem' }
    const resolver = new ManagedBuilderLifecycleResolver(adversarialOptions)
    const session = await resolver.forActor(actor)
    await expect(session.prepare(sourcePath, '../logical-build')).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'UNSUPPORTED_INGRESS' })
    await expect(session.execute('build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'build')).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'UNSUPPORTED_INGRESS' })
    expect(client.prepare).not.toHaveBeenCalled()
    expect(client.execute).not.toHaveBeenCalled()
  })

  it('fails preflight closed when the attestation differs from the selected scope', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const fake = clientFixture(`s_${'f'.repeat(48)}`, [])
    const resolver = new ManagedBuilderLifecycleResolver({
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: {
        loadRegistry: vi.fn(async () => registryFixture(installationId, scopeId)),
        loadConfig: vi.fn(async () => configFixture(installationId, tenantId, scopeId)),
        createClient: vi.fn(() => fake), readCredential: vi.fn(async () => 'x'.repeat(43)),
      },
    })
    await expect((await resolver.forActor(actor)).preflight()).resolves.toEqual({ state: 'BLOCKED_EXTERNAL' })
  })

  const attestationMutations: readonly (readonly [string, (value: BuilderAttestation) => BuilderAttestation])[] = [
    ['manager blocked', value => ({ ...value, state: 'BLOCKED_EXTERNAL' })],
    ['wrong scope', value => ({ ...value, scope_id: `s_${'f'.repeat(48)}` })],
    ['wrong image', value => ({ ...value, image_id: `sha256:${'e'.repeat(64)}` })],
    ['wrong policy', value => ({ ...value, policy_sha256: 'e'.repeat(64) })],
  ]
  it.each(attestationMutations)('fails preflight closed for %s attestation', async (_case, mutate) => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const client = clientFixture(scopeId, [])
    const basePreflight = client.preflight
    const preflight: BuilderUnixClient['preflight'] = async (body, options) => mutate(await basePreflight(body, options))
    client.preflight = vi.fn(preflight)
    const resolver = resolverFixture(actor, installationId, client)
    await expect((await resolver.forActor(actor)).preflight(new AbortController().signal)).resolves.toEqual({ state: 'BLOCKED_EXTERNAL' })
  })

  it('maps lifecycle success results without exposing transport details', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const client = clientFixture(scopeId, [])
    const buildRef = 'build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const finish: BuilderUnixClient['finish'] = async () => ({ build_ref: buildRef, final_state: 'E2E_OK', exported: { relative_path: `exports/${buildRef}`, sha256: 'a'.repeat(64), files: 2, bytes: 3 }, cleanup_pending: false, cleaned: true })
    const listManaged: BuilderUnixClient['listManaged'] = async () => ({ builds: [{ build_ref: buildRef, build_id: 'logical-build', state: 'E2E_OK', exported: true, cleanup_pending: false }] })
    client.finish = vi.fn(finish)
    client.listManaged = vi.fn(listManaged)
    const session = await resolverFixture(actor, installationId, client).forActor(actor)
    await expect(session.cancel(buildRef, new AbortController().signal)).resolves.toBeUndefined()
    await expect(session.finish(buildRef)).resolves.toEqual({ finalState: 'E2E_OK', exported: { relative_path: `exports/${buildRef}`, sha256: 'a'.repeat(64), files: 2, bytes: 3 }, cleanupPending: false, cleaned: true })
    await expect(session.listManaged(new AbortController().signal)).resolves.toEqual([{ buildRef, buildId: 'logical-build', state: 'E2E_OK', exported: true, cleanupPending: false }])
    expect(managedBuild({ build_ref: buildRef, build_id: 'direct', state: 'FAILED', exported: false, cleanup_pending: true })).toEqual({ buildRef, buildId: 'direct', state: 'FAILED', exported: false, cleanupPending: true })
  })

  it('preserves lifecycle errors and classifies transport and unknown failures', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const client = clientFixture(scopeId, [])
    const session = await resolverFixture(actor, installationId, client).forActor(actor)
    client.cancel = vi.fn(async () => { throw new BuilderLifecycleError('CANCELLED', 'ALREADY_CANCELLED') })
    await expect(session.cancel('build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toMatchObject({ state: 'CANCELLED', code: 'ALREADY_CANCELLED' })
    client.finish = vi.fn(async () => { throw new Error('unknown transport failure') })
    await expect(session.finish('build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toMatchObject({ state: 'INTERRUPTED', code: 'UNKNOWN' })
    client.listManaged = vi.fn(async () => { throw new BuilderUnixClientError('SOCKET_UNAVAILABLE') })
    await expect(session.listManaged()).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'SOCKET_UNAVAILABLE' })
  })

  it('wraps unexpected registry failures without exposing their cause', async () => {
    const resolver = new ManagedBuilderLifecycleResolver({
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: { loadRegistry: vi.fn(async () => { throw new Error('private registry detail') }) },
    })
    await expect(resolver.forActor(actor)).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'BUILDER_SCOPE_UNAVAILABLE' })
  })

  it('refuses retiring-only slots and every mismatched resolved scope field', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const retiring = registryFixture(installationId, scopeId, 'retiring')
    const retiringResolver = new ManagedBuilderLifecycleResolver({
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: { loadRegistry: vi.fn(async () => retiring) },
    })
    await expect(retiringResolver.forActor(actor)).rejects.toMatchObject({ code: 'BUILDER_SCOPE_UNAVAILABLE' })

    const mutations: readonly ((config: BuilderSupervisorResolvedConfig) => BuilderSupervisorResolvedConfig)[] = [
      config => ({ ...config, installationId: 'z'.repeat(64) }),
      config => ({ ...config, tenantId: 't_other' }),
      config => ({ ...config, instanceId: 'other' }),
      config => ({ ...config, scopeId: `s_${'f'.repeat(48)}` }),
    ]
    for (const mutate of mutations) {
      const client = clientFixture(scopeId, [])
      const resolver = new ManagedBuilderLifecycleResolver({
        registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
        roots: customRoots(),
        instanceId: PROMPT_APP_BUILDER_INSTANCE_ID,
        dependencies: {
          loadRegistry: vi.fn(async () => registryFixture(installationId, scopeId)),
          loadConfig: vi.fn(async () => mutate(configFixture(installationId, tenantId, scopeId))),
          createClient: vi.fn(() => client), readCredential: vi.fn(async () => 'x'.repeat(43)),
        },
      })
      await expect(resolver.forActor(actor)).rejects.toMatchObject({ code: 'BUILDER_SCOPE_MISMATCH' })
    }
  })

  it('cannot resolve another organization that reuses the same logical tenant id', async () => {
    const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
    const resolver = new ManagedBuilderLifecycleResolver({
      registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
      dependencies: {
        loadRegistry: vi.fn(async () => registryFixture(installationId, scopeId)),
        loadConfig: vi.fn(), createClient: vi.fn(), readCredential: vi.fn(async () => 'x'.repeat(43)),
      },
    })
    await expect(resolver.forActor({ ...actor, orgId: 'org-b' })).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'BUILDER_SCOPE_UNAVAILABLE' })
  })
})

describe('lifecycle credential reader', () => {
  it('accepts only the same private regular inode through the open handle and path', async () => {
    const token = Buffer.from('x'.repeat(43), 'utf8')
    const stat = fakeStat()
    const close = vi.fn(async () => undefined)
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => token), close } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0x20000, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).resolves.toBe('x'.repeat(43))
    expect(runtime.open).toHaveBeenCalledWith('/run/private/token', expect.any(Number))
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails closed on a swapped path identity', async () => {
    const good = fakeStat(); const swapped = fakeStat({ ino: 9 })
    const handle = { stat: vi.fn(async () => good), readFile: vi.fn(async () => Buffer.from([0xff, 0xfe, 0xfd])), close: vi.fn(async () => undefined) } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => swapped), realpath: vi.fn(async path => path) }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'CREDENTIAL_UNAVAILABLE' })
  })

  it('fails closed on invalid UTF-8 from an otherwise stable handle', async () => {
    const stat = fakeStat({ size: 43 })
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(42, 120)])
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => bytes), close: vi.fn(async () => undefined) } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  })

  it.each([
    ['reference without file scheme', 'not-a-file-reference'],
    ['URL-like path', 'file:/run/private/https://token'],
  ])('rejects %s before opening a credential', async (_case, reference) => {
    const runtime: LifecycleCredentialRuntime = {
      platform: 'linux', uid: 1000, noFollowFlag: 0,
      open: vi.fn(async () => { throw new Error('open must not run') }),
      lstat: vi.fn(async () => fakeStat()), realpath: vi.fn(async path => path),
    }
    await expect(readSecureLifecycleCredential(reference, new AbortController().signal, runtime)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    expect(runtime.open).not.toHaveBeenCalled()
  })

  it('rejects a NUL byte after a stable second stat', async () => {
    const stat = fakeStat()
    const bytes = Buffer.concat([Buffer.from('x'.repeat(42)), Buffer.from([0])])
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => bytes), close: vi.fn(async () => undefined) } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  })

  it.each([
    ['LF', `${'x'.repeat(43)}\n`],
    ['CRLF', `${'x'.repeat(43)}\r\n`],
  ])('accepts one trailing %s terminator', async (_case, value) => {
    const stat = fakeStat()
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => Buffer.from(value)), close: vi.fn(async () => undefined) } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).resolves.toBe('x'.repeat(43))
  })

  it('rejects decoded text outside the credential alphabet', async () => {
    const stat = fakeStat()
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => Buffer.from(`+${'x'.repeat(42)}`)), close: vi.fn(async () => undefined) } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  })

  it('wraps an operating-system open failure and leaves no handle to close', async () => {
    const runtime: LifecycleCredentialRuntime = {
      platform: 'linux', uid: 1000, noFollowFlag: 0,
      open: vi.fn(async () => { throw new Error('private operating-system detail') }),
      lstat: vi.fn(async () => fakeStat()), realpath: vi.fn(async path => path),
    }
    await expect(readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime)).rejects.toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'CREDENTIAL_UNAVAILABLE' })
  })

  it('sanitizes a close failure after an otherwise successful read and closes exactly once', async () => {
    const stat = fakeStat()
    const close = vi.fn(async () => { throw new Error('private close detail') })
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => Buffer.from('x'.repeat(43))), close } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    const failure = await readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BuilderLifecycleError)
    expect(failure).toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'CREDENTIAL_UNAVAILABLE', message: 'CREDENTIAL_UNAVAILABLE' })
    expect(String(failure)).not.toContain('private close detail')
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves a sanitized primary failure when close also rejects and closes exactly once', async () => {
    const stat = fakeStat()
    const primary = new BuilderLifecycleError('BLOCKED_EXTERNAL', 'PRIMARY_SANITIZED')
    const close = vi.fn(async () => { throw new Error('private close detail') })
    const handle = { stat: vi.fn(async () => stat), readFile: vi.fn(async () => { throw primary }), close } as unknown as FileHandle
    const runtime: LifecycleCredentialRuntime = { platform: 'linux', uid: 1000, noFollowFlag: 0, open: vi.fn(async () => handle), lstat: vi.fn(async () => stat), realpath: vi.fn(async path => path) }
    const failure = await readSecureLifecycleCredential('file:/run/private/token', new AbortController().signal, runtime).catch((error: unknown) => error)
    expect(failure).toBe(primary)
    expect(failure).toMatchObject({ state: 'BLOCKED_EXTERNAL', code: 'PRIMARY_SANITIZED', message: 'PRIMARY_SANITIZED' })
    expect(String(failure)).not.toContain('private close detail')
    expect(close).toHaveBeenCalledOnce()
  })
})

function registryFixture(installationId: string, scopeId: `s_${string}`, state: 'active' | 'retiring' = 'active'): BuilderRuntimeRegistry {
  return {
    version: 1,
    installationId,
    generation: 1,
    sha256: 'b'.repeat(64),
    slots: [{ scopeId, configReference: `file:/etc/dz23-studio/builder/instances/${scopeId}/supervisor.json`, configSha256: 'c'.repeat(64), state }],
  } satisfies BuilderRuntimeRegistry
}

function customRoots(): BuilderSupervisorRootPolicy {
  return {
    configRoot: '/etc/dz23-studio/builder',
    secretRoot: '/run/secrets/dz23-studio/builder',
    socketRoot: '/run/dz23-studio/builder',
    artifactRoot: '/srv/dz23-studio/generated-runs',
    exportRoot: '/srv/dz23-studio/builder-exports',
    stateRoot: '/var/lib/dz23-studio/builder',
    dockerSocketPath: '/var/run/docker.sock',
  }
}

function resolverFixture(actor: PromptToAppActor, installationId: string, client: BuilderUnixClient): ManagedBuilderLifecycleResolver {
  const tenantId = opaqueTenantIdentity(actor.orgId, actor.tenantId)
  const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID })
  return new ManagedBuilderLifecycleResolver({
    registryReference: 'file:/etc/dz23-studio/builder/manager/runtime-registry.json',
    dependencies: {
      loadRegistry: async () => registryFixture(installationId, scopeId),
      loadConfig: async () => configFixture(installationId, tenantId, scopeId),
      createClient: () => client,
      readCredential: async () => 'x'.repeat(43),
    },
  })
}

function configFixture(installationId: string, tenantId: string, scopeId: `s_${string}`): BuilderSupervisorResolvedConfig {
  return { installationId, tenantId, instanceId: PROMPT_APP_BUILDER_INSTANCE_ID, scopeId, socketPath: `/run/dz23-studio/builder/instances/${scopeId}/rpc.sock`, artifactRoot: `/srv/dz23-studio/generated-runs/instances/${scopeId}`, exportRoot: `/srv/dz23-studio/builder-exports/instances/${scopeId}`, journalRoot: `/var/lib/dz23-studio/builder/instances/${scopeId}/journal`, replayRoot: `/var/lib/dz23-studio/builder/instances/${scopeId}/rpc-replay`, dockerSocketPath: '/var/run/docker.sock', bearerToken: 'x'.repeat(43), imageDigest: `sha256:${'d'.repeat(64)}`, templateStoreVersion: 'v1', templateStoreSha256: 'e'.repeat(64), policySha256: 'f'.repeat(64) } satisfies BuilderSupervisorResolvedConfig
}

function clientFixture(scopeId: `s_${string}`, executeBodies: unknown[]): BuilderUnixClient {
  const preflight: BuilderUnixClient['preflight'] = async () => ({ state: 'OK', protocol_version: 1, scope_id: scopeId, image_id: `sha256:${'d'.repeat(64)}`, policy_sha256: 'f'.repeat(64) })
  const prepare: BuilderUnixClient['prepare'] = async () => ({ build_ref: 'build_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: 'PREPARED' })
  const execute: BuilderUnixClient['execute'] = async body => {
    executeBodies.push(body)
    return { build_ref: body.build_ref, state: 'BUILD_OK', step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } }
  }
  const cancel: BuilderUnixClient['cancel'] = async body => ({ build_ref: body.build_ref, state: 'CANCELLED' })
  const finish: BuilderUnixClient['finish'] = async body => ({ build_ref: body.build_ref, final_state: 'FAILED', exported: null, cleanup_pending: false, cleaned: true })
  const listManaged: BuilderUnixClient['listManaged'] = async () => ({ builds: [] })
  return {
    preflight: vi.fn(preflight),
    prepare: vi.fn(prepare),
    execute: vi.fn(execute),
    cancel: vi.fn(cancel),
    finish: vi.fn(finish),
    listManaged: vi.fn(listManaged),
  } satisfies BuilderUnixClient
}

function credentialClient(options: BuilderUnixClientOptions, readCredential: ReturnType<typeof vi.fn>, client: BuilderUnixClient): BuilderUnixClient {
  const authenticate = async (signal?: AbortSignal) => { await options.credentials.resolve(options.credentialRef, signal ?? new AbortController().signal) }
  return {
    preflight: async (body, call) => { await authenticate(call?.signal); return client.preflight(body, call) },
    prepare: async (body, call) => { await authenticate(call?.signal); return client.prepare(body, call) },
    execute: async (body, call) => { await authenticate(call?.signal); return client.execute(body, call) },
    cancel: async (body, call) => { await authenticate(call?.signal); return client.cancel(body, call) },
    finish: async (body, call) => { await authenticate(call?.signal); return client.finish(body, call) },
    listManaged: async (body, call) => { await authenticate(call?.signal); return client.listManaged(body, call) },
  }
}

function fakeStat(overrides: Partial<{ ino: number; size: number }> = {}): Stats {
  return { dev: 1, ino: overrides.ino ?? 2, nlink: 1, uid: 1000, gid: 1000, mode: 0o100600, size: overrides.size ?? 43, mtimeMs: 1, ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false } as Stats
}
