import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export const BUILDER_RUNTIME_SCOPE_DOMAIN = 'com.dz23.studio.builder.runtime-scope'
export const BUILDER_RUNTIME_SCOPE_VERSION = 1
export const BUILDER_UNIX_SOCKET_MAX_BYTES = 107

export type BuilderRuntimeScopeId = `s_${string}`

export interface BuilderRuntimeScopeInput {
  readonly installationId: string
  readonly tenantId: string
  readonly instanceId: string
}

export function deriveBuilderRuntimeScopeId(input: BuilderRuntimeScopeInput): BuilderRuntimeScopeId {
  if (!isInstallationId(input.installationId) || !isRuntimeIdentifier(input.tenantId) || !isRuntimeIdentifier(input.instanceId)) {
    throw new Error('INVALID_RUNTIME_SCOPE')
  }
  const canonical = JSON.stringify({
    domain: BUILDER_RUNTIME_SCOPE_DOMAIN,
    version: BUILDER_RUNTIME_SCOPE_VERSION,
    installation_id: input.installationId,
    tenant_id: input.tenantId,
    instance_id: input.instanceId,
  })
  return `s_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 48)}`
}

export function isBuilderRuntimeScopeId(value: unknown): value is BuilderRuntimeScopeId {
  return typeof value === 'string' && /^s_[a-f0-9]{48}$/u.test(value)
}

export function builderRuntimeSocketPath(socketRoot: string, scopeId: BuilderRuntimeScopeId): string {
  if (!canonicalAbsolutePosix(socketRoot) || !isBuilderRuntimeScopeId(scopeId)) throw new Error('INVALID_RUNTIME_SCOPE')
  const path = posix.join(socketRoot, 'instances', scopeId, 'rpc.sock')
  if (Buffer.byteLength(path, 'utf8') > BUILDER_UNIX_SOCKET_MAX_BYTES) throw new Error('UNIX_SOCKET_PATH_TOO_LONG')
  return path
}

export function isInstallationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export function isRuntimeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)
}

function canonicalAbsolutePosix(value: string): boolean {
  return posix.isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && !value.includes('://') && posix.normalize(value) === value && (value === '/' || !value.endsWith('/'))
}
