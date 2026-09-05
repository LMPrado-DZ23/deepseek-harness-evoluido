import { describe, expect, it, vi } from 'vitest'
import { BUILDER_PROVISION_EXIT, executeBuilderProvisionCli } from '../src/provision-main.js'
import { BuilderProvisionError, type BuilderProvisionResult } from '../src/store-provision.js'

const argv = [
  '--installation-id', 'a'.repeat(64), '--tenant', 'tenant-one', '--instance', 'instance-one', '--source-root', '/opt/source',
  '--manifest', 'file:/opt/manifest.json', '--manifest-sha256', 'a'.repeat(64),
  '--image-digest', `sha256:${'b'.repeat(64)}`, '--policy-sha256', 'c'.repeat(64),
] as const

const result: BuilderProvisionResult = {
  state: 'CREATED', scope_id: `s_${'d'.repeat(48)}`, template_store_version: 'v1',
  template_store_sha256: 'd'.repeat(64), manifest_sha256: 'a'.repeat(64), config_reference: 'file:/secret/config.json',
}

describe('local builder provision CLI', () => {
  it('accepts every public non-secret input exactly once and emits a reduced result', async () => {
    const provision = vi.fn(async () => result)
    const output = vi.fn(); const error = vi.fn()
    await expect(executeBuilderProvisionCli(argv, { provision, output, error })).resolves.toBe(BUILDER_PROVISION_EXIT.ok)
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ installationId: 'a'.repeat(64), tenantId: 'tenant-one', instanceId: 'instance-one', sourceRoot: '/opt/source' }))
    expect(output).toHaveBeenCalledOnce()
    const emitted = output.mock.calls[0]?.[0] ?? ''
    expect(emitted).toContain('builder-provisioned')
    expect(emitted).not.toContain(result.config_reference)
    expect(emitted).not.toContain(result.template_store_sha256)
    expect(emitted).not.toContain(result.template_store_version)
    expect(emitted).not.toContain('tenant-one')
    expect(emitted).not.toContain('instance-one')
    expect(emitted).toContain(result.scope_id)
    expect(Object.keys(JSON.parse(emitted) as Record<string, unknown>).sort()).toEqual(['event', 'scope_id', 'state'])
    expect(error).not.toHaveBeenCalled()
  })

  it.each([
    { invalid: [] as string[] }, { invalid: argv.slice(0, -2) }, { invalid: [...argv, '--tenant', 'again'] },
    { invalid: argv.map((value, index) => index === 0 ? '--unknown' : value) },
    { invalid: argv.map((value, index) => index === 1 ? '' : value) },
  ])('rejects malformed, missing, repeated, unknown and empty arguments %#', async ({ invalid }) => {
    const provision = vi.fn(async () => result); const error = vi.fn()
    await expect(executeBuilderProvisionCli(invalid, { provision, output: vi.fn(), error })).resolves.toBe(BUILDER_PROVISION_EXIT.usage)
    expect(provision).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('{"event":"builder-provision-error","code":"INVALID_ARGUMENTS"}')
  })

  it('reports allowlisted provisioning codes and collapses unknown failures without leaking messages', async () => {
    const error = vi.fn()
    await expect(executeBuilderProvisionCli(argv, { provision: async () => { throw new BuilderProvisionError('SOURCE_UNSAFE') }, output: vi.fn(), error })).resolves.toBe(BUILDER_PROVISION_EXIT.failed)
    expect(error).toHaveBeenLastCalledWith('{"event":"builder-provision-error","code":"SOURCE_UNSAFE"}')
    const secret = 'not-for-logs'
    await expect(executeBuilderProvisionCli(argv, { provision: async () => { throw new Error(secret) }, output: vi.fn(), error })).resolves.toBe(BUILDER_PROVISION_EXIT.failed)
    expect(error).toHaveBeenLastCalledWith('{"event":"builder-provision-error","code":"PROVISION_FAILED"}')
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret)
  })

  it('uses reduced default stdout/stderr writers without exposing authority values', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(executeBuilderProvisionCli(argv, { provision: async () => result })).resolves.toBe(BUILDER_PROVISION_EXIT.ok)
      await expect(executeBuilderProvisionCli([], { provision: async () => result })).resolves.toBe(BUILDER_PROVISION_EXIT.usage)
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('builder-provisioned'))
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('INVALID_ARGUMENTS'))
      expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain(result.config_reference)
    } finally {
      stdout.mockRestore(); stderr.mockRestore()
    }
  })
})
