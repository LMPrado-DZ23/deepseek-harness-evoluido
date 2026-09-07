import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const studioRoot = resolve(process.cwd())
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT
  ?? join(studioRoot, 'third_party', 'deepseek-harness'))
const profileHome = join(studioRoot, 'dsh-home')
const runId = randomUUID()
const dshHome = join(studioRoot, 'runtime', `edge-proof-${runId}`)
const containerName = `dz23-edge-proof-${runId}`
const edgeSecret = randomBytes(32).toString('base64url')
const caddyImage = process.env.DZ23_CADDY_IMAGE ?? 'dz23-studio-caddy:p29c'

process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.DZ23_EDGE_SECRET = edgeSecret

assert.equal(process.platform, 'linux', 'P29-C edge proof must run inside Linux/WSL2')
assert.ok(studioRoot.startsWith('/home/'), `P29-C edge proof must run on ext4, got ${studioRoot}`)
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing upstream checkout: ${upstreamRoot}`)
assert.ok(
  existsSync(join(profileHome, 'profiles', 'studio', 'node_modules', '@dz23-studio', 'identity')),
  'Studio profile dependencies are missing; run pnpm --dir dsh-home/profiles/studio install --frozen-lockfile',
)
execFileSync('docker', ['image', 'inspect', caddyImage], { stdio: 'ignore' })

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
assert.ok(profileBootChunk, 'built CLI does not expose its profile boot chunk')
const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  moduleAt(`apps/cli/lib/${profileBootChunk}`),
])

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise(resolveClose => server.close(resolveClose))
  return address.port
}

async function bootStudio(edgePort) {
  await mkdir(join(dshHome, 'profiles'), { recursive: true })
  await symlink(join(profileHome, 'profiles', 'studio'), join(dshHome, 'profiles', 'studio'), 'dir')
  const authority = `127.0.0.1:${edgePort}`
  const origin = `http://${authority}`
  const edgePatch = join(dshHome, 'edge.patch.json')
  await writeFile(edgePatch, JSON.stringify([
    { id: 'connection', config: { trustedHosts: [authority] } },
    {
      id: 'dz23-studio-identity',
      config: {
        rpId: 'localhost',
        expectedOrigin: origin,
        enrollment: { mode: 'bootstrap-email', email: 'edge-proof@example.com' },
        allowedHosts: [authority],
        allowedOrigins: [origin],
        edge: { required: true, secretRef: 'DZ23_EDGE_SECRET' },
        email: { kind: 'memory' },
      },
    },
  ]))
  const originalLog = console.log
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) return
    originalLog(...args)
  }
  try {
    return await runProfile({
      environment: loadLayeredEnv('dsh-studio-p29c-edge-proof', studioRoot),
      profile: 'studio',
      patchFiles: [edgePatch],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  } finally {
    console.log = originalLog
  }
}

function startCaddy(edgePort, harnessPort, rateTest = false) {
  const args = [
    'run', '--rm', '--name', containerName, '--network', 'host', '--read-only',
    '--tmpfs', '/data', '--tmpfs', '/config', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', 'DZ23_EDGE_SECRET',
    '-e', `DZ23_EDGE_PORT=${edgePort}`,
    '-e', `DZ23_HARNESS_UPSTREAM=127.0.0.1:${harnessPort}`,
  ]
  if (rateTest) {
    args.push('-e', 'DZ23_GLOBAL_RATE_EVENTS=2', '-e', 'DZ23_GLOBAL_RATE_WINDOW=1s')
  }
  args.push(caddyImage, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile.test', '--adapter', 'caddyfile')
  const child = spawn('docker', args, { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  return { child, errors: () => errors }
}

async function waitUntilReady(origin, caddy) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (caddy.child.exitCode !== null) throw new Error(`Caddy stopped before readiness: ${caddy.errors()}`)
    try {
      if ((await fetch(`${origin}/healthz`)).status === 200) return
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Caddy readiness timed out: ${caddy.errors()}`)
}

async function stopCaddy(caddy) {
  if (caddy.child.exitCode === null) {
    try { execFileSync('docker', ['stop', '--time', '2', containerName], { stdio: 'ignore' }) } catch {}
  }
  await new Promise(resolveExit => {
    if (caddy.child.exitCode !== null) resolveExit()
    else caddy.child.once('exit', resolveExit)
  })
}

function cookieHeader(response) {
  return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
}

function mergeCookies(...headers) {
  return headers.flatMap(value => value.split('; ')).join('; ')
}

async function websocketStatus(url, cookies, origin) {
  const wsPackage = readdirSync(join(upstreamRoot, 'node_modules', '.pnpm'))
    .find(name => name.startsWith('ws@8.21.0'))
  assert.ok(wsPackage, 'pinned ws package missing')
  const { default: WebSocket } = await import(pathToFileURL(join(
    upstreamRoot, 'node_modules', '.pnpm', wsPackage, 'node_modules', 'ws', 'wrapper.mjs',
  )).href)
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url, { headers: { ...(cookies === '' ? {} : { cookie: cookies }), origin } })
    socket.once('open', () => { socket.close(); resolveSocket(101) })
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      resolveSocket(status)
    })
    socket.once('error', error => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error)
    })
  })
}

let booted
let caddy
let fetchRouteDispose
let rpcDispose
const edgePort = await freePort()
const edgeOrigin = `http://127.0.0.1:${edgePort}`

try {
  booted = await bootStudio(edgePort)
  const harnessPort = booted.ctx.webServer.port
  fetchRouteDispose = booted.ctx.connection.fetch.register({
    path: '/api/edge-proof',
    methods: ['GET'],
    fetch: () => Promise.resolve(Response.json({ ok: true, carrier: 'connection.fetch' })),
  })
  rpcDispose = booted.ctx.connection.rpc.handle('/edge-proof', (endpoint, payload) => Promise.resolve({
    ok: true,
    value: { endpoint, payload, carrier: 'connection.rpc' },
  }))

  caddy = startCaddy(edgePort, harnessPort)
  await waitUntilReady(edgeOrigin, caddy)

  const builtIndex = readFileSync(join(upstreamRoot, 'apps', 'web', 'dist', 'index.html'), 'utf8')
  const asset = builtIndex.match(/(?:src|href)="\.\/(assets\/[^\"]+)"/)?.[1]
  assert.ok(asset, 'real Harness index did not declare a built asset')
  assert.doesNotMatch(builtIndex, /<script(?![^>]*\bsrc=)[^>]*>/i, 'CSP proof found an inline script')
  assert.doesNotMatch(builtIndex, /<style\b/i, 'CSP proof found an inline style')

  const unauthenticatedPaths = ['/', `/${asset}`, '/api/edge-proof']
  for (const path of unauthenticatedPaths) {
    assert.equal((await fetch(`${edgeOrigin}${path}`)).status, 401, `${path} was not protected`)
  }
  assert.equal((await fetch(`${edgeOrigin}/edge-proof/ping`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: edgeOrigin },
    body: JSON.stringify({ type: 'client-request', rpcId: 'unauthenticated', method: 'ping', payload: {} }),
  })).status, 401)
  assert.equal(await websocketStatus(`ws://127.0.0.1:${edgePort}/api/remote.mux`, '', edgeOrigin), 401)

  const direct = await fetch(`http://127.0.0.1:${harnessPort}/api/studio/identity/session`, {
    headers: { host: `127.0.0.1:${edgePort}` },
  })
  assert.equal(direct.status, 401, 'application edge fence did not block direct access')
  const foreignExit = (() => {
    try {
      execFileSync('docker', [
        'run', '--rm', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', caddyImage,
        'wget', '-q', '-T', '2', '-O', '-', `http://host.docker.internal:${harnessPort}/`,
      ], { stdio: 'ignore' })
      return 0
    } catch (error) {
      return error.status ?? 1
    }
  })()
  assert.notEqual(foreignExit, 0, 'foreign container reached the loopback-only Harness port')

  const competitorStart = await fetch(`${edgeOrigin}/api/studio/identity/magic/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: edgeOrigin },
    body: JSON.stringify({ email: 'competitor@example.com' }),
  })
  assert.equal(competitorStart.status, 202)
  assert.equal(booted.ctx.studioIdentity.developmentEmailCapture?.messages.length, 0)
  assert.equal(booted.ctx.studioIdentity.service.userRecords().length, 0)

  const start = await fetch(`${edgeOrigin}/api/studio/identity/magic/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: edgeOrigin },
    body: JSON.stringify({ email: 'edge-proof@example.com' }),
  })
  assert.equal(start.status, 202)
  const code = booted.ctx.studioIdentity.developmentEmailCapture?.messages.at(-1)?.code
  assert.ok(code, 'development-only proof code was not captured')
  assert.equal(booted.ctx.studioIdentity.developmentEmailCapture?.messages.at(-1)?.to, 'edge-proof@example.com')
  const verified = await fetch(`${edgeOrigin}/api/studio/identity/magic/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: edgeOrigin },
    body: JSON.stringify({ email: 'edge-proof@example.com', code, device_label: 'P29-C proof' }),
  })
  assert.equal(verified.status, 200)
  assert.deepEqual(
    booted.ctx.studioIdentity.service.userRecords().map(user => ({ email: user.email, owner: user.bootstrap_owner })),
    [{ email: 'edge-proof@example.com', owner: true }],
  )
  const studioCookies = cookieHeader(verified)

  const exchange = await fetch(`${edgeOrigin}/api/studio/identity/harness/session`, {
    redirect: 'manual', headers: { cookie: studioCookies },
  })
  assert.equal(exchange.status, 303)
  const launchLocation = exchange.headers.get('location')
  assert.ok(launchLocation?.startsWith(`${edgeOrigin}/?token=`))
  const nativeExchange = await fetch(launchLocation, { redirect: 'manual', headers: { cookie: studioCookies } })
  assert.equal(nativeExchange.status, 303)
  const allCookies = mergeCookies(studioCookies, cookieHeader(nativeExchange))
  const authenticatedHeaders = { cookie: allCookies, origin: edgeOrigin }

  const root = await fetch(`${edgeOrigin}/`, { headers: authenticatedHeaders })
  assert.equal(root.status, 200)
  assert.match(await root.text(), /<div id="root"><\/div>/)
  assert.equal(root.headers.get('content-security-policy')?.includes("'unsafe-eval'"), false)
  assert.equal(root.headers.get('x-frame-options'), 'DENY')
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(root.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  assert.equal(root.headers.get('strict-transport-security'), null, 'test/local HTTP must not emit HSTS')
  assert.equal(root.headers.get('server'), null)
  assert.equal((await fetch(`${edgeOrigin}/${asset}`, { headers: authenticatedHeaders })).status, 200)
  const api = await fetch(`${edgeOrigin}/api/edge-proof`, { headers: authenticatedHeaders })
  assert.equal(api.status, 200)
  assert.deepEqual(await api.json(), { ok: true, carrier: 'connection.fetch' })
  const rpc = await fetch(`${edgeOrigin}/edge-proof/ping`, {
    method: 'POST', headers: { ...authenticatedHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'edge-rpc', method: 'ping', payload: { proof: true } }),
  })
  assert.equal(rpc.status, 200)
  assert.deepEqual(await rpc.json(), {
    type: 'server-response', rpcId: 'edge-rpc',
    result: { ok: true, value: { endpoint: 'ping', payload: { proof: true }, carrier: 'connection.rpc' } },
  })
  assert.equal(await websocketStatus(`ws://127.0.0.1:${edgePort}/api/remote.mux`, allCookies, edgeOrigin), 101)

  const sessionToken = decodeURIComponent(studioCookies.match(/(?:^|;\s*)dz23_studio_session=([^;]+)/)?.[1] ?? '')
  const identitySession = await booted.ctx.studioIdentity.service.authenticate(sessionToken, false)
  await booted.ctx.studioIdentity.service.revokeSession(identitySession, identitySession.session_id)
  assert.equal((await fetch(`${edgeOrigin}/`, { headers: authenticatedHeaders })).status, 401)
  const staleLogout = await fetch(`${edgeOrigin}/api/studio/identity/logout`, {
    method: 'POST', headers: authenticatedHeaders,
  })
  assert.equal(staleLogout.status, 200)
  assert.deepEqual(await staleLogout.json(), { signed_out: true })
  assert.match(staleLogout.headers.getSetCookie().join(';'), /Max-Age=0/u)

  await stopCaddy(caddy)
  caddy = startCaddy(edgePort, harnessPort, true)
  await waitUntilReady(edgeOrigin, caddy)
  assert.equal((await fetch(`${edgeOrigin}/healthz`)).status, 200)
  assert.equal((await fetch(`${edgeOrigin}/healthz`)).status, 429)
  await new Promise(resolveWait => setTimeout(resolveWait, 1_100))
  assert.equal((await fetch(`${edgeOrigin}/healthz`)).status, 200)

  const inspect = JSON.parse(execFileSync('docker', ['inspect', containerName], { encoding: 'utf8' }))[0]
  assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL'])
  assert.equal(inspect.HostConfig.Privileged, false)
  assert.equal(inspect.HostConfig.NetworkMode, 'host')

  process.stdout.write(`${JSON.stringify({
    decision: 'GO',
    caddyImage,
    caddyVersion: '2.11.4',
    rateLimitModuleCommit: '5625512f24f6f59d6f64fb3aafe5eecff0b286db',
    upstreamCommit: readFileSync(join(studioRoot, 'UPSTREAM.lock'), 'utf8').match(/^commit=(.+)$/m)?.[1],
    platform: process.platform,
    filesystem: 'WSL2 ext4 (/home)',
    routes: {
      root: { unauthenticated: 401, authenticated: 200 },
      asset: { path: `/${asset}`, unauthenticated: 401, authenticated: 200 },
      clientConnection: { path: '/api/edge-proof', unauthenticated: 401, authenticated: 200 },
      rpc: { path: '/edge-proof/ping', unauthenticated: 401, authenticated: 200 },
      websocket: { path: '/api/remote.mux', unauthenticated: 401, authenticated: 101 },
    },
    nativeSessionBridge: true,
    bootstrapOwnerRace: 'configured-email-only',
    revocationNextRequest: 401,
    staleCookieLogout: 200,
    directInternalFromForeignContainer: 'connection-refused',
    directInternalFromHost: '401-edge-required',
    edgeRateLimit: { limited: 429, releasedAfterWindow: 200 },
    securityHeaders: 'PASS',
    cspStaticCompatibility: 'PASS-no-inline-script-or-style',
    hstsInHttpTestMode: 'ABSENT_AS_REQUIRED',
    container: { privileged: false, capDrop: ['ALL'], networkAdmin: false },
  }, null, 2)}\n`)
} finally {
  if (caddy !== undefined) await stopCaddy(caddy)
  await rpcDispose?.()
  await fetchRouteDispose?.()
  if (booted !== undefined) await booted.shutdown.shutdown(0)
  await rm(dshHome, { recursive: true, force: true })
}
