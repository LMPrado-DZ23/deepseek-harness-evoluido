import { request as httpRequest } from 'node:http'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuilderRpcMethods } from '../src/protocol.js'
import { listenBuilderUnix } from '../src/unix-server.js'

const roots: string[] = []; const listeners: Array<{ close(): Promise<void> }> = []
const token = 'A'.repeat(43)
afterEach(async () => {
  await Promise.all(listeners.splice(0).map(item => item.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('authenticated Unix builder socket', () => {
  it('creates mode 0660, rejects unauthenticated input and removes the socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-unix-')); roots.push(root)
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const methods = fakeMethods()
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods }); listeners.push(listener)
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o660)
    expect(await send(socketPath, undefined)).toMatchObject({ status: 401 })
    expect(methods.preflight).not.toHaveBeenCalled()
    expect(await send(socketPath, token)).toEqual({ status: 200, body: { ok: true, result: { state: 'OK' } } })
    await listener.close(); listeners.splice(0, 1)
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid server authority before listening', async () => {
    const methods = fakeMethods()
    await expect(listenBuilderUnix({ socketPath: 'relative.sock', bearerToken: token, methods })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/../tmp/builder.sock', bearerToken: token, methods })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: 'short', methods })).rejects.toThrow('INVALID_SUPERVISOR_TOKEN')
  })
})

function fakeMethods(): BuilderRpcMethods {
  return {
    preflight: vi.fn(async () => ({ state: 'OK' as const })),
    prepare: vi.fn(async () => ({ build_ref: `build_${'a'.repeat(32)}`, state: 'PREPARED' as const })),
    execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'INSTALL_OK' as const, step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, output_limited: false } })),
    cancel: vi.fn(async body => ({ build_ref: body.build_ref, state: 'CANCELLED' as const })),
    finish: vi.fn(async body => ({ build_ref: body.build_ref, final_state: 'E2E_OK' as const, cleaned: true as const })),
    listManaged: vi.fn(async () => ({ builds: [] })),
  }
}

async function send(socketPath: string, bearer: string | undefined): Promise<{ readonly status: number; readonly body: unknown }> {
  const body = Buffer.from(JSON.stringify({ operation: 'preflight', body: { request_id: `req_${'a'.repeat(32)}` } }))
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path: '/v1/rpc', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': String(body.byteLength), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }))
    })
    request.once('error', reject); request.end(body)
  })
}
