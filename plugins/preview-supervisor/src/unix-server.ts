import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, posix } from 'node:path'
import type { PreviewSupervisorPort } from './manager.js'
import { createSupervisorRpcHandler, SUPERVISOR_RPC_MAX_BODY_BYTES } from './protocol.js'

const CREDENTIAL_REFERENCE = 'file:/run/secrets/dz23-preview-supervisor-token'

export interface SupervisorUnixServerOptions {
  readonly socketPath: string
  readonly bearerToken: string
  readonly manager: PreviewSupervisorPort
  readonly signal?: AbortSignal
}

export async function listenSupervisorUnix(options: SupervisorUnixServerOptions): Promise<{ readonly server: Server; close(): Promise<void> }> {
  const socketPath = validSocketPath(options.socketPath)
  if (!/^[A-Za-z0-9_-]{43,200}$/u.test(options.bearerToken)) throw new Error('INVALID_SUPERVISOR_TOKEN')
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o770 })
  await removeStaleSocket(socketPath)
  const server = createServer((request, response) => { void handle(request, response, options).catch(() => writeFailure(response)) })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 64
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  await chmod(socketPath, 0o660)
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      await unlink(socketPath).catch(() => undefined)
    },
  }
}

async function handle(request: IncomingMessage, response: ServerResponse, options: SupervisorUnixServerOptions): Promise<void> {
  const controller = new AbortController()
  const abortFromSupervisor = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted === true) abortFromSupervisor()
  else options.signal?.addEventListener('abort', abortFromSupervisor, { once: true })
  request.once('aborted', () => controller.abort())
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  const rpc = createSupervisorRpcHandler({
    credentialRef: CREDENTIAL_REFERENCE,
    credentials: { resolve: async () => options.bearerToken },
    methods: {
      start: (params, signal) => options.manager.start(params, signal),
      stop: async (params, signal) => { await options.manager.stop(params.runtime_ref, signal); return { stopped: true } },
      health: async (params, signal) => ({ health: await options.manager.health(params.runtime_ref, signal) }),
      logs: async (params, signal) => ({ events: await options.manager.logs(params.runtime_ref, params.limit, signal) }),
      'verification-messages': async (params, signal) => ({ messages: await options.manager.verificationMessages(params.runtime_ref, signal) }),
      'list-managed': async (_params, signal) => ({ runtimes: await options.manager.listManaged(signal) }),
    },
  })
  try {
    let body: Buffer
    try { body = await readBounded(request) } catch { body = Buffer.alloc(SUPERVISOR_RPC_MAX_BODY_BYTES + 1) }
    const result = await rpc.handle({
      path: request.url ?? '/', method: request.method ?? '',
      headers: { authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined },
      body, signal: controller.signal,
    })
    response.writeHead(result.status, result.headers)
    response.end(result.body)
  } finally {
    options.signal?.removeEventListener('abort', abortFromSupervisor)
  }
}

async function readBounded(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
    if (size > SUPERVISOR_RPC_MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function validSocketPath(value: string): string {
  if (!posix.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.includes('://')) throw new Error('INVALID_SOCKET_PATH')
  return posix.normalize(value)
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const current = await lstat(path)
    if (!current.isSocket()) throw new Error('SOCKET_PATH_OCCUPIED')
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function writeFailure(response: ServerResponse): void {
  if (response.writableEnded) return
  const body = Buffer.from('{"error":"SUPERVISOR_UNAVAILABLE"}', 'utf8')
  response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
  response.end(body)
}
