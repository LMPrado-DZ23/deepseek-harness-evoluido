import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertCleanDumpConfig,
  assertGracefulExit,
  assertHardenedContainer,
  assertImageMetadata,
  hardenedRunArgs,
  proveStudioRuntime,
  validateInputs,
  writeProofReport,
} from '../../scripts/prove-studio-runtime.mjs'

const REVISION = 'f'.repeat(40)
const IMAGE = 'dz23-studio:m61-test'

function imageInspect(overrides = {}) {
  return JSON.stringify([{
    Id: 'sha256:' + 'a'.repeat(64),
    Config: {
      User: '10001:10001',
      Entrypoint: ['node', 'entrypoint.mjs'],
      Env: [`DZ23_STUDIO_IMAGE_REVISION=${REVISION}`],
      ...overrides,
    },
  }])
}

function containerInspect(overrides = {}) {
  return JSON.stringify([{
    Config: { User: '10001:10001' },
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: 'none',
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=67108864' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    },
    Mounts: [{ Destination: '/var/lib/dz23-studio', Type: 'volume', Name: 'proof-data', RW: true }],
    ...overrides,
  }])
}

test('valida imagem e revisão sem aceitar argumentos ambíguos', () => {
  assert.deepEqual(validateInputs(IMAGE, REVISION), { image: IMAGE, revision: REVISION })
  assert.throws(() => validateInputs('--privileged', REVISION), /INVALID_IMAGE/u)
  assert.throws(() => validateInputs('image latest', REVISION), /INVALID_IMAGE/u)
  assert.throws(() => validateInputs(IMAGE, 'f'.repeat(39)), /INVALID_REVISION/u)
})

test('confere usuário, revisão e entrypoint da imagem', () => {
  assert.equal(assertImageMetadata(imageInspect(), REVISION).user, '10001:10001')
  assert.throws(() => assertImageMetadata(imageInspect({ User: 'root' }), REVISION), /IMAGE_USER_MISMATCH/u)
  assert.throws(() => assertImageMetadata(imageInspect({ Env: ['DZ23_STUDIO_IMAGE_REVISION=' + 'e'.repeat(40)] }), REVISION), /IMAGE_REVISION_MISMATCH/u)
  assert.throws(() => assertImageMetadata(imageInspect({ Entrypoint: ['/bin/sh'] }), REVISION), /IMAGE_ENTRYPOINT_MISMATCH/u)
})

test('plano do contêiner é fechado: sem rede, rootfs somente leitura e sem docker.sock', () => {
  const args = hardenedRunArgs({ image: IMAGE, name: 'proof', volume: 'proof-data', command: ['--profile', 'studio', '--dump-config'] })
  assert.deepEqual(args.slice(0, 2), ['create', '--name'])
  assert.ok(args.includes('--read-only'))
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none'])
  assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL'])
  assert.deepEqual(args.slice(args.indexOf('--security-opt'), args.indexOf('--security-opt') + 2), ['--security-opt', 'no-new-privileges'])
  assert.doesNotMatch(args.join(' '), /docker\.sock|privileged/u)
})

test('inspect do contêiner confirma as proteções e o volume esperado', () => {
  assert.equal(assertHardenedContainer(containerInspect(), 'proof-data').readOnly, true)
  const normalized = JSON.parse(containerInspect())
  normalized[0].HostConfig.Tmpfs['/tmp'] = 'rw,nosuid,nodev,noexec,size=67108864'
  normalized[0].HostConfig.SecurityOpt = ['no-new-privileges:true']
  assert.equal(assertHardenedContainer(JSON.stringify(normalized), 'proof-data').networkMode, 'none')
  assert.throws(() => assertHardenedContainer(containerInspect({ HostConfig: { ReadonlyRootfs: false } }), 'proof-data'), /ROOTFS_NOT_READ_ONLY/u)
  const socket = JSON.parse(containerInspect())
  socket[0].Mounts.push({ Destination: '/var/run/docker.sock', Source: '/var/run/docker.sock', Type: 'bind', RW: false })
  assert.throws(() => assertHardenedContainer(JSON.stringify(socket), 'proof-data'), /DOCKER_SOCKET_MOUNTED/u)
})

test('dump-config vazio, incompleto ou com provider de prova falha fechado', () => {
  const production = "name: '@dz23-studio/web'\nname: '@dz23-studio/prompt-to-app'\n"
  assert.equal(assertCleanDumpConfig(production).forbiddenFound.length, 0)
  assert.throws(() => assertCleanDumpConfig(''), /EMPTY_DUMP_CONFIG/u)
  assert.throws(() => assertCleanDumpConfig("name: '@dz23-studio/web'"), /STUDIO_PLUGINS_MISSING/u)
  assert.throws(() => assertCleanDumpConfig(`${production}provider: studio-fake`), /FORBIDDEN_PROVIDER_IN_RELEASE/u)
  assert.throws(() => assertCleanDumpConfig(`${production}tenant-poc-01`), /FORBIDDEN_PROVIDER_IN_RELEASE/u)
})

test('saída 143 prova SIGTERM; 137 é tratada como SIGKILL', () => {
  const state = code => JSON.stringify([{ State: { Running: false, OOMKilled: false, ExitCode: code } }])
  assert.equal(assertGracefulExit(state(143)).exitCode, 143)
  assert.throws(() => assertGracefulExit(state(137)), /SIGKILL_DETECTED/u)
  assert.throws(() => assertGracefulExit(state(0)), /SIGTERM_NOT_PROPAGATED/u)
})

test('Docker ausente falha no primeiro check e deixa os demais NOT_EXECUTED', async () => {
  const runner = () => ({
    durationMs: 0,
    error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
    signal: null,
    status: null,
    stderr: '',
    stdout: '',
  })
  const report = await proveStudioRuntime({ image: IMAGE, revision: REVISION, runner, nonce: '0123456789ab' })
  assert.equal(report.status, 'FAIL')
  assert.equal(report.checks.image_metadata.status, 'FAIL')
  assert.match(report.checks.image_metadata.error, /DOCKER_UNAVAILABLE/u)
  for (const [name, check] of Object.entries(report.checks)) {
    if (name !== 'image_metadata') assert.equal(check.status, 'NOT_EXECUTED')
  }
  assert.equal(report.cleanup.status, 'PASS')
})

test('orquestra duas inicializações reais pelo contrato Docker e fecha todos os checks', async () => {
  const containers = new Map()
  const calls = []
  const ok = (stdout = '') => ({ durationMs: 3, error: undefined, signal: null, status: 0, stderr: '', stdout })
  const runner = args => {
    calls.push(args)
    if (args[0] === 'image' && args[1] === 'inspect') return ok(imageInspect())
    if (args[0] === 'volume' && args[1] === 'create') return ok(`${args[2]}\n`)
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1]
      const volume = args[args.indexOf('--mount') + 1].match(/source=([^,]+)/u)[1]
      containers.set(name, { state: { Running: false, OOMKilled: false, ExitCode: 0 }, volume })
      return ok(name + '\n')
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const item = containers.get(args[2])
      const inspected = JSON.parse(containerInspect().replaceAll('proof-data', item.volume))
      inspected[0].State = item.state
      return ok(JSON.stringify(inspected))
    }
    if (args[0] === 'start' && args[1] === '--attach') {
      const name = args[2]
      if (name.includes('-git-')) return ok('git version 2.39.5\n')
      if (name.includes('-dump-')) return ok("name: '@dz23-studio/web'\nname: '@dz23-studio/prompt-to-app'\n")
      if (name.includes('-profile-write-')) return ok(JSON.stringify({ target: '/var/lib/dz23-studio/profiles/.dz23-managed/studio-' + REVISION, writable: true }))
      if (name.includes('-assets-')) return ok(JSON.stringify({ uiBytes: 100, templateBytes: 200, templateName: 'app' }))
    }
    if (args[0] === 'start') {
      containers.get(args[1]).state.Running = true
      return ok(args[1] + '\n')
    }
    if (args[0] === 'exec') {
      if (args.at(-2) === '-e' && args.at(-1).includes("fetch('http://127.0.0.1:3210/studio/'))")) {
        return ok(JSON.stringify({ asset: '/studio/assets/main.js', assetBytes: 50, htmlBytes: 80 }))
      }
      return ok(JSON.stringify({ target: '/var/lib/dz23-studio/profiles/.dz23-managed/studio-' + REVISION, persisted: true }))
    }
    if (args[0] === 'stop') {
      const item = containers.get(args.at(-1))
      item.state = { Running: false, OOMKilled: false, ExitCode: 143 }
      return ok(args.at(-1) + '\n')
    }
    if (args[0] === 'rm') return ok()
    if (args[0] === 'volume' && args[1] === 'rm') return ok(args[2] + '\n')
    return { ...ok(), status: 64, stderr: `unexpected: ${args.join(' ')}` }
  }

  const report = await proveStudioRuntime({ image: IMAGE, revision: REVISION, runner, nonce: 'abcdef012345' })
  assert.equal(report.status, 'PASS')
  assert.ok(Object.values(report.checks).every(check => check.status === 'PASS'))
  assert.equal(report.cleanup.status, 'PASS')
  const createCalls = calls.filter(args => args[0] === 'create')
  assert.equal(createCalls.length, 6)
  assert.ok(createCalls.every(args => args.includes('--read-only') && args.includes('none')))
  assert.doesNotMatch(calls.flat().join(' '), /docker\.sock|--privileged/u)
})

test('relatório é criado sem sobrescrever evidência anterior', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dz23-m61-proof-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = join(root, 'proof.json')
  const report = { status: 'FAIL', checks: { image_metadata: { status: 'NOT_EXECUTED' } } }
  await writeProofReport(destination, report)
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), report)
  await assert.rejects(() => writeProofReport(destination, { status: 'PASS' }), /EEXIST/u)
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), report)
})

test('fonte não contém montagem do socket, modo privilegiado, instalação de CA ou shell', async () => {
  const source = await readFile(new URL('../../scripts/prove-studio-runtime.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /['"]--privileged['"]|['"]-v['"]|['"]--volume['"]/u)
  assert.doesNotMatch(source, /update-ca-certificates|trust\s+anchor|certutil|keychain|shell:\s*true/iu)
  assert.doesNotMatch(source, /\/var\/run\/docker\.sock.*--mount|--mount.*\/var\/run\/docker\.sock/u)
})
