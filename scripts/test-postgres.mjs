import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const compose = ['compose', '-p', 'dz23-p31-test', '-f', 'deploy/postgres/docker-compose.test.yml']
const password = randomBytes(24).toString('hex')
const composeEnv = { ...process.env, DZ23_POSTGRES_TEST_PASSWORD: password }
const coverage = process.argv.includes('--coverage')
const runtime = process.argv.includes('--runtime')

try {
  await run('docker', [...compose, 'up', '-d', '--wait'], composeEnv)
  const endpoint = (await capture('docker', [...compose, 'port', 'postgres-test', '5432'], composeEnv)).trim()
  const port = endpoint.slice(endpoint.lastIndexOf(':') + 1)
  if (!/^\d+$/.test(port)) throw new Error('PostgreSQL test port was not published')
  const testEnv = {
    ...process.env,
    DZ23_POSTGRES_TEST_DSN: `postgresql://dz23_test:${password}@127.0.0.1:${port}/dz23_test`,
  }
  if (runtime) testEnv.DZ23_POSTGRES_DSN = testEnv.DZ23_POSTGRES_TEST_DSN
  const vitest = runtime
    ? ['run', 'prove:postgres-runtime']
    : coverage
      ? ['exec', 'vitest', 'run', '--coverage']
      : ['exec', 'vitest', 'run', 'plugins/storage-postgres/tests/postgres.spec.ts', '--reporter=verbose']
  await run('pnpm', vitest, testEnv)
} finally {
  await run('docker', [...compose, 'down', '-v'], composeEnv, true)
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
