/**
 * Single authority for how this product talks TLS to PostgreSQL, and the only
 * place that decides what may appear on a command line.
 *
 * A DSN is operator input: it can carry `sslmode`, `sslrootcert`, `sslcert`,
 * `sslkey` and friends. `pg` merges the parsed connection string OVER the
 * explicit `ssl` option (`Object.assign({}, config, parse(connectionString))`
 * in `pg/lib/connection-parameters.js`), so a DSN saying `sslmode=disable`
 * used to silently defeat an `--ssl verify-full` run. The rule here is the
 * opposite: the configured policy is the only thing that decides whether the
 * connection is encrypted and verified; the DSN may only CONTRIBUTE material
 * (a CA, a client certificate), never the decision.
 *
 * The same policy is handed to `pg_dump`/`pg_restore` through their own
 * environment, and the password never reaches `argv` — a command line is
 * readable by every user on the machine (`ps`), a process environment is not.
 */
import { readFile } from 'node:fs/promises'

export type TlsPolicy = 'off' | 'require' | 'verify-full'

export const TLS_POLICIES: readonly TlsPolicy[] = ['off', 'require', 'verify-full']

export function assertTlsPolicy(value: string): TlsPolicy {
  if (!TLS_POLICIES.includes(value as TlsPolicy)) throw new Error(`--ssl must be off, require or verify-full`)
  return value as TlsPolicy
}

/**
 * Every libpq TLS parameter a URI may carry. All of them are removed from the
 * string handed to `pg` and to the client tools: whatever they were meant to
 * say is re-decided here, from the policy, and re-supplied deliberately.
 */
const TLS_URI_KEYS: readonly string[] = [
  'ssl', 'sslmode', 'sslnegotiation', 'sslcompression', 'sslcert', 'sslkey', 'sslpassword',
  'sslrootcert', 'sslcrl', 'sslcrldir', 'sslsni', 'sslcertmode', 'requiressl', 'channel_binding',
  'ssl_min_protocol_version', 'ssl_max_protocol_version', 'uselibpqcompat',
]

export interface PostgresTlsOptions {
  rejectUnauthorized: boolean
  ca?: string
  cert?: string
  key?: string
  passphrase?: string
}

export interface PostgresClientConnection {
  /** DSN with every TLS parameter removed, so nothing in it can override the policy. */
  connectionString: string
  /** The single TLS decision, already resolved. */
  ssl: false | PostgresTlsOptions
}

function parseDsn(dsn: string): URL {
  try {
    return new URL(dsn)
  } catch {
    throw new Error('the PostgreSQL DSN is not a postgresql:// URI; this build needs the URI form so the TLS policy can be enforced')
  }
}

function stripTlsParams(url: URL): Map<string, string> {
  const carried = new Map<string, string>()
  for (const key of [...url.searchParams.keys()]) {
    if (!TLS_URI_KEYS.includes(key.toLowerCase())) continue
    const value = url.searchParams.get(key)
    if (value !== null) carried.set(key.toLowerCase(), value)
    url.searchParams.delete(key)
  }
  return carried
}

/**
 * Connection settings for `pg`. The returned `connectionString` carries no TLS
 * parameter at all, so `ssl` here is the whole truth: `false` means plaintext,
 * `rejectUnauthorized: true` means the chain AND the host name are verified.
 * A CA or client certificate named in the DSN is still honoured — it is
 * material, not policy — and is read into the options instead of being left
 * for the connection string to reinterpret.
 */
export async function postgresClientConnection(dsn: string, policy: TlsPolicy): Promise<PostgresClientConnection> {
  const url = parseDsn(dsn)
  const carried = stripTlsParams(url)
  if (policy === 'off') return { connectionString: url.href, ssl: false }
  const ssl: PostgresTlsOptions = { rejectUnauthorized: policy === 'verify-full' }
  const rootCert = carried.get('sslrootcert')
  const clientCert = carried.get('sslcert')
  const clientKey = carried.get('sslkey')
  const keyPassword = carried.get('sslpassword')
  if (rootCert !== undefined && rootCert !== '') ssl.ca = await readFile(rootCert, 'utf8')
  if (clientCert !== undefined && clientCert !== '') ssl.cert = await readFile(clientCert, 'utf8')
  if (clientKey !== undefined && clientKey !== '') ssl.key = await readFile(clientKey, 'utf8')
  if (keyPassword !== undefined && keyPassword !== '') ssl.passphrase = keyPassword
  return { connectionString: url.href, ssl }
}

/**
 * The DSN with every TLS parameter removed, for callers that already hold a
 * resolved `ssl` option object. Without this, `pg` lets the string override the
 * object and the caller's decision is not the one that reaches the socket.
 */
export function withoutTlsParams(dsn: string): string {
  const url = parseDsn(dsn)
  stripTlsParams(url)
  return url.href
}

export interface PostgresToolConnection {
  /** Safe to put in `argv`: no password, no TLS parameter. */
  dsn: string
  /** Everything secret or policy-bearing, for the child's environment only. */
  env: NodeJS.ProcessEnv
}

/**
 * The same policy, for `pg_dump`/`pg_restore`. The URI that reaches `argv` has
 * the password AND every TLS parameter stripped; the password travels in
 * `PGPASSWORD` and the policy in `PGSSLMODE`, which the stripped URI can no
 * longer contradict.
 */
export function postgresToolConnection(dsn: string, policy: TlsPolicy, base: NodeJS.ProcessEnv = {}): PostgresToolConnection {
  const url = parseDsn(dsn)
  const carried = stripTlsParams(url)
  const password = url.password
  url.password = ''
  const env: NodeJS.ProcessEnv = {
    ...base,
    PGSSLMODE: policy === 'off' ? 'disable' : policy === 'require' ? 'require' : 'verify-full',
    PGCONNECT_TIMEOUT: base.PGCONNECT_TIMEOUT ?? '15',
  }
  // A password on the command line is readable by every user on the box; in the
  // environment it is not. libpq reads it from here.
  if (password !== '') env.PGPASSWORD = decodeURIComponent(password)
  else delete env.PGPASSWORD
  const forward: Record<string, string> = {
    sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', sslpassword: 'PGSSLPASSWORD',
    sslcrl: 'PGSSLCRL', sslcrldir: 'PGSSLCRLDIR',
  }
  for (const [key, variable] of Object.entries(forward)) {
    const value = policy === 'off' ? undefined : carried.get(key)
    if (value === undefined || value === '') delete env[variable]
    else env[variable] = value
  }
  return { dsn: url.href, env }
}
