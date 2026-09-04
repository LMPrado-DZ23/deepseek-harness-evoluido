#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { link, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const CHECK_NAMES = Object.freeze([
  'image_metadata',
  'hardened_storage',
  'runtime_tools',
  'managed_profile',
  'dump_config',
  'packaged_assets',
  'http_boot',
  'graceful_stop',
  'persistent_restart',
])

const SHA40 = /^[0-9a-f]{40}$/u
const SAFE_IMAGE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/@-]{0,510}$/u
const FORBIDDEN_CONFIG = ['studio-fake', 'studio-deterministic', 'studio_echo', 'tenant-poc-01']
const HOME_PATH = '/var/lib/dz23-studio'
const TMPFS = '/tmp:rw,noexec,nosuid,nodev,size=67108864'
const COMMAND_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 45_000

export class ProofFailure extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'ProofFailure'
    this.code = code
  }
}

function fail(code, message) {
  throw new ProofFailure(code, message)
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    fail('INVALID_DOCKER_OUTPUT', `${label} não retornou JSON válido`)
  }
}

function one(value, label) {
  if (!Array.isArray(value) || value.length !== 1) fail('INVALID_DOCKER_OUTPUT', `${label} precisa conter exatamente um item`)
  return value[0]
}

function statusResult(result, label) {
  if (result.error !== undefined) {
    const unavailable = result.error.code === 'ENOENT' ? 'DOCKER_UNAVAILABLE' : 'DOCKER_COMMAND_ERROR'
    fail(unavailable, `${label}: ${result.error.message}`)
  }
  if (result.signal !== null) fail('DOCKER_COMMAND_SIGNAL', `${label}: interrompido por ${result.signal}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${String(result.status)}`).trim().slice(0, 4_096)
    fail('DOCKER_COMMAND_FAILED', `${label}: ${detail}`)
  }
  return result
}

export function createDockerRunner(command = process.env.DZ23_DOCKER_BIN ?? 'docker') {
  return (args, options = {}) => {
    const started = Date.now()
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
    return {
      durationMs: Date.now() - started,
      error: result.error,
      signal: result.signal,
      status: result.status,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    }
  }
}

export function validateInputs(image, revision) {
  if (typeof image !== 'string' || !SAFE_IMAGE.test(image) || /\s/u.test(image)) fail('INVALID_IMAGE', 'referência de imagem inválida')
  if (typeof revision !== 'string' || !SHA40.test(revision)) fail('INVALID_REVISION', 'a revisão esperada precisa ser um SHA Git completo em minúsculas')
  return { image, revision }
}

export function assertImageMetadata(raw, expectedRevision) {
  const image = one(parseJson(raw, 'docker image inspect'), 'docker image inspect')
  const user = image?.Config?.User
  if (!['10001', '10001:10001'].includes(user)) fail('IMAGE_USER_MISMATCH', `usuário efetivo inesperado: ${String(user)}`)
  const env = Array.isArray(image?.Config?.Env) ? image.Config.Env : []
  const revision = env.find(item => item.startsWith('DZ23_STUDIO_IMAGE_REVISION='))?.slice('DZ23_STUDIO_IMAGE_REVISION='.length)
  if (revision !== expectedRevision) fail('IMAGE_REVISION_MISMATCH', `esperado ${expectedRevision}, recebido ${String(revision)}`)
  const entrypoint = image?.Config?.Entrypoint
  if (!Array.isArray(entrypoint) || entrypoint.join('\0') !== 'node\0entrypoint.mjs') {
    fail('IMAGE_ENTRYPOINT_MISMATCH', 'entrypoint versionado do Studio ausente')
  }
  return { imageId: image.Id, revision, user }
}

export function hardenedRunArgs({ image, name, volume, entrypoint, command = [], server = false }) {
  const args = [
    'create', '--name', name,
    '--read-only',
    '--tmpfs', TMPFS,
    '--mount', `type=volume,source=${volume},target=${HOME_PATH}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', 'none',
    '--user', '10001:10001',
  ]
  if (entrypoint !== undefined) args.push('--entrypoint', entrypoint)
  args.push(image, ...command)
  if (server && entrypoint !== undefined) fail('INTERNAL_PLAN_ERROR', 'servidor não aceita substituição de entrypoint')
  return args
}

export function assertHardenedContainer(raw, expectedVolume) {
  const container = one(parseJson(raw, 'docker container inspect'), 'docker container inspect')
  const host = container?.HostConfig ?? {}
  if (host.ReadonlyRootfs !== true) fail('ROOTFS_NOT_READ_ONLY', 'ReadonlyRootfs não está ativo')
  if (host.NetworkMode !== 'none') fail('NETWORK_NOT_DISABLED', `NetworkMode=${String(host.NetworkMode)}`)
  if (container?.Config?.User !== '10001:10001') fail('CONTAINER_USER_MISMATCH', `Config.User=${String(container?.Config?.User)}`)
  const tmpfs = host.Tmpfs?.['/tmp']
  const tmpfsOptions = typeof tmpfs === 'string' ? new Set(tmpfs.split(',')) : new Set()
  if (!['rw', 'noexec', 'nosuid', 'nodev', 'size=67108864'].every(item => tmpfsOptions.has(item))) {
    fail('TMPFS_MISMATCH', 'tmpfs /tmp endurecido ausente')
  }
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL')) fail('CAPABILITIES_NOT_DROPPED', 'CapDrop=ALL ausente')
  if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some(item => /^no-new-privileges(?::true)?$/u.test(item))) {
    fail('NO_NEW_PRIVILEGES_MISSING', 'no-new-privileges ausente')
  }
  const mounts = Array.isArray(container?.Mounts) ? container.Mounts : []
  const home = mounts.find(item => item.Destination === HOME_PATH)
  if (home?.Type !== 'volume' || home?.Name !== expectedVolume || home?.RW !== true) {
    fail('PERSISTENT_VOLUME_MISMATCH', 'volume gravável e nomeado do perfil ausente')
  }
  const forbidden = mounts.find(item => item.Destination === '/var/run/docker.sock' || item.Source === '/var/run/docker.sock')
  if (forbidden !== undefined) fail('DOCKER_SOCKET_MOUNTED', 'docker.sock nunca pode entrar no runtime')
  return { networkMode: host.NetworkMode, readOnly: true, tmpfs, volume: home.Name }
}

export function assertCleanDumpConfig(output) {
  if (typeof output !== 'string' || output.trim().length === 0) fail('EMPTY_DUMP_CONFIG', 'dump-config vazio é falha')
  const found = FORBIDDEN_CONFIG.filter(item => output.toLowerCase().includes(item.toLowerCase()))
  if (found.length > 0) fail('FORBIDDEN_PROVIDER_IN_RELEASE', `configuração de prova detectada: ${found.join(', ')}`)
  if (!output.includes('@dz23-studio/web') || !output.includes('@dz23-studio/prompt-to-app')) {
    fail('STUDIO_PLUGINS_MISSING', 'dump-config não contém os plugins obrigatórios do Studio')
  }
  return { bytes: Buffer.byteLength(output), forbiddenFound: [] }
}

export function assertGracefulExit(raw) {
  const container = one(parseJson(raw, 'docker container inspect após SIGTERM'), 'docker container inspect após SIGTERM')
  const state = container?.State ?? {}
  if (state.Running !== false || state.OOMKilled !== false) fail('UNEXPECTED_STOP_STATE', 'contêiner ainda ativo ou morto por OOM')
  if (state.ExitCode === 137) fail('SIGKILL_DETECTED', 'exit 137 indica escalonamento para SIGKILL')
  if (state.ExitCode !== 143) fail('SIGTERM_NOT_PROPAGATED', `exit esperado 143, recebido ${String(state.ExitCode)}`)
  return { exitCode: state.ExitCode, oomKilled: state.OOMKilled }
}

function inspect(runner, kind, target, label) {
  return statusResult(runner([kind, 'inspect', target]), label).stdout
}

function runOrFail(runner, args, label, timeoutMs) {
  return statusResult(runner(args, { timeoutMs }), label)
}

function mark(report, name, status, evidence = undefined, error = undefined) {
  report.checks[name] = {
    status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  }
}

function createReport(image, revision, now) {
  return {
    schemaVersion: 1,
    proof: 'DZ23_STUDIO_M6_1_RUNTIME',
    image,
    expectedRevision: revision,
    startedAt: now().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    checks: Object.fromEntries(CHECK_NAMES.map(name => [name, { status: 'NOT_EXECUTED' }])),
    cleanup: { status: 'NOT_EXECUTED' },
  }
}

async function pollStudio(runner, container, timeoutMs = START_TIMEOUT_MS) {
  const probe = [
    "const html=await fetch('http://127.0.0.1:3210/studio/').then(async r=>{if(r.status!==200)throw new Error('STUDIO_HTTP_'+r.status);return r.text()});",
    "if(!html.includes('DZ23 STUDIO'))throw new Error('STUDIO_BRAND_MISSING');",
    "const match=html.match(/(?:src|href)=\"(\\/studio\\/assets\\/[^\"]+)\"/u);if(!match)throw new Error('HASHED_ASSET_MISSING');",
    "const asset=await fetch('http://127.0.0.1:3210'+match[1]);if(asset.status!==200)throw new Error('ASSET_HTTP_'+asset.status);",
    "const bytes=(await asset.arrayBuffer()).byteLength;if(bytes<=0)throw new Error('ASSET_EMPTY');",
    "process.stdout.write(JSON.stringify({asset:match[1],assetBytes:bytes,htmlBytes:Buffer.byteLength(html)}));",
  ].join('')
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const result = runner(['exec', '--user', '10001:10001', container, 'node', '--input-type=module', '-e', probe], { timeoutMs: 10_000 })
    if (result.status === 0 && result.signal === null && result.error === undefined) return parseJson(result.stdout, 'sonda HTTP interna')
    last = (result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 1_024)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  fail('STUDIO_BOOT_TIMEOUT', last || 'a interface não respondeu no prazo')
}

function managedProfileScript(revision, mode) {
  return [
    "const fs=require('node:fs');const path=require('node:path');",
    `const root='${HOME_PATH}/profiles/.dz23-managed';const link='${HOME_PATH}/profiles/studio';`,
    "const target=fs.realpathSync(link);if(!target.startsWith(root+'/'))throw new Error('PROFILE_NOT_MANAGED');",
    `if(fs.readFileSync(path.join(target,'.image-revision'),'utf8').trim()!=='${revision}')throw new Error('PROFILE_REVISION_MISMATCH');`,
    mode === 'write'
      ? "fs.writeFileSync(path.join(target,'.m61-persistence-proof'),'persisted\\n',{mode:0o600});process.stdout.write(JSON.stringify({target,writable:true}));"
      : "const marker=fs.readFileSync(path.join(target,'.m61-persistence-proof'),'utf8');if(marker!=='persisted\\n')throw new Error('PROFILE_MARKER_MISSING');process.stdout.write(JSON.stringify({target,persisted:true}));",
  ].join('')
}

const packagedAssetsScript = [
  "const fs=require('node:fs');",
  "const ui='/opt/dz23-studio/runtime/node_modules/@dz23-studio/web/lib/client/index.html';",
  "const template='/opt/dz23-studio/runtime/node_modules/@dz23-studio/prompt-to-app/template/nextjs-app@1/package.json';",
  "for(const file of [ui,template]){const s=fs.statSync(file);if(!s.isFile()||s.size<=0)throw new Error('PACKAGED_FILE_MISSING:'+file)}",
  "const manifest=JSON.parse(fs.readFileSync(template,'utf8'));if(typeof manifest.name!=='string'||manifest.name.length===0)throw new Error('TEMPLATE_MANIFEST_INVALID');",
  "process.stdout.write(JSON.stringify({uiBytes:fs.statSync(ui).size,templateBytes:fs.statSync(template).size,templateName:manifest.name}));",
].join('')

function ownName(prefix, nonce) {
  return `dz23-m61-${prefix}-${nonce}`
}

export async function proveStudioRuntime({ image, revision, runner = createDockerRunner(), now = () => new Date(), nonce = randomBytes(6).toString('hex') }) {
  validateInputs(image, revision)
  if (!/^[a-f0-9]{12}$/u.test(nonce)) fail('INVALID_NONCE', 'nonce interno inválido')
  const report = createReport(image, revision, now)
  const volume = ownName('data', nonce)
  const dump = ownName('dump', nonce)
  const first = ownName('boot-a', nonce)
  const second = ownName('boot-b', nonce)
  const containers = []
  let volumeCreated = false
  let currentCheck = 'image_metadata'
  try {
    const metadata = assertImageMetadata(inspect(runner, 'image', image, 'imagem Docker'), revision)
    mark(report, 'image_metadata', 'PASS', metadata)

    currentCheck = 'hardened_storage'
    const volumeResult = runOrFail(runner, ['volume', 'create', volume], 'criação do volume')
    if (volumeResult.stdout.trim() !== volume) fail('VOLUME_NAME_MISMATCH', 'Docker devolveu outro nome de volume')
    volumeCreated = true
    runOrFail(runner, hardenedRunArgs({
      image, name: dump, volume,
      command: ['--profile', 'studio', '--dump-config'],
    }), 'criação do contêiner dump-config')
    containers.push(dump)
    const hardening = assertHardenedContainer(inspect(runner, 'container', dump, 'contêiner dump-config'), volume)
    mark(report, 'hardened_storage', 'PASS', hardening)

    currentCheck = 'runtime_tools'
    const gitContainer = ownName('git', nonce)
    runOrFail(runner, hardenedRunArgs({ image, name: gitContainer, volume, entrypoint: 'git', command: ['--version'] }), 'criação da prova Git')
    containers.push(gitContainer)
    const gitResult = runOrFail(runner, ['start', '--attach', gitContainer], 'Git do runtime')
    if (!/^git version \d+\.\d+\.\d+\s*$/u.test(gitResult.stdout)) fail('GIT_RUNTIME_MISSING', 'git --version não retornou uma versão válida')
    mark(report, 'runtime_tools', 'PASS', { git: gitResult.stdout.trim() })

    currentCheck = 'dump_config'
    const dumpResult = runOrFail(runner, ['start', '--attach', dump], 'dump-config', 120_000)
    mark(report, 'dump_config', 'PASS', assertCleanDumpConfig(dumpResult.stdout))

    currentCheck = 'managed_profile'
    const profileWrite = ownName('profile-write', nonce)
    runOrFail(runner, hardenedRunArgs({
      image, name: profileWrite, volume, entrypoint: 'node',
      command: ['-e', managedProfileScript(revision, 'write')],
    }), 'criação da prova de escrita do perfil')
    containers.push(profileWrite)
    const profileResult = runOrFail(runner, ['start', '--attach', profileWrite], 'escrita no perfil gerenciado')
    mark(report, 'managed_profile', 'PASS', parseJson(profileResult.stdout, 'perfil gerenciado'))

    currentCheck = 'packaged_assets'
    const assets = ownName('assets', nonce)
    runOrFail(runner, hardenedRunArgs({ image, name: assets, volume, entrypoint: 'node', command: ['-e', packagedAssetsScript] }), 'criação da prova de artefatos')
    containers.push(assets)
    const assetResult = runOrFail(runner, ['start', '--attach', assets], 'artefatos empacotados')
    mark(report, 'packaged_assets', 'PASS', parseJson(assetResult.stdout, 'artefatos empacotados'))

    currentCheck = 'http_boot'
    runOrFail(runner, hardenedRunArgs({
      image, name: first, volume, server: true,
      command: ['--profile', 'studio', '--host', '127.0.0.1', '--port', '3210', '--no-open'],
    }), 'criação do primeiro boot')
    containers.push(first)
    runOrFail(runner, ['start', first], 'primeiro boot')
    const firstHttp = await pollStudio(runner, first)
    mark(report, 'http_boot', 'PASS', firstHttp)

    currentCheck = 'graceful_stop'
    const stopped = runOrFail(runner, ['stop', '--signal', 'SIGTERM', '--time', '10', first], 'SIGTERM do primeiro boot', 20_000)
    const graceful = assertGracefulExit(inspect(runner, 'container', first, 'estado após SIGTERM'))
    mark(report, 'graceful_stop', 'PASS', { ...graceful, stopDurationMs: stopped.durationMs })

    currentCheck = 'persistent_restart'
    runOrFail(runner, hardenedRunArgs({
      image, name: second, volume, server: true,
      command: ['--profile', 'studio', '--host', '127.0.0.1', '--port', '3210', '--no-open'],
    }), 'criação do segundo boot')
    containers.push(second)
    runOrFail(runner, ['start', second], 'segundo boot')
    const secondHttp = await pollStudio(runner, second)
    const persistence = runOrFail(runner, [
      'exec', '--user', '10001:10001', second, 'node', '-e', managedProfileScript(revision, 'read'),
    ], 'leitura do perfil após reinício')
    runOrFail(runner, ['stop', '--signal', 'SIGTERM', '--time', '10', second], 'SIGTERM do segundo boot', 20_000)
    const secondStop = assertGracefulExit(inspect(runner, 'container', second, 'estado do segundo boot'))
    mark(report, 'persistent_restart', 'PASS', {
      ...parseJson(persistence.stdout, 'persistência do perfil'),
      http: secondHttp,
      exitCode: secondStop.exitCode,
    })
    report.status = 'PASS'
  } catch (error) {
    if (CHECK_NAMES.includes(currentCheck) && report.checks[currentCheck].status === 'NOT_EXECUTED') {
      mark(report, currentCheck, 'FAIL', undefined, error)
    }
    report.status = 'FAIL'
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    const failures = []
    for (const container of [...containers].reverse()) {
      const result = runner(['rm', '--force', '--volumes', container], { timeoutMs: 20_000 })
      if (result.status !== 0 && !/No such container/iu.test(`${result.stderr}\n${result.stdout}`)) failures.push(`container ${container}`)
    }
    if (volumeCreated) {
      const result = runner(['volume', 'rm', volume], { timeoutMs: 20_000 })
      if (result.status !== 0 && !/No such volume/iu.test(`${result.stderr}\n${result.stdout}`)) failures.push(`volume ${volume}`)
    }
    report.cleanup = failures.length === 0
      ? { status: 'PASS', resources: { containers: containers.length, volumes: volumeCreated ? 1 : 0 } }
      : { status: 'FAIL', error: `recursos não removidos: ${failures.join(', ')}` }
    if (failures.length > 0) report.status = 'FAIL'
    report.completedAt = now().toISOString()
  }
  return report
}

export async function writeProofReport(path, report) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await link(temporary, destination)
    await unlink(temporary)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function usage() {
  return 'Uso: node scripts/prove-studio-runtime.mjs --image <imagem> --revision <sha40> --out <relatorio.json>'
}

function parseCli(argv) {
  const allowed = new Set(['--image', '--revision', '--out'])
  const values = new Map()
  if (argv.length !== 6) fail('INVALID_ARGUMENTS', usage())
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(key) || values.has(key) || value === undefined || value.startsWith('--')) fail('INVALID_ARGUMENTS', usage())
    values.set(key, value)
  }
  for (const key of allowed) if (!values.has(key)) fail('INVALID_ARGUMENTS', `${key} ausente; ${usage()}`)
  return { image: values.get('--image'), revision: values.get('--revision'), out: values.get('--out') }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv)
  const report = await proveStudioRuntime(options)
  await writeProofReport(options.out, report)
  const message = `STUDIO_RUNTIME_PROOF=${report.status} image=${report.image} revision=${report.expectedRevision} report=${resolve(options.out)}\n`
  ;(report.status === 'PASS' ? process.stdout : process.stderr).write(message)
  if (report.status !== 'PASS') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`STUDIO_RUNTIME_PROOF=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
