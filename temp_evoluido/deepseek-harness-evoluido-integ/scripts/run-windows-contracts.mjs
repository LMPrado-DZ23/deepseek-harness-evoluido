import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { assertRegularFileWithinRoot, assertTapSuccess } from './windows-contracts-lib.mjs'

const root = resolve(import.meta.dirname, '..')
const matrixPath = resolve(root, 'tests/m6/windows-contract-matrix.json')

function fail(message) {
  console.error(`DZ23_WINDOWS_CONTRACTS=FAIL ${message}`)
  process.exitCode = 1
}

function parseProfile(argv) {
  if (argv.length !== 2 || argv[0] !== '--profile') {
    throw new Error('uso: node scripts/run-windows-contracts.mjs --profile <hosted|windows-wsl2|all>')
  }
  if (!['hosted', 'windows-wsl2', 'all'].includes(argv[1])) {
    throw new Error(`perfil desconhecido: ${argv[1]}`)
  }
  return argv[1]
}

function loadMatrix() {
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
  if (matrix.schema_version !== 1 || typeof matrix.profiles !== 'object' || matrix.profiles === null) {
    throw new Error('matriz de contratos Windows inválida')
  }
  return matrix
}

function testsFor(matrix, profile) {
  const names = profile === 'all' ? ['hosted', 'windows-wsl2'] : [profile]
  const tests = names.flatMap((name) => matrix.profiles[name]?.tests ?? [])
  if (tests.length === 0 || new Set(tests).size !== tests.length) {
    throw new Error(`perfil ${profile} vazio ou com teste duplicado`)
  }
  for (const relative of tests) {
    assertRegularFileWithinRoot(root, relative)
  }
  return tests
}

function assertEnvironment(profile) {
  if (process.platform !== 'win32') {
    throw new Error('os contratos Windows devem ser executados no Windows real')
  }
  const pwsh = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (pwsh.status !== 0 || Number.parseInt(pwsh.stdout.trim(), 10) < 7) {
    throw new Error('PowerShell 7 não está disponível')
  }
  if (profile === 'windows-wsl2' || profile === 'all') {
    const wsl = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--exec', '/bin/cat', '/proc/sys/kernel/osrelease'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (wsl.status !== 0 || !/microsoft-standard-WSL2/iu.test(wsl.stdout)) {
      throw new Error(`WSL2 Ubuntu indisponível: ${(wsl.stderr || wsl.stdout).trim()}`)
    }
  }
}

try {
  const profile = parseProfile(process.argv.slice(2))
  const matrix = loadMatrix()
  const tests = testsFor(matrix, profile)
  assertEnvironment(profile)
  for (const relative of tests) {
    console.log(`DZ23_WINDOWS_CONTRACT=${relative}`)
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', relative], {
      cwd: root,
      encoding: 'utf8',
      timeout: 12 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.error || result.status !== 0) {
      throw new Error(`${relative} falhou com ${result.error?.message ?? `exit ${result.status}`}`)
    }
    assertTapSuccess(result.stdout, relative)
  }
  console.log(`DZ23_WINDOWS_CONTRACTS=PASS profile=${profile} files=${tests.length}`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
