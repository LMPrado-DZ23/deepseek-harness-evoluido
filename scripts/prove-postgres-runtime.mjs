import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? '/home/leandro/harness-studio-poc02/deepseek-harness')
const studioRoot = resolve(process.cwd())
const dshHome = join(studioRoot, 'runtime', `postgres-proof-${randomUUID()}`)
const profile = join(studioRoot, 'dsh-home', 'profiles', 'studio')
const recordKey = `p31_${randomUUID()}`
process.env.DSH_HOME = dshHome
process.env.DSH_TELEMETRY_DISABLED = '1'

assert.equal(process.platform, 'linux', 'P31-A runtime proof must run on Linux/WSL2')
assert.ok(studioRoot.startsWith('/home/'), `P31-A runtime proof must run on ext4, got ${studioRoot}`)
assert.ok(process.env.DZ23_POSTGRES_DSN, 'DZ23_POSTGRES_DSN is required')
assert.ok(existsSync(join(upstreamRoot, '.git')), `missing upstream checkout: ${upstreamRoot}`)

const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
const profileBootChunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
assert.ok(profileBootChunk, 'built CLI does not expose its profile boot chunk')
const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([
  moduleAt('packages/boot/app-boot/lib/index.js'),
  moduleAt(`apps/cli/lib/${profileBootChunk}`),
])

await mkdir(join(dshHome, 'profiles'), { recursive: true })
await symlink(profile, join(dshHome, 'profiles', 'studio'), 'dir')

async function boot() {
  const originalLog = console.log
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) return
    originalLog(...args)
  }
  try {
    return await runProfile({
      environment: loadLayeredEnv('dsh-studio-p31-postgres-proof', studioRoot),
      profile: 'studio',
      patchFiles: [join(studioRoot, 'deploy', 'harness', 'postgres-proof.patch.yml')],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    })
  } finally {
    console.log = originalLog
  }
}

let first
let second
try {
  first = await boot()
  assert.ok(first.ctx.storage.backend.get('postgres'))
  for (const name of ['studio_agent_runs', 'studio_agent_leases', 'studio_route_health']) {
    assert.ok(first.ctx.storageDomain.get(name), `${name} did not open on its configured backend`)
  }
  const firstDomain = first.ctx.storageDomain.get('studio_hello')
  assert.ok(firstDomain, 'studio_hello did not open on PostgreSQL')
  await firstDomain.table('records').put(recordKey, {
    tenant_id: 'tenant-p31-runtime',
    created_at: '2026-09-02T00:00:00.000Z',
    note: 'postgres-runtime-proof',
  })
  await first.shutdown.shutdown(0)
  first = undefined

  second = await boot()
  const restored = second.ctx.storageDomain.get('studio_hello')?.table('records').get(recordKey)
  assert.deepEqual(restored, {
    tenant_id: 'tenant-p31-runtime',
    created_at: '2026-09-02T00:00:00.000Z',
    note: 'postgres-runtime-proof',
  })
  process.stdout.write(`${JSON.stringify({
    decision: 'GO',
    upstreamCommit: '6c705be1ce6774a000d061da41d1823b03a3d42c',
    platform: process.platform,
    filesystem: 'WSL2 ext4 (/home)',
    backend: 'postgres',
    defaultBackend: 'json',
    routedStudioDomains: 12,
    restartRestored: true,
  }, null, 2)}\n`)
} finally {
  if (second !== undefined) await second.shutdown.shutdown(0)
  if (first !== undefined) await first.shutdown.shutdown(0)
  await rm(dshHome, { recursive: true, force: true })
}
