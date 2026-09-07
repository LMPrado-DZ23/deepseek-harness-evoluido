import { createServer, type Server } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COOKIE_HEADER_LIMIT_BYTES,
  createIdentityHttpHandler,
  SESSION_COOKIE,
} from '../src/http.ts'
import type { SessionRecord } from '../src/model.ts'
import type { StudioIdentityService } from '../src/service.ts'

const session: SessionRecord = {
  session_id: 'session-raw', user_id: 'user-raw', org_id: 'org-raw', tenant_id: 'tenant-raw',
  token_hash: 'a'.repeat(64), csrf_hash: 'b'.repeat(64), device_label: 'Socket bruto',
  user_agent: 'Vitest', ip_truncated: '127.0.0.0/24', created_at: '2026-09-07T00:00:00.000Z',
  last_seen_at: '2026-09-07T00:00:00.000Z', expires_sliding_at: '2026-09-21T00:00:00.000Z',
  expires_absolute_at: '2026-12-06T00:00:00.000Z', last_strong_auth_at: null,
  last_strong_auth_method: null, revoked_at: null, revoked_reason: null, harness_session_ids: [],
}

interface RawResponse {
  readonly status: number
  readonly headers: ReadonlyMap<string, readonly string[]>
  readonly body: string
}

interface RawFixture {
  readonly server: Server
  readonly port: number
  readonly host: string
  readonly origin: string
  readonly observedCookies: (string | undefined)[]
  readonly service: {
    readonly authenticate: ReturnType<typeof vi.fn<(token: string) => Promise<SessionRecord>>>
    readonly validateCsrfToken: ReturnType<typeof vi.fn>
    readonly revokeSession: ReturnType<typeof vi.fn<() => Promise<void>>>
  }
  readonly resolveEdgeSecret: ReturnType<typeof vi.fn<() => Promise<string>>>
}

const servers: Server[] = []

afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
  server.close(() => resolve())
}))))

async function fixture(edgeRequired = false): Promise<RawFixture> {
  const observedCookies: (string | undefined)[] = []
  const service = {
    authenticate: vi.fn<(token: string) => Promise<SessionRecord>>(() => Promise.resolve(session)),
    validateCsrfToken: vi.fn(),
    revokeSession: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  }
  const resolveEdgeSecret = vi.fn<() => Promise<string>>(() => Promise.resolve('edge-secret'))
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const handler = createIdentityHttpHandler({
    service: service as unknown as StudioIdentityService,
    bindHost: '127.0.0.1',
    allowedHosts,
    allowedOrigins,
    edgeRequired,
    resolveEdgeSecret,
    secureCookies: false,
  })
  const server = createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
    observedCookies.push(request.headers.cookie)
    void handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  allowedHosts.push(host)
  allowedOrigins.push(origin)
  return { server, port, host, origin, observedCookies, service, resolveEdgeSecret }
}

function cookieLines(paddingLength: number): { readonly lines: readonly string[]; readonly normalized: string } {
  const padding = `padding=${'x'.repeat(paddingLength)}`
  const sessionCookie = `${SESSION_COOKIE}=session-token`
  return {
    lines: [`Cookie: ${padding}`, `Cookie: ${sessionCookie}`],
    normalized: `${padding}; ${sessionCookie}`,
  }
}

async function sendRaw(f: RawFixture, cookieHeaders: readonly string[], edgeHeader?: string): Promise<RawResponse> {
  const request = [
    'POST /api/studio/identity/logout HTTP/1.1',
    `Host: ${f.host}`,
    `Origin: ${f.origin}`,
    'X-DZ23-CSRF: csrf-token',
    ...(edgeHeader === undefined ? [] : [`X-DZ23-Edge: ${edgeHeader}`]),
    ...cookieHeaders,
    'Connection: close',
    '',
    '',
  ].join('\r\n')
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = createConnection({ host: '127.0.0.1', port: f.port }, () => socket.end(request))
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw HTTP response timed out')))
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)))
    socket.once('error', reject)
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
  return parseRawResponse(raw)
}

function parseRawResponse(raw: string): RawResponse {
  const boundary = raw.indexOf('\r\n\r\n')
  if (boundary < 0) throw new Error('raw HTTP response has no header boundary')
  const headerBlock = raw.slice(0, boundary)
  const bodyWire = raw.slice(boundary + 4)
  const lines = headerBlock.split('\r\n')
  const match = /^HTTP\/1\.1 (\d{3})\b/u.exec(lines.shift() ?? '')
  if (match?.[1] === undefined) throw new Error('raw HTTP response has no status')
  const headers = new Map<string, string[]>()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error('raw HTTP response has malformed headers')
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    headers.set(name, [...(headers.get(name) ?? []), value])
  }
  const body = headers.get('transfer-encoding')?.some(value => value.toLowerCase() === 'chunked') === true
    ? decodeChunkedBody(bodyWire)
    : bodyWire
  return { status: Number(match[1]), headers, body }
}

function decodeChunkedBody(wire: string): string {
  let cursor = 0
  let decoded = ''
  while (true) {
    const lineEnd = wire.indexOf('\r\n', cursor)
    if (lineEnd < 0) throw new Error('chunked response is truncated before size')
    const size = Number.parseInt(wire.slice(cursor, lineEnd), 16)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('chunked response has invalid size')
    cursor = lineEnd + 2
    if (size === 0) return decoded
    decoded += wire.slice(cursor, cursor + size)
    cursor += size
    if (wire.slice(cursor, cursor + 2) !== '\r\n') throw new Error('chunked response is truncated after data')
    cursor += 2
  }
}

describe('identity raw Cookie transport boundary', () => {
  it('accepts exactly 8192 normalized Cookie bytes and completes authenticated logout', async () => {
    const f = await fixture()
    const cookies = cookieLines(8_149)
    expect(Buffer.byteLength(cookies.normalized, 'utf8')).toBe(COOKIE_HEADER_LIMIT_BYTES)

    const response = await sendRaw(f, cookies.lines)

    expect(f.observedCookies).toEqual([cookies.normalized])
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"signed_out":true}')
    expect(f.service.authenticate).toHaveBeenCalledWith('session-token')
    expect(f.service.validateCsrfToken).toHaveBeenCalledWith(session, 'csrf-token')
    expect(f.service.revokeSession).toHaveBeenCalledWith(session, session.session_id)
  })

  it('rejects 8193 normalized Cookie bytes before edge trust or service access', async () => {
    const f = await fixture(true)
    const cookies = cookieLines(8_150)
    expect(Buffer.byteLength(cookies.normalized, 'utf8')).toBe(COOKIE_HEADER_LIMIT_BYTES + 1)

    const response = await sendRaw(f, cookies.lines, 'wrong-edge-secret')

    expect(f.observedCookies).toEqual([cookies.normalized])
    expect(response.status).toBe(431)
    expect(response.body).toBe('{"error":"COOKIE_HEADER_TOO_LARGE"}')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(f.resolveEdgeSecret).not.toHaveBeenCalled()
    expect(f.service.authenticate).not.toHaveBeenCalled()
    expect(f.service.validateCsrfToken).not.toHaveBeenCalled()
    expect(f.service.revokeSession).not.toHaveBeenCalled()
  })
})
