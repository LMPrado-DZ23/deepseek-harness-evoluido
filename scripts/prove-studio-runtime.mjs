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
const BACKUP_PATH = '/var/lib/dz23-studio-backups'
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
  if (!/^sha256:[0-9a-f]{64}$/u.test(image?.Id)) fail('IMAGE_ID_INVALID', 'imagem sem content ID imutável')
  const user = image?.Config?.User
  if (!['10001', '10001:10001'].includes(user)) fail('IMAGE_USER_MISMATCH', `usuário efetivo inesperado: ${String(user)}`)
  const env = Array.isArray(image?.Config?.Env) ? image.Config.Env : []
  const revision = env.find(item => item.startsWith('DZ23_STUDIO_IMAGE_REVISION='))?.slice('DZ23_STUDIO_IMAGE_REVISION='.length)
  if (revision !== expectedRevision) fail('IMAGE_REVISION_MISMATCH', `esperado ${expectedRevision}, recebido ${String(revision)}`)
  const labelRevision = image?.Config?.Labels?.['org.opencontainers.image.revision']
  if (labelRevision !== expectedRevision) {
    fail('IMAGE_LABEL_REVISION_MISMATCH', `label OCI esperada ${expectedRevision}, recebida ${String(labelRevision)}`)
  }
  const entrypoint = image?.Config?.Entrypoint
  if (!Array.isArray(entrypoint) || entrypoint.join('\0') !== 'node\0entrypoint.mjs') {
    fail('IMAGE_ENTRYPOINT_MISMATCH', 'entrypoint versionado do Studio ausente')
  }
  return { imageId: image.Id, revision, user }
}

export function hardenedRunArgs({ image, name, volume, backupVolume, entrypoint, command = [], server = false }) {
  if (!backupVolume) fail('INTERNAL_PLAN_ERROR', 'volume de backup obrigatório')
  const args = [
    'create', '--name', name,
    '--read-only',
    '--tmpfs', TMPFS,
    '--mount', `type=volume,source=${volume},target=${HOME_PATH}`,
    '--mount', `type=volume,source=${backupVolume},target=${BACKUP_PATH}`,
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

export function assertHardenedContainer(raw, expectedVolume, expectedBackupVolume, expectedImageId) {
  const container = one(parseJson(raw, 'docker container inspect'), 'docker container inspect')
  if (container?.Image !== expectedImageId) fail('CONTAINER_IMAGE_MISMATCH', 'contêiner não usa o content ID inspecionado')
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
  const backup = mounts.find(item => item.Destination === BACKUP_PATH)
  if (backup?.Type !== 'volume' || backup?.Name !== expectedBackupVolume || backup?.RW !== true) {
    fail('BACKUP_VOLUME_MISMATCH', 'volume gravável e nomeado de backup ausente')
  }
  const allowedDestinations = new Set([HOME_PATH, BACKUP_PATH])
  if (mounts.length !== allowedDestinations.size || mounts.some(item => (
    item.Type !== 'volume' || !allowedDestinations.has(item.Destination)
  ))) {
    fail('UNEXPECTED_RUNTIME_MOUNT', 'runtime contém bind, device ou montagem adicional')
  }
  return { imageId: container.Image, networkMode: host.NetworkMode, readOnly: true, tmpfs, volume: home.Name, backupVolume: backup.Name }
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
  if (state.ExitCode !== 0) fail('CLEAN_SHUTDOWN_NOT_CONFIRMED', `exit limpo esperado 0, recebido ${String(state.ExitCode)}`)
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
      : `const marker=fs.readFileSync(path.join(target,'.m61-persistence-proof'),'utf8');if(marker!=='persisted\\n')throw new Error('PROFILE_MARKER_MISSING');const shutdown=JSON.parse(fs.readFileSync('${HOME_PATH}/.last-clean-shutdown.json','utf8'));if(shutdown.imageRevision!=='${revision}'||shutdown.requestedSignal!=='SIGTERM')throw new Error('CLEAN_SHUTDOWN_MARKER_INVALID');process.stdout.write(JSON.stringify({target,persisted:true,cleanShutdown:true}));`,
  ].join('')
}

const packagedAssetsScript = [
  "const fs=require('node:fs');const crypto=require('node:crypto');const path=require('node:path');",
  "const ui='/opt/dz23-studio/runtime/node_modules/@dz23-studio/web/lib/client/index.html';",
  "const root='/opt/dz23-studio/runtime/node_modules/@dz23-studio/prompt-to-app/template/nextjs-app@1';",
  "const required=['package.json','pnpm-lock.yaml','app/layout.tsx','app/page.tsx','src/lib/utils.ts','tests/e2e/smoke.spec.ts'];",
  "function walk(dir,prefix=''){const out=[];for(const item of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix?prefix+'/'+item.name:item.name;const full=path.join(dir,item.name);if(item.isSymbolicLink())throw new Error('TEMPLATE_SYMLINK:'+rel);if(item.isDirectory())out.push(...walk(full,rel));else if(item.isFile())out.push(rel);else throw new Error('TEMPLATE_SPECIAL_FILE:'+rel)}return out}",
  "const uiStat=fs.statSync(ui);if(!uiStat.isFile()||uiStat.size<=0)throw new Error('PACKAGED_UI_MISSING');",
  "const files=walk(root).sort();if(files.length!==23)throw new Error('TEMPLATE_FILE_COUNT:'+files.length);for(const file of required){if(!files.includes(file))throw new Error('PACKAGED_FILE_MISSING:'+file)}",
  "const digest=crypto.createHash('sha256');let bytes=0;for(const file of files){const data=fs.readFileSync(path.join(root,file));if(data.length===0)throw new Error('TEMPLATE_EMPTY:'+file);bytes+=data.length;digest.update(file).update('\\0').update(crypto.createHash('sha256').update(data).digest()).update('\\0')}",
  "const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));if(typeof manifest.name!=='string'||manifest.name.length===0)throw new Error('TEMPLATE_MANIFEST_INVALID');",
  "process.stdout.write(JSON.stringify({uiBytes:uiStat.size,templateBytes:bytes,templateFiles:files.length,templateSha256:digest.digest('hex'),templateName:manifest.name}));",
].join('')

const runtimeToolsScript = [
  "const {spawnSync}=require('node:child_process');",
  "function run(command,args=[]){const r=spawnSync(command,args,{encoding:'utf8'});return {command,code:r.status,error:r.error?.code,stdout:(r.stdout||'').trim()}}",
  "const git=run('git',['--version']);if(git.code!==0||!/^git version \\d+\\.\\d+\\.\\d+$/.test(git.stdout))throw new Error('GIT_RUNTIME_MISSING');",
  "const forbidden=['npm','npx','corepack','pnpm','docker'].map(command=>run(command));if(forbidden.some(item=>item.error!=='ENOENT'))throw new Error('FORBIDDEN_RUNTIME_TOOL:'+JSON.stringify(forbidden));",
  "process.stdout.write(JSON.stringify({node:process.version,git:git.stdout,absent:forbidden.map(item=>item.command)}));",
].join('')

function ownName(prefix, nonce) {
  return `dz23-m61-${prefix}-${nonce}`
}

export async function proveStudioRuntime({ image, revision, runner = createDockerRunner(), now = () => new Date(), nonce = randomBytes(6).toString('hex') }) {
  validateInputs(image, revision)
  if (!/^[a-f0-9]{12}$/u.test(nonce)) fail('INVALID_NONCE', 'nonce interno inválido')
  const report = createReport(image, revision, now)
  const volume = ownName('data', nonce)
  const backupVolume = ownName('backups', nonce)
  const dump = ownName('dump', nonce)
  const first = ownName('boot-a', nonce)
  const second = ownName('boot-b', nonce)
  const containers = []
  const createdVolumes = []
  let currentCheck = 'image_metadata'
  try {
    const metadata = assertImageMetadata(inspect(runner, 'image', image, 'imagem Docker'), revision)
    mark(report, 'image_metadata', 'PASS', metadata)
    const resolvedImage = metadata.imageId

    currentCheck = 'hardened_storage'
    for (const candidate of [volume, backupVolume]) {
      const volumeResult = runOrFail(runner, ['volume', 'create', candidate], `criação do volume ${candidate}`)
      if (volumeResult.stdout.trim() !== candidate) fail('VOLUME_NAME_MISMATCH', 'Docker devolveu outro nome de volume')
      createdVolumes.push(candidate)
    }
    runOrFail(runner, hardenedRunArgs({
      image: resolvedImage, name: dump, volume, backupVolume,
      command: ['--profile', 'studio', '--dump-config'],
    }), 'criação do contêiner dump-config')
    containers.push(dump)
    const hardening = assertHardenedContainer(
      inspect(runner, 'container', dump, 'contêiner dump-config'),
      volume,
      backupVolume,
      resolvedImage,
    )
    mark(report, 'hardened_storage', 'PASS', hardening)

    currentCheck = 'runtime_tools'
    const gitContainer = ownName('git', nonce)
    runOrFail(runner, hardenedRunArgs({
      image: resolvedImage, name: gitContainer, volume, backupVolume, entrypoint: 'node', command: ['-e', runtimeToolsScript],
    }), 'criação da prova das ferramentas do runtime')
    containers.push(gitContainer)
    const gitResult = runOrFail(runner, ['start', '--attach', gitContainer], 'ferramentas do runtime')
    mark(report, 'runtime_tools', 'PASS', parseJson(gitResult.stdout, 'ferramentas do runtime'))

    currentCheck = 'dump_config'
    const dumpResult = runOrFail(runner, ['start', '--attach', dump], 'dump-config', 120_000)
    mark(report, 'dump_config', 'PASS', assertCleanDumpConfig(dumpResult.stdout))

    currentCheck = 'managed_profile'
    const profileWrite = ownName('profile-write', nonce)
    runOrFail(runner, hardenedRunArgs({
      image: resolvedImage, name: profileWrite, volume, backupVolume, entrypoint: 'node',
      command: ['-e', managedProfileScript(revision, 'write')],
    }), 'criação da prova de escrita do perfil')
    containers.push(profileWrite)
    const profileResult = runOrFail(runner, ['start', '--attach', profileWrite], 'escrita no perfil gerenciado')
    mark(report, 'managed_profile', 'PASS', parseJson(profileResult.stdout, 'perfil gerenciado'))

    currentCheck = 'packaged_assets'
    const assets = ownName('assets', nonce)
    runOrFail(runner, hardenedRunArgs({ image: resolvedImage, name: assets, volume, backupVolume, entrypoint: 'node', command: ['-e', packagedAssetsScript] }), 'criação da prova de artefatos')
    containers.push(assets)
    const assetResult = runOrFail(runner, ['start', '--attach', assets], 'artefatos empacotados')
    mark(report, 'packaged_assets', 'PASS', parseJson(assetResult.stdout, 'artefatos empacotados'))

    currentCheck = 'http_boot'
    runOrFail(runner, hardenedRunArgs({
      image: resolvedImage, name: first, volume, backupVolume, server: true,
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
      image: resolvedImage, name: second, volume, backupVolume, server: true,
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
    for (const createdVolume of [...createdVolumes].reverse()) {
      const result = runner(['volume', 'rm', createdVolume], { timeoutMs: 20_000 })
      if (result.status !== 0 && !/No such volume/iu.test(`${result.stderr}\n${result.stdout}`)) failures.push(`volume ${createdVolume}`)
    }
    report.cleanup = failures.length === 0
      ? { status: 'PASS', resources: { containers: containers.length, volumes: createdVolumes.length } }
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
