import { execFile } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, TLSSocket } from 'node:tls'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { postgresClientConnection, postgresToolConnection, withoutTlsParams } from '../src/dsn.ts'

const run = promisify(execFile)

/**
 * What a PostgreSQL server sees when a client arrives: either the 8-byte
 * SSLRequest packet, or a plaintext StartupMessage. That single byte of
 * protocol is the whole question this file asks — "did the connection actually
 * encrypt?" — and it is asked of a server of our own, so the answer does not
 * depend on how the machine's PostgreSQL happens to be configured.
 */
const SSL_REQUEST_CODE = 80877103

interface Observation { ssl: boolean; handshake: 'completed' | 'failed' | 'none' }

interface FakeServer { port: number; observations: Observation[]; close(): Promise<void> }

function startFakeServer(cert: string, key: string): Promise<FakeServer> {
  const observations: Observation[] = []
  const context = createSecureContext({ cert, key })
  const server: Server = createServer((socket: Socket) => {
    socket.once('data', (first: Buffer) => {
      const isSslRequest = first.length >= 8 && first.readInt32BE(0) === 8 && first.readInt32BE(4) === SSL_REQUEST_CODE
      if (!isSslRequest) {
        observations.push({ ssl: false, handshake: 'none' })
        socket.destroy()
        return
      }
      socket.write(Buffer.from('S'))
      let settled = false
      const settle = (handshake: 'completed' | 'failed'): void => {
        if (settled) return
        settled = true
        observations.push({ ssl: true, handshake })
      }
      const secure = new TLSSocket(socket, { isServer: true, secureContext: context })
      secure.once('secure', () => { settle('completed'); secure.destroy() })
      secure.once('error', () => { settle('failed'); socket.destroy() })
      // A client that refuses the certificate simply hangs up: the raw socket closing
      // before the handshake completed is a REFUSAL, and must be recorded as one.
      socket.once('close', () => settle('failed'))
    })
    socket.once('error', () => undefined)
  })
  return new Promise(resolvePromise => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolvePromise({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        observations,
        close: () => new Promise<void>(done => { server.close(() => done()) }),
      })
    })
  })
}

let directory: string
let validCa: string
let wrongCa: string
let server: FakeServer

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dz23-tls-'))
  const selfSigned = async (name: string, subject: string): Promise<{ cert: string; key: string }> => {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.crt`),
      '-subj', subject, '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'])
    return { cert: await readFile(join(directory, `${name}.crt`), 'utf8'), key: await readFile(join(directory, `${name}.key`), 'utf8') }
  }
  const serverPair = await selfSigned('server', '/CN=localhost')
  await selfSigned('other', '/CN=impostor')
  validCa = join(directory, 'server.crt')
  wrongCa = join(directory, 'other.crt')
  server = await startFakeServer(serverPair.cert, serverPair.key)
}, 60_000)

afterAll(async () => {
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

/** Connects and reports only what matters here: did TLS happen, and did verification pass. */
async function attempt(dsn: string, policy: 'off' | 'require' | 'verify-full'): Promise<{ error: string }> {
  const before = server.observations.length
  const client = new Client(await postgresClientConnection(dsn, policy))
  let error = ''
  try {
    await client.connect()
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  }
  await client.end().catch(() => undefined)
  // The fake server never completes a startup, so every attempt ends in an error:
  // the question is WHICH error, and what the server saw before it.
  for (let wait = 0; wait < 100 && server.observations.length === before; wait += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  return { error }
}

function dsnFor(port: number, query = ''): string {
  return `postgresql://someone:s3cr3t@127.0.0.1:${String(port)}/dz23${query}`
}

describe('TLS policy is the single authority', () => {
  it('off means plaintext even when the DSN asks for verify-full with a valid CA', async () => {
    const before = server.observations.length
    await attempt(dsnFor(server.port, `?sslmode=verify-full&sslrootcert=${encodeURIComponent(validCa)}`), 'off')
    expect(server.observations.slice(before)).toEqual([{ ssl: false, handshake: 'none' }])
  })

  it('verify-full with a valid CA encrypts and verifies, even when the DSN says sslmode=disable', async () => {
    const before = server.observations.length
    const { error } = await attempt(dsnFor(server.port, `?sslmode=disable&sslrootcert=${encodeURIComponent(validCa)}`), 'verify-full')
    expect(server.observations.slice(before)).toEqual([{ ssl: true, handshake: 'completed' }])
    // The handshake succeeded: whatever went wrong afterwards is not a certificate problem.
    expect(error).not.toMatch(/certificate/iu)
  })

  it('verify-full with the wrong CA refuses the server instead of trusting it', async () => {
    const before = server.observations.length
    const { error } = await attempt(dsnFor(server.port, `?sslrootcert=${encodeURIComponent(wrongCa)}`), 'verify-full')
    expect(error).toMatch(/certificate/iu)
    expect(server.observations.slice(before)).toEqual([{ ssl: true, handshake: 'failed' }])
  })

  it('require encrypts but does NOT verify, which is exactly why it is not the default', async () => {
    const before = server.observations.length
    const { error } = await attempt(dsnFor(server.port, `?sslrootcert=${encodeURIComponent(wrongCa)}`), 'require')
    expect(server.observations.slice(before)).toEqual([{ ssl: true, handshake: 'completed' }])
    expect(error).not.toMatch(/certificate/iu)
  })

  it('strips every TLS parameter from the string handed to pg, and loads the material itself', async () => {
    const resolved = await postgresClientConnection(dsnFor(server.port, `?application_name=keep&sslmode=disable&sslrootcert=${encodeURIComponent(validCa)}`), 'verify-full')
    expect(resolved.connectionString).toContain('application_name=keep')
    expect(resolved.connectionString).not.toMatch(/ssl/iu)
    expect(resolved.ssl).toMatchObject({ rejectUnauthorized: true })
    expect((resolved.ssl as { ca: string }).ca).toContain('BEGIN CERTIFICATE')
    expect(withoutTlsParams(dsnFor(server.port, '?sslmode=disable'))).not.toMatch(/sslmode/u)
  })

  it('keeps the password and the TLS policy out of the client tools argv', () => {
    const tool = postgresToolConnection(dsnFor(server.port, `?sslmode=disable&sslrootcert=${encodeURIComponent(validCa)}`), 'verify-full', { PGPASSWORD: 'stale' })
    expect(tool.dsn).not.toContain('s3cr3t')
    expect(tool.dsn).not.toMatch(/ssl/iu)
    expect(tool.env.PGPASSWORD).toBe('s3cr3t')
    expect(tool.env.PGSSLMODE).toBe('verify-full')
    expect(tool.env.PGSSLROOTCERT).toBe(validCa)
    expect(postgresToolConnection(`postgresql://someone@127.0.0.1/dz23`, 'off').env.PGSSLMODE).toBe('disable')
  })

  // This assertion used to read the other way round: a DSN without a password DELETED the
  // operator's PGPASSWORD. A DSN with no password next to a PGPASSWORD in the environment is a
  // normal, documented libpq setup — node-pg connected, everything validated, and only the
  // mandatory pg_dump failed, with pg_dump's own message, which never says this tool removed the
  // variable. The function sets what it provides; it does not unset what the operator exported.
  it('never removes a password the operator exported, and never invents one', () => {
    const inherited = postgresToolConnection('postgresql://someone@127.0.0.1/dz23', 'off', { PGPASSWORD: 'do-nao-cofre', PGPASSFILE: '/home/op/.pgpass' })
    expect(inherited.env.PGPASSWORD).toBe('do-nao-cofre')
    expect(inherited.env.PGPASSFILE).toBe('/home/op/.pgpass')
    // Nothing invented either: with no password anywhere, libpq is left to find its own (.pgpass).
    expect(Object.keys(postgresToolConnection('postgresql://someone@127.0.0.1/dz23', 'off').env)).not.toContain('PGPASSWORD')
    // A password in the DSN still wins over a stale one in the environment.
    expect(postgresToolConnection('postgresql://someone:nova@127.0.0.1/dz23', 'off', { PGPASSWORD: 'velha' }).env.PGPASSWORD).toBe('nova')
  })

  it('forwards every hardening parameter libpq understands instead of dropping it in silence', () => {
    const query = [
      'channel_binding=require', 'ssl_min_protocol_version=TLSv1.3', 'ssl_max_protocol_version=TLSv1.3',
      'sslnegotiation=direct', 'sslsni=1', 'sslcertmode=require', 'sslcompression=0',
    ].join('&')
    const tool = postgresToolConnection(`postgresql://someone:s3cr3t@127.0.0.1/dz23?${query}`, 'verify-full')
    expect(tool.dsn).not.toMatch(/channel_binding|ssl/iu)
    expect(tool.env).toMatchObject({
      PGCHANNELBINDING: 'require', PGSSLMINPROTOCOLVERSION: 'TLSv1.3', PGSSLMAXPROTOCOLVERSION: 'TLSv1.3',
      PGSSLNEGOTIATION: 'direct', PGSSLSNI: '1', PGSSLCERTMODE: 'require', PGSSLCOMPRESSION: '0',
    })
  })

  it('refuses a stripped parameter it cannot pass on, instead of connecting with less than was asked', () => {
    // `uselibpqcompat` is stripped from the URI and has no libpq environment variable: forwarding is
    // impossible, so the only honest answers are "refuse" or "weaken silently".
    expect(() => postgresToolConnection('postgresql://someone:s3cr3t@127.0.0.1/dz23?uselibpqcompat=1', 'verify-full'))
      .toThrow(/uselibpqcompat/u)
  })

  it('refuses a DSN whose TLS policy cannot be enforced', async () => {
    await expect(postgresClientConnection('host=127.0.0.1 sslmode=disable', 'verify-full')).rejects.toThrow('postgresql:// URI')
  })
})
