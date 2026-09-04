import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

/**
 * PostgreSQL gate. Two ways to obtain a real server:
 *   1. DZ23_POSTGRES_TEST_DSN already set → use that server directly (any
 *      PostgreSQL 16, local or remote; pg_dump/pg_restore from the local PATH).
 *   2. Otherwise → start the disposable Compose service and bridge the client
 *      tools through `docker exec`.
 * There is no third mode: without a server the gate reports NOT_EXECUTED and
 * exits non-zero, so a skipped integration never reads as a pass.
 */
const compose = ['compose', '-p', 'dz23-p31-test', '-f', 'deploy/postgres/docker-compose.test.yml']
const password = randomBytes(24).toString('hex')
const composeEnv = { ...process.env, DZ23_POSTGRES_TEST_PASSWORD: password }
const coverage = process.argv.includes('--coverage')
const runtime = process.argv.includes('--runtime')
const presetDsn = process.env.DZ23_POSTGRES_TEST_DSN
const useCompose = presetDsn === undefined || presetDsn === ''
let started = false

try {
  const testEnv = { ...process.env }
  if (useCompose) {
    try {
      await run('docker', [...compose, 'up', '-d', '--wait'], composeEnv)
    } catch (error) {
      process.stdout.write('POSTGRES_GATE=NOT_EXECUTED reason=no-server (set DZ23_POSTGRES_TEST_DSN or provide Docker Compose)\n')
      throw error
    }
    started = true
    const endpoint = (await capture('docker', [...compose, 'port', 'postgres-test', '5432'], composeEnv)).trim()
    const container = (await capture('docker', [...compose, 'ps', '-q', 'postgres-test'], composeEnv)).trim()
    const port = endpoint.slice(endpoint.lastIndexOf(':') + 1)
    if (!/^\d+$/.test(port)) throw new Error('PostgreSQL test port was not published')
    if (container === '') throw new Error('PostgreSQL test container was not found')
    testEnv.DZ23_POSTGRES_TEST_DSN = `postgresql://dz23_test:${password}@127.0.0.1:${port}/dz23_test`
    testEnv.DZ23_POSTGRES_TEST_CONTAINER = container
  } else {
    delete testEnv.DZ23_POSTGRES_TEST_CONTAINER
    const version = (await capture(process.execPath, ['-e', `
      const { Client } = require('pg'); const c = new Client({ connectionString: process.env.DZ23_POSTGRES_TEST_DSN })
      c.connect().then(() => c.query('SHOW server_version_num')).then(r => { console.log(r.rows[0].server_version_num); return c.end() })
    `], testEnv)).trim()
    if (!/^16\d{4}$/.test(version)) {
      process.stdout.write(`POSTGRES_GATE=NOT_EXECUTED reason=server-version-${version || 'unknown'} (PostgreSQL 16 required)\n`)
      throw new Error(`PostgreSQL 16 required, server reports ${version || 'unknown'}`)
    }
  }
  if (runtime) testEnv.DZ23_POSTGRES_DSN = testEnv.DZ23_POSTGRES_TEST_DSN
  const vitest = runtime
    ? ['run', 'prove:postgres-runtime']
    : coverage
      ? ['exec', 'vitest', 'run', '--coverage', '--maxWorkers=1']
      : ['exec', 'vitest', 'run', 'plugins/storage-postgres/tests/postgres.spec.ts', '--reporter=verbose']
  await run('pnpm', vitest, testEnv)
  process.stdout.write(`POSTGRES_GATE=PASS server=${useCompose ? 'compose' : 'preset-dsn'} mode=${runtime ? 'runtime' : coverage ? 'coverage' : 'integration'}\n`)
} finally {
  if (started) await run('docker', [...compose, 'down', '-v'], composeEnv, true)
}

function run(command, args, env, tolerateFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', tolerateFailure ? resolve : reject)
    child.once('exit', code => {
      if (code === 0 || tolerateFailure) resolve()
      else reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}

function capture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited with code ${String(code)}`)))
  })
}
