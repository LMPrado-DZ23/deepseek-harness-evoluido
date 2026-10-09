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

/**
 * Where each stripped key goes when the client tools are given the same connection. Everything
 * libpq understands is FORWARDED: `channel_binding`, the two protocol-version floors, `sslsni`,
 * `sslnegotiation`, `sslcertmode` and `sslcompression` used to be stripped from the URI and then
 * simply dropped, so `pg_dump` connected with LESS assurance than the operator had configured —
 * silently, which is the worst way to weaken somebody's TLS.
 */
const TOOL_ENV_BY_KEY: Readonly<Record<string, string>> = {
  sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', sslpassword: 'PGSSLPASSWORD',
  sslcrl: 'PGSSLCRL', sslcrldir: 'PGSSLCRLDIR', channel_binding: 'PGCHANNELBINDING',
  ssl_min_protocol_version: 'PGSSLMINPROTOCOLVERSION', ssl_max_protocol_version: 'PGSSLMAXPROTOCOLVERSION',
  sslnegotiation: 'PGSSLNEGOTIATION', sslsni: 'PGSSLSNI', sslcertmode: 'PGSSLCERTMODE',
  sslcompression: 'PGSSLCOMPRESSION',
}

/**
 * The keys that have no destination BECAUSE the policy replaces them: they are three spellings of
 * "encrypt or do not", and that single decision is re-supplied as `PGSSLMODE` from `--ssl`. This is
 * the module's whole purpose, it is documented at the top, and it is the only silent override here.
 */
const POLICY_OWNED_KEYS: ReadonlySet<string> = new Set(['ssl', 'sslmode', 'requiressl'])

/**
 * A stripped key with nowhere to go is a refusal, not a shrug. Dropping it would mean the client
 * tools connect under settings the operator did not choose and was never told about; refusing names
 * the key and leaves the decision with the person who wrote the DSN.
 */
function assertEveryCarriedKeyHasADestination(carried: ReadonlyMap<string, string>): void {
  const orphans = [...carried.keys()].filter(key => !POLICY_OWNED_KEYS.has(key) && TOOL_ENV_BY_KEY[key] === undefined)
  if (orphans.length > 0) {
    throw new Error(`the PostgreSQL DSN carries ${orphans.join(', ')}, which this build cannot pass on to pg_dump/pg_restore; remove it from the DSN instead of letting the client tools connect without it`)
  }
}

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
/**
 * Decompõe o alvo em variáveis padrão do libpq. Nada disso entra em `argv`:
 * host, porta, usuário e banco ficam só no ambiente do processo filho.
 */
function applyTargetEnvironment(env: NodeJS.ProcessEnv, url: URL): void {
  // Cada campo é DEFINIDO ou APAGADO. Nunca deixado como estava: uma variável
  // `PGHOST` ou `PGUSER` herdada do ambiente de quem opera contradiria o alvo
  // em silêncio, e a ferramenta iria para outro servidor achando que foi para
  // este. O alvo é o que a URI diz, e só ele.
  const fields: ReadonlyArray<readonly [string, string]> = [
    ['PGHOST', decodeURIComponent(url.hostname)],
    ['PGPORT', url.port],
    ['PGUSER', decodeURIComponent(url.username)],
    ['PGDATABASE', decodeURIComponent(url.pathname.replace(/^\//u, ''))],
  ]
  for (const [variable, value] of fields) {
    if (value === '') delete env[variable]
    else env[variable] = value
  }
}

export function postgresToolConnection(dsn: string, policy: TlsPolicy, base: NodeJS.ProcessEnv = {}): PostgresToolConnection {
  const url = parseDsn(dsn)
  const carried = stripTlsParams(url)
  const password = url.password
  url.password = ''
  assertEveryCarriedKeyHasADestination(carried)
  const env: NodeJS.ProcessEnv = {
    ...base,
    PGSSLMODE: policy === 'off' ? 'disable' : policy === 'require' ? 'require' : 'verify-full',
    PGCONNECT_TIMEOUT: base.PGCONNECT_TIMEOUT ?? '15',
  }
  // A password on the command line is readable by every user on the box; in the
  // environment it is not. libpq reads it from here.
  //
  // What this function does NOT do is remove one. A DSN with no password plus a `PGPASSWORD` the
  // operator exported (or a `~/.pgpass`) is a normal, documented libpq setup: `pg` connected fine
  // with it, everything validated, and only the mandatory `pg_dump` failed — with pg_dump's own
  // message, which never mentions that this tool had deleted the variable. This function sets what
  // it itself provides and leaves the operator's environment alone.
  if (password !== '') env.PGPASSWORD = decodeURIComponent(password)
  // O ALVO também vai pelo ambiente, decomposto. libpq só expande uma URI no
  // parâmetro `dbname` que recebe EXPLICITAMENTE; uma URI colocada em
  // `PGDATABASE` é tratada como nome de banco, e a ferramenta cai nos padrões
  // (socket local, usuário do sistema operacional). Numa máquina onde esse
  // padrão por acaso conecta, o backup de segurança sairia do banco ERRADO e o
  // restore destrutivo seguiria em frente confiando nele.
  applyTargetEnvironment(env, url)
  for (const [key, variable] of Object.entries(TOOL_ENV_BY_KEY)) {
    // Under `off` there is no TLS to configure, and the TLS material this function strips from the
    // URI must not survive in the environment as if the URI had kept it.
    const value = policy === 'off' ? undefined : carried.get(key)
    if (value === undefined || value === '') delete env[variable]
    else env[variable] = value
  }
  return { dsn: url.href, env }
}
