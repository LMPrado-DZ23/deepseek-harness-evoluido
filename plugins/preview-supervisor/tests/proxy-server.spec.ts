import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenPreviewProxy, type PreviewProxyOptions } from '../src/proxy-server.js'

interface ProxyResponse {
  readonly status: number
  readonly body: unknown
}

const runtimeServers: Server[] = []
const proxyListeners: Array<{ close(): Promise<void> }> = []
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(proxyListeners.splice(0).map(listener => listener.close().catch(() => undefined)))
  await Promise.all(runtimeServers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function startRuntime(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler)
  runtimeServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(3000, '127.0.0.1', resolve)
  })
  return server
}

async function startProxy(overrides: Partial<PreviewProxyOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-preview-proxy-'))
  temporaryRoots.push(root)
  const dataRoot = join(root, 'data')
  await mkdir(dataRoot)
  const options: PreviewProxyOptions = {
    socketPath: join(root, 'proxy.sock').replaceAll('\\', '/'),
    runtimeRef: 'container:preview-01',
    runtimeHost: '127.0.0.1',
    previewId: 'preview-01',
    dataRoot: dataRoot.replaceAll('\\', '/'),
    ...overrides,
  }
  const listener = await listenPreviewProxy(options)
  proxyListeners.push(listener)
  return { listener, options, root }
}

function forwardEnvelope(overrides: Partial<{
  runtime_ref: string
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
  path: string
  headers: Readonly<Record<string, string>>
  body_base64: string
}> = {}): unknown {
  return {
    operation: 'forward',
    body: {
      runtime_ref: 'container:preview-01', method: 'POST', path: '/submit?source=preview',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dz23-preview-test' },
      body_base64: Buffer.from('{"safe":true}').toString('base64'),
      ...overrides,
    },
  }
}

function messagesEnvelope(): unknown {
  return { operation: 'verification-messages', body: { runtime_ref: 'container:preview-01' } }
}

async function sendProxy(socketPath: string, value: unknown, rawBody?: Buffer): Promise<ProxyResponse> {
  const body = rawBody ?? Buffer.from(JSON.stringify(value))
  return new Promise<ProxyResponse>((resolve, reject) => {
    const request = httpRequest({
      socketPath, method: 'POST', path: '/v1/data',
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) as unknown })
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}

const describeUnix = describe.skipIf(process.platform === 'win32')

describeUnix('preview proxy Unix-socket boundary', () => {
  it('forwards to the configured runtime host and rewrites/removes authority and internal headers', async () => {
    let received: {
      url?: string | undefined
      method?: string | undefined
      headers?: IncomingMessage['headers']
      body?: string
    } = {}
    await startRuntime((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      request.on('end', () => {
        received = {
          url: request.url, method: request.method, headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    const proxy = await startProxy()

    const response = await sendProxy(proxy.options.socketPath, forwardEnvelope({
      headers: {
        accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dz23-preview-test',
        host: 'attacker.example:2375', authorization: 'Bearer secret', cookie: '__Host-dz23_preview=secret; app_session=allowed',
        connection: 'upgrade', upgrade: 'websocket', 'x-forwarded-for': '203.0.113.9',
        'x-forwarded-host': 'attacker.example', 'x-dz23-internal': 'forged',
      },
    }))

    expect(response.status).toBe(200)
    expect(received).toMatchObject({ url: '/submit?source=preview', method: 'POST', body: '{"safe":true}' })
    expect(received.headers).toMatchObject({
      host: '127.0.0.1:3000', accept: 'application/json', 'content-type': 'application/json',
      'user-agent': 'dz23-preview-test', cookie: 'app_session=allowed',
    })
    for (const forbidden of ['authorization', 'connection', 'upgrade', 'x-forwarded-for', 'x-forwarded-host', 'x-dz23-internal']) {
      expect(received.headers?.[forbidden]).toBeUndefined()
    }
    expect(JSON.stringify(received.headers)).not.toContain('__Host-dz23_preview')
  })

  it('returns only allowlisted runtime response headers and never exposes hop-by-hop or internal metadata', async () => {
    await startRuntime((_request, response) => {
      response.writeHead(201, {
        'content-type': 'text/plain', etag: 'safe-etag', 'last-modified': 'Wed, 03 Sep 2026 12:00:00 GMT',
        location: '/next', 'set-cookie': ['app_session=safe; Path=/; HttpOnly'],
        connection: 'close', 'x-powered-by': 'secret-runtime', 'x-dz23-internal': 'secret',
      })
      response.end('created')
    })
    const proxy = await startProxy()

    const response = await sendProxy(proxy.options.socketPath, forwardEnvelope({ method: 'GET', body_base64: '' }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      status: 201,
      headers: {
        'content-type': 'text/plain', etag: 'safe-etag', 'last-modified': 'Wed, 03 Sep 2026 12:00:00 GMT',
        location: '/next', 'set-cookie': ['app_session=safe; Path=/; HttpOnly'],
      },
      body_base64: Buffer.from('created').toString('base64'),
    })
    expect(JSON.stringify(response.body)).not.toContain('secret-runtime')
    expect(JSON.stringify(response.body)).not.toContain('x-dz23-internal')
  })

  it('rejects a mismatched runtime reference without contacting the configured runtime', async () => {
    const runtimeHit = vi.fn()
    await startRuntime((_request, response) => { runtimeHit(); response.end() })
    const proxy = await startProxy()

    const response = await sendProxy(proxy.options.socketPath, forwardEnvelope({ runtime_ref: 'container:other' }))
    expect(response).toEqual({ status: 400, body: { error: 'INVALID_REQUEST' } })
    expect(runtimeHit).not.toHaveBeenCalled()
  })

  it('bounds the RPC body, forwarded body and runtime response without returning partial content', async () => {
    const runtimeBodies: number[] = []
    await startRuntime((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      request.on('end', () => {
        runtimeBodies.push(Buffer.concat(chunks).byteLength)
        response.end(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
      })
    })
    const proxy = await startProxy()

    const tooLargeRpc = await sendProxy(proxy.options.socketPath, {}, Buffer.alloc(3 * 1024 * 1024 + 1, 0x61))
    expect(tooLargeRpc).toEqual({ status: 400, body: { error: 'INVALID_REQUEST' } })
    expect(runtimeBodies).toEqual([])

    const maximumBody = Buffer.alloc(2 * 1024 * 1024, 0x62)
    const oversizedResponse = await sendProxy(proxy.options.socketPath, forwardEnvelope({ body_base64: maximumBody.toString('base64') }))
    expect(runtimeBodies).toEqual([maximumBody.byteLength])
    expect(oversizedResponse).toEqual({ status: 502, body: { error: 'PREVIEW_UNAVAILABLE' } })
    expect(JSON.stringify(oversizedResponse.body)).not.toContain('a'.repeat(1_000))
  }, 15_000)

  it('aborts the outbound runtime request when the Unix-socket caller disconnects', async () => {
    let runtimeRequestClosed = false
    let runtimeReached!: () => void
    const reached = new Promise<void>(resolve => { runtimeReached = resolve })
    await startRuntime(request => {
      runtimeReached()
      request.once('aborted', () => { runtimeRequestClosed = true })
      request.once('close', () => { runtimeRequestClosed = true })
    })
    const proxy = await startProxy()
    const body = Buffer.from(JSON.stringify(forwardEnvelope()))
    const caller = httpRequest({
      socketPath: proxy.options.socketPath, method: 'POST', path: '/v1/data',
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    })
    caller.on('error', () => undefined)
    caller.end(body)
    await reached
    caller.destroy()
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(runtimeRequestClosed).toBe(true)
  })

  it('fails within the configured outbound timeout when the runtime never responds', async () => {
    let runtimeReached!: () => void
    const reached = new Promise<void>(resolve => { runtimeReached = resolve })
    const runtime = await startRuntime(() => { runtimeReached() })
    const proxy = await startProxy({ runtimeTimeoutMs: 75 } as Partial<PreviewProxyOptions>)
    const responsePromise = sendProxy(proxy.options.socketPath, forwardEnvelope()).catch(() => undefined)
    await reached
    const settledInTime = await Promise.race([
      responsePromise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    if (!settledInTime) runtime.closeAllConnections()
    await responsePromise

    expect(settledInTime).toBe(true)
  })

  it('creates a real socket and removes it on close', async () => {
    const proxy = await startProxy()
    expect((await lstat(proxy.options.socketPath)).isSocket()).toBe(true)

    await proxy.listener.close()
    proxyListeners.splice(proxyListeners.indexOf(proxy.listener), 1)

    await expect(lstat(proxy.options.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never deletes and replaces an occupied regular file at the configured socket path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-preview-proxy-occupied-'))
    temporaryRoots.push(root)
    const socketPath = join(root, 'proxy.sock').replaceAll('\\', '/')
    const dataRoot = join(root, 'data').replaceAll('\\', '/')
    await mkdir(dataRoot)
    await writeFile(socketPath, 'operator-owned-file')

    await expect(listenPreviewProxy({
      socketPath, runtimeRef: 'container:preview-01', runtimeHost: '127.0.0.1', previewId: 'preview-01', dataRoot,
    })).rejects.toThrow()
    expect(await readFile(socketPath, 'utf8')).toBe('operator-owned-file')
  })

  it('reads only bounded regular capture files and filters every malformed message field', async () => {
    const proxy = await startProxy()
    const previewRoot = join(proxy.options.dataRoot, proxy.options.previewId)
    const capture = join(previewRoot, 'preview-capture.json')
    await mkdir(previewRoot)
    const valid = { kind: 'code', email: 'person@example.com', code: '123456', expiresAt: '2026-09-04T12:00:00.000Z' }
    const invalid = [
      null,
      [],
      'string',
      { ...valid, extra: true },
      { ...valid, kind: 'other' },
      { ...valid, email: 'not-an-email' },
      { ...valid, code: '12345' },
      { ...valid, expiresAt: 'not-a-date' },
    ]
    await writeFile(capture, JSON.stringify([valid, ...invalid]))
    expect(await sendProxy(proxy.options.socketPath, messagesEnvelope())).toEqual({
      status: 200, body: { messages: [valid] },
    })

    await writeFile(capture, JSON.stringify(Array.from({ length: 21 }, () => valid)))
    expect(await sendProxy(proxy.options.socketPath, messagesEnvelope())).toEqual({ status: 200, body: { messages: [] } })
    await writeFile(capture, '{invalid json')
    expect(await sendProxy(proxy.options.socketPath, messagesEnvelope())).toEqual({ status: 200, body: { messages: [] } })
    await writeFile(capture, 'x'.repeat(64 * 1024 + 1))
    expect(await sendProxy(proxy.options.socketPath, messagesEnvelope())).toEqual({ status: 200, body: { messages: [] } })

    await rm(capture)
    await mkdir(capture)
    expect(await sendProxy(proxy.options.socketPath, messagesEnvelope())).toEqual({ status: 200, body: { messages: [] } })
    await rm(capture, { recursive: true })
    await symlink(join(previewRoot, 'absent.json'), capture)
    expect(await sendProxy(proxy.options.socketPath, messagesEnvelope())).toEqual({ status: 200, body: { messages: [] } })
  })

  it('rejects every invalid proxy boundary option before opening a socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-preview-proxy-invalid-'))
    temporaryRoots.push(root)
    const valid: PreviewProxyOptions = {
      socketPath: join(root, 'proxy.sock').replaceAll('\\', '/'),
      runtimeRef: 'container:preview-01', runtimeHost: '127.0.0.1', previewId: 'preview-01', dataRoot: root.replaceAll('\\', '/'),
    }
    const invalid: PreviewProxyOptions[] = [
      { ...valid, socketPath: 'relative.sock' },
      { ...valid, socketPath: '/tmp/bad\\socket' },
      { ...valid, socketPath: '/tmp/bad\0socket' },
      { ...valid, runtimeRef: '' },
      { ...valid, runtimeHost: 'UPPERCASE' },
      { ...valid, previewId: 'bad/id' },
      { ...valid, dataRoot: 'relative' },
      { ...valid, runtimeTimeoutMs: 49 },
      { ...valid, runtimeTimeoutMs: 30_001 },
      { ...valid, runtimeTimeoutMs: Number.NaN },
    ]
    for (const options of invalid) await expect(listenPreviewProxy(options)).rejects.toThrow(/INVALID_/u)
  })
})
