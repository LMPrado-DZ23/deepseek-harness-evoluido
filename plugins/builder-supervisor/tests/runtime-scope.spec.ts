import { describe, expect, it } from 'vitest'
import {
  BUILDER_RUNTIME_SCOPE_DOMAIN,
  BUILDER_RUNTIME_SCOPE_VERSION,
  BUILDER_UNIX_SOCKET_MAX_BYTES,
  builderRuntimeSocketPath,
  deriveBuilderRuntimeScopeId,
  isBuilderRuntimeScopeId,
} from '../src/runtime-scope.js'

const installationId = 'a'.repeat(64)

describe('builder runtime physical scope', () => {
  it('derives a stable domain-separated scope and separates tenants even with the same instance', () => {
    const first = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'primary' })
    const again = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'primary' })
    const otherTenant = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-two', instanceId: 'primary' })

    expect(first).toBe(again)
    expect(first).toMatch(/^s_[a-f0-9]{48}$/u)
    expect(otherTenant).not.toBe(first)
    expect(BUILDER_RUNTIME_SCOPE_DOMAIN).toBe('com.dz23.studio.builder.runtime-scope')
    expect(BUILDER_RUNTIME_SCOPE_VERSION).toBe(1)
  })

  it('binds installation, tenant and instance and rejects malformed identities', () => {
    const reference = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'primary' })
    expect(deriveBuilderRuntimeScopeId({ installationId: 'b'.repeat(64), tenantId: 'tenant-one', instanceId: 'primary' })).not.toBe(reference)
    expect(deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'secondary' })).not.toBe(reference)
    for (const input of [
      { installationId: 'A'.repeat(64), tenantId: 'tenant-one', instanceId: 'primary' },
      { installationId: 'a'.repeat(63), tenantId: 'tenant-one', instanceId: 'primary' },
      { installationId, tenantId: '../tenant', instanceId: 'primary' },
      { installationId, tenantId: 'tenant-one', instanceId: 'bad/instance' },
      { installationId, tenantId: 't'.repeat(65), instanceId: 'primary' },
    ]) expect(() => deriveBuilderRuntimeScopeId(input)).toThrow('INVALID_RUNTIME_SCOPE')
    expect(isBuilderRuntimeScopeId(reference)).toBe(true)
    expect(isBuilderRuntimeScopeId('tenant-one')).toBe(false)
  })

  it('derives the fixed short socket path and enforces sockaddr_un maximum bytes', () => {
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'primary' })
    const path = builderRuntimeSocketPath('/run/dz23-studio/builder', scopeId)
    expect(path).toBe(`/run/dz23-studio/builder/instances/${scopeId}/rpc.sock`)
    expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(BUILDER_UNIX_SOCKET_MAX_BYTES)
    expect(() => builderRuntimeSocketPath(`/${'a'.repeat(60)}`, scopeId)).toThrow('UNIX_SOCKET_PATH_TOO_LONG')
    expect(() => builderRuntimeSocketPath('/run/../run/dz23', scopeId)).toThrow('INVALID_RUNTIME_SCOPE')
    expect(() => builderRuntimeSocketPath('/run/dz23', 'tenant-one' as never)).toThrow('INVALID_RUNTIME_SCOPE')
  })
})
