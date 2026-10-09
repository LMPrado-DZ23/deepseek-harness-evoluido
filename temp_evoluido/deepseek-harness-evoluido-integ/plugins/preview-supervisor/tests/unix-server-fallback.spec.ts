import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewSupervisorPort } from '../src/manager.js'

vi.mock('../src/protocol.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/protocol.js')>(),
  createSupervisorRpcHandler: () => ({
    handle: async () => { throw new Error('internal path /var/run/docker.sock token=secret') },
  }),
}))

const onPosix = process.platform !== 'win32'
const TOKEN = 'A'.repeat(43)
const roots: string[] = []
const listeners: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(listeners.splice(0).map(listener => listener.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!onPosix)('preview supervisor Unix transport fallback', () => {
  it('returns only a closed generic error when the RPC boundary rejects unexpectedly', async () => {
    const { listenSupervisorUnix } = await import('../src/unix-server.js')
    const root = await mkdtemp(join(tmpdir(), 'dz23-supervisor-fallback-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock').replaceAll('\\', '/')
    const listener = await listenSupervisorUnix({ socketPath, bearerToken: TOKEN, manager: managerThatMustNotRun() })
    listeners.push(listener)

    const result = await request(socketPath)

    expect(result).toEqual({ status: 500, body: { error: 'SUPERVISOR_UNAVAILABLE' } })
    expect(JSON.stringify(result)).not.toMatch(/docker|socket|secret|var\/run/u)
  })
})

function managerThatMustNotRun(): PreviewSupervisorPort {
  const unexpected = async (): Promise<never> => { throw new Error('MANAGER_MUST_NOT_RUN') }
  return {
    start: unexpected,
    stop: unexpected,
    health: unexpected,
    logs: unexpected,
    verificationMessages: unexpected,
    listManaged: unexpected,
    forward: unexpected,
  }
}

async function request(socketPath: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const body = Buffer.from('{}', 'utf8')
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      path: '/v1/rpc',
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(body.byteLength) },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.once('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
        } catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}
