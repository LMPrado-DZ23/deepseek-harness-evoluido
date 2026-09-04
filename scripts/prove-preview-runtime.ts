import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'
import type { AppSpecV1 } from '../plugins/prompt-to-app/src/appspec.js'
import { writeAcceptanceArtifacts } from '../plugins/prompt-to-app/src/acceptance.js'
import { generateAuthLayer, writeAuthLayer } from '../plugins/prompt-to-app/src/auth-generator.js'
import { generateCrudLayer, writeCrudLayer } from '../plugins/prompt-to-app/src/crud-generator.js'
import { generateDataLayer, writeDataLayer } from '../plugins/prompt-to-app/src/data-generator.js'
import { ContainerBuilder, hashTree, materializePreviewArtifact, OFFLINE_PIPELINE_COMMANDS } from '../plugins/prompt-to-app/src/runner.js'
import { DockerEngine } from '../plugins/preview-supervisor/src/docker-engine.js'
import { DockerPreviewSupervisor } from '../plugins/preview-supervisor/src/docker-manager.js'

const spec: AppSpecV1 = {
  schema_version: 1,
  problem: 'Organizar clientes sem depender de planilhas.',
  audience: 'Equipe de uma pequena empresa',
  journeys: ['Entrar por código e gerenciar clientes'],
  pages: [{ name: 'Clientes', sections: ['Novo cadastro', 'Cadastros'] }],
  entities: [{
    name: 'Cliente', kind: 'database', sensitive: false,
    fields: [
      { name: 'Nome', type: 'text', required: true },
      { name: 'E-mail', type: 'email', required: false },
      { name: 'Situação', type: 'selection', required: true, options: ['Novo', 'Atendido'] },
    ],
  }],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['A equipe consegue criar, editar e excluir um cliente depois de entrar.'],
}

const root = process.cwd()
mkdirSync(resolve(root, 'runtime-artifacts'), { recursive: true, mode: 0o700 })
const proofNonce = randomUUID()
const proofRoot = resolve(root, 'runtime-artifacts', `.p34-preview-proof-${proofNonce}`)
mkdirSync(proofRoot, { recursive: false, mode: 0o700 })
const keepProofRoot = process.env.DZ23_PREVIEW_PROOF_KEEP === '1'
const runDirectory = resolve(proofRoot, 'generated-app')
const socketRoot = resolve(homedir(), `.dz23-pv-${proofNonce.slice(0, 12)}`)
const runtimeImage = readDigest(resolve(root, 'runtime/builder-image-digest'))
const proxyImage = requiredDigest(process.env.DZ23_PREVIEW_PROOF_PROXY_IMAGE)
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
const instanceId = `proof-${randomUUID().slice(0, 12)}`
const previewId = `preview-${randomUUID().slice(0, 12)}`
const ownerEmail = 'owner@example.test'
const engine = new DockerEngine({ socketPath: '/var/run/docker.sock' })
const manager = new DockerPreviewSupervisor({
  engine, artifactRoot: proofRoot, proxySocketRoot: socketRoot,
  proxySocketMount: { type: 'bind', source: socketRoot }, proxyUser: `${uid}:${gid}`,
  runtimeImageDigest: runtimeImage, proxyImageDigest: proxyImage, instanceId,
  diagnosticSink: entry => process.stderr.write(`[${entry.role}] ${entry.output}\n`),
})
let runtimeRef: string | undefined

try {
  await prepareGeneratedApp()
  const builder = new ContainerBuilder({
    engine: 'docker', imageDigest: runtimeImage, templateStore: resolve(root, 'runtime/template-store-v2'), user: `${uid}:${gid}`,
    limits: { pids: 256, memory: '2g', cpus: '2', timeoutMs: 180_000 },
  })
  const preflight = await builder.preflight()
  if (preflight.state !== 'OK') throw new Error(preflight.message)
  for (const command of OFFLINE_PIPELINE_COMMANDS) {
    const result = await builder.execute(runDirectory, command)
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`${command} falhou\n${result.stdout.slice(-4_000)}\n${result.stderr.slice(-4_000)}`)
  }
  const artifact = await materializePreviewArtifact(runDirectory)
  mkdirSync(socketRoot, { recursive: true, mode: 0o770 })
  const started = await manager.start({
    preview_id: previewId, artifact_relative_path: relative(proofRoot, artifact.path).replaceAll('\\', '/'),
    artifact_sha256: artifact.sha256, owner_email: ownerEmail,
  }, AbortSignal.timeout(60_000))
  runtimeRef = started.runtime_ref
  if (await manager.health(runtimeRef, AbortSignal.timeout(10_000)) !== 'OK') throw new Error('RUNTIME_NOT_HEALTHY')

  const rows = await engine.listContainers({ label: [`dz23.instance_id=${instanceId}`] }, AbortSignal.timeout(10_000))
  if (rows.length !== 2) throw new Error(`MANAGED_CONTAINER_COUNT_${rows.length}`)
  const runtime = containerByRole(rows, 'runtime')
  const proxy = containerByRole(rows, 'proxy')
  const runtimeInspect = await engine.inspectContainer<Record<string, unknown>>(stringField(runtime, 'Id'), AbortSignal.timeout(10_000))
  const proxyInspect = await engine.inspectContainer<Record<string, unknown>>(stringField(proxy, 'Id'), AbortSignal.timeout(10_000))
  assertHardened(runtimeInspect, '10001:10001')
  assertHardened(proxyInspect, `${uid}:${gid}`)
  const runtimeId = stringField(runtime, 'Id')
  const runtimeNetworkMode = nestedString(runtimeInspect, 'HostConfig', 'NetworkMode')
  const proxyNetworkMode = nestedString(proxyInspect, 'HostConfig', 'NetworkMode')
  if (runtimeNetworkMode !== 'none') throw new Error(`RUNTIME_NETWORK_MODE_${runtimeNetworkMode}`)
  if (proxyNetworkMode !== `container:${containerName(runtime)}` && proxyNetworkMode !== `container:${runtimeId}`) {
    throw new Error(`PROXY_NETWORK_MODE_${proxyNetworkMode}`)
  }
  assertNoAttachedNetwork(runtimeInspect, 'RUNTIME')
  assertNoAttachedNetwork(proxyInspect, 'PROXY')
  const browserHost = `p-${previewId}.dz23.localhost`

  const forwarded = await manager.forward({ runtime_ref: runtimeRef, method: 'GET', path: '/', headers: { accept: 'text/html' }, body_base64: '' }, AbortSignal.timeout(15_000))
  if (forwarded.status !== 200 || !Buffer.from(forwarded.body_base64, 'base64').toString('utf8').includes('Clientes')) throw new Error('REAL_APP_FORWARD_FAILED')
  const isolation = proveNetworkNamespaceIsolation(runtimeId)
  let message: { readonly code: string }
  try {
    await requestCodeInChromium(`container:${runtimeId}`, browserHost, '127.0.0.1')
    message = await waitForCode()
    await verifyCodeInChromium(`container:${runtimeId}`, browserHost, '127.0.0.1', message.code)
  } catch (error) {
    await emitContainerDiagnostics(stringField(runtime, 'Id'), stringField(proxy, 'Id'))
    throw error
  }

  const events = await manager.logs(runtimeRef, 100)
  if (!events.some(event => recordField(event, '').event === 'ARTIFACT_VERIFIED')) throw new Error('ARTIFACT_EVENT_MISSING')
  await manager.stop(runtimeRef, AbortSignal.timeout(30_000))
  await manager.stop(runtimeRef, AbortSignal.timeout(30_000))
  runtimeRef = undefined
  const survivors = await engine.listContainers({ label: [`dz23.instance_id=${instanceId}`] }, AbortSignal.timeout(10_000))
  if (survivors.length !== 0) throw new Error('MANAGED_CONTAINERS_SURVIVED')
  if (dockerJson(['network', 'ls', '--filter', `label=dz23.instance_id=${instanceId}`, '--format', '{{json .}}']).length !== 0) throw new Error('MANAGED_NETWORK_SURVIVED')

  const proof = {
    result: 'PASS', instance_id: instanceId, preview_id: previewId,
    runtime_image: runtimeImage, proxy_image: proxyImage, artifact_sha256: artifact.sha256,
    network_mode: 'none+shared-loopback', interfaces: isolation.interfaces, external_routes: isolation.externalRoutes,
    probes_blocked: isolation.probes, runtime_hardened: true, proxy_hardened: true,
    root_forward_status: forwarded.status, host_and_egress: 'BLOCKED', passwordless_login: 'PASS', cleanup: 'PASS',
  }
  mkdirSync(resolve(root, 'runtime-artifacts'), { recursive: true })
  writeFileSync(resolve(root, 'runtime-artifacts/P34-M1-runtime-proof.json'), `${JSON.stringify(proof, null, 2)}\n`)
  process.stdout.write(`PREVIEW_RUNTIME_PROOF=PASS artifact=${artifact.sha256} runtime=${runtimeImage} proxy=${proxyImage}\n`)
} finally {
  if (runtimeRef !== undefined) await manager.stop(runtimeRef, AbortSignal.timeout(30_000)).catch(() => undefined)
  if (keepProofRoot) process.stderr.write(`PREVIEW_PROOF_ROOT=${proofRoot}\n`)
  else rmSync(proofRoot, { recursive: true, force: true })
  rmSync(socketRoot, { recursive: true, force: true })
}

async function prepareGeneratedApp(): Promise<void> {
  cpSync(resolve(root, 'templates/nextjs-app@1'), runDirectory, { recursive: true })
  mkdirSync(resolve(runDirectory, 'content'), { recursive: true })
  mkdirSync(resolve(runDirectory, 'src/styles'), { recursive: true })
  writeFileSync(resolve(runDirectory, 'src/styles/tokens.css'), ':root { --background: 0 0% 100%; --foreground: 222 47% 11%; --card: 0 0% 100%; --card-foreground: 222 47% 11%; --primary: 222 72% 32%; --primary-foreground: 0 0% 100%; --secondary: 214 32% 91%; --secondary-foreground: 222 47% 11%; --muted: 210 40% 96%; --muted-foreground: 215 16% 40%; --accent: 214 100% 93%; --accent-foreground: 222 72% 26%; --destructive: 0 72% 45%; --border: 214 32% 88%; --input: 214 32% 88%; --ring: 217 91% 50%; --radius: 0.75rem; --font-body: sans-serif; }\n')
  writeFileSync(resolve(runDirectory, 'content/app.json'), '{"title":"Clientes","description":"Gestão protegida por código de acesso"}\n')
  writeFileSync(resolve(runDirectory, 'src/GeneratedApp.tsx'), "import ClientePanel from '@/src/components/generated/cliente-panel'\nexport default function GeneratedApp(){return <main><h1>Clientes</h1><p>Cliente</p><p>Novo cadastro</p><p>Cadastros</p><ClientePanel /></main>}\n")
  const data = generateDataLayer(spec); const auth = generateAuthLayer(spec, 'crud-panel'); const crud = generateCrudLayer(spec, 'crud-panel')
  await writeDataLayer(runDirectory, data); await writeAuthLayer(runDirectory, auth); await writeCrudLayer(runDirectory, crud); await writeAcceptanceArtifacts(runDirectory, spec, 'crud-panel')
}

async function requestCodeInChromium(network: string, host: string, hostIp: string): Promise<void> {
  runBrowser(network, host, hostIp, `const {chromium}=await import('file:///workspace/node_modules/@playwright/test/index.mjs');const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP '+process.env.PREVIEW_HOST+' '+process.env.PREVIEW_IP]});const context=await browser.newContext();const page=await context.newPage();await page.goto(process.env.PREVIEW_URL);const denied=await page.evaluate(()=>fetch('/api/auth/session').then(r=>r.status));if(denied!==401)throw new Error('SESSION_NOT_401');await page.getByTestId('request-code-form').locator('[name=email]').fill('${ownerEmail}');const responsePromise=page.waitForResponse(response=>response.request().method()==='POST');await page.getByTestId('request-code-form').getByRole('button',{name:'Enviar código'}).click();const response=await responsePromise;if(!response.ok())throw new Error('REQUEST_CODE_HTTP_'+response.status());await page.waitForTimeout(500);const cookies=await context.cookies();if(!cookies.some(cookie=>cookie.name==='dz23_app_code_request'))throw new Error('REQUEST_COOKIE_NOT_STORED');await context.storageState({path:'/workspace/evidence/preview-runtime-state.json'});await browser.close();`)
}

async function verifyCodeInChromium(network: string, host: string, hostIp: string, code: string): Promise<void> {
  runBrowser(network, host, hostIp, `const {chromium}=await import('file:///workspace/node_modules/@playwright/test/index.mjs');const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP '+process.env.PREVIEW_HOST+' '+process.env.PREVIEW_IP]});const context=await browser.newContext({storageState:'/workspace/evidence/preview-runtime-state.json'});const page=await context.newPage();await page.goto(process.env.PREVIEW_URL);await page.getByTestId('verify-code-form').locator('[name=email]').fill('${ownerEmail}');await page.getByTestId('verify-code-form').locator('[name=code]').fill(process.env.PREVIEW_CODE);await page.getByTestId('verify-code-form').getByRole('button',{name:'Entrar'}).click();await page.getByTestId('signed-in-user').waitFor();const allowed=await page.evaluate(()=>fetch('/api/auth/session').then(r=>r.status));if(allowed!==200)throw new Error('SESSION_NOT_200');await browser.close();`, code)
}

function runBrowser(network: string, host: string, hostIp: string, source: string, code?: string): void {
  const args = ['run', '--rm', '--network', network, '--user', `${uid}:${gid}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--pids-limit', '256', '--memory', '1g', '--cpus', '1', '--mount', `type=bind,src=${runDirectory},dst=/workspace`, '--workdir', '/workspace', '--env', `PREVIEW_URL=http://${host}:3000`, '--env', `PREVIEW_HOST=${host}`, '--env', `PREVIEW_IP=${hostIp}`, ...(code === undefined ? [] : ['--env', 'PREVIEW_CODE']), runtimeImage, 'node', '--input-type=module', '-e', source]
  execFileSync('docker', args, {
    stdio: 'pipe',
    timeout: 60_000,
    env: code === undefined ? process.env : { ...process.env, PREVIEW_CODE: code },
  })
}

async function waitForCode(): Promise<{ readonly code: string }> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const messages = await manager.verificationMessages(runtimeRef!, AbortSignal.timeout(5_000)) as Array<{ code?: unknown; email?: unknown }>
    const found = messages.find(message => message.email === ownerEmail && typeof message.code === 'string')
    if (found !== undefined) return { code: found.code as string }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error('VERIFICATION_CODE_NOT_CAPTURED')
}

async function emitContainerDiagnostics(runtimeId: string, proxyId: string): Promise<void> {
  for (const [role, id] of [['runtime', runtimeId], ['proxy', proxyId]] as const) {
    const raw = await engine.containerLogs(id, AbortSignal.timeout(5_000)).catch(error => String(error))
    const safe = raw.slice(-8_000).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]').replace(/\b\d{6}\b/gu, '[code]')
    process.stderr.write(`[proof-${role}] ${safe}\n`)
    const capturePath = `/preview-storage/data/${previewId}/preview-capture.json`
    const source = `const fs=require('node:fs');const paths=['/preview-storage','/preview-storage/data',${JSON.stringify(`/preview-storage/data/${previewId}`)},${JSON.stringify(capturePath)}];const rows=paths.map(path=>{try{const stat=fs.lstatSync(path);return {path,kind:stat.isDirectory()?'dir':stat.isFile()?'file':'other',uid:stat.uid,gid:stat.gid,mode:(stat.mode&0o777).toString(8),size:stat.size}}catch(error){return {path,error:error.code}}});console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),emailMode:process.env.APP_EMAIL_MODE,previewId:process.env.DZ23_PREVIEW_ID,rows}))`
    try {
      const metadata = execFileSync('docker', ['exec', id, 'node', '-e', source], { encoding: 'utf8', timeout: 5_000 })
      process.stderr.write(`[proof-${role}-capture] ${metadata}`)
    } catch (error) { process.stderr.write(`[proof-${role}-capture] ${String(error)}\n`) }
  }
}

function proveNetworkNamespaceIsolation(container: string): { readonly interfaces: readonly string[]; readonly externalRoutes: number; readonly probes: readonly string[] } {
  const source = `const fs=require('node:fs'),os=require('node:os'),dns=require('node:dns/promises');const interfaces=Object.keys(os.networkInterfaces());const v4=fs.readFileSync('/proc/net/route','utf8').trim().split(/\\n/u).slice(1).filter(Boolean);const v6=fs.readFileSync('/proc/net/ipv6_route','utf8').trim().split(/\\n/u).filter(line=>line.trim()&&line.trim().split(/\\s+/u).at(-1)!=='lo');const probes=['http://1.1.1.1','http://169.254.169.254','http://host.docker.internal','http://127.0.0.1:3210'];Promise.all(probes.map(async url=>{try{await fetch(url,{signal:AbortSignal.timeout(800)});return {url,blocked:false}}catch(error){return {url,blocked:true,code:error&&error.cause&&error.cause.code||error&&error.code||'ERROR'}}})).then(async rows=>{let dnsBlocked=false;try{await dns.lookup('example.com')}catch{dnsBlocked=true}console.log(JSON.stringify({interfaces,externalRoutes:v4.length+v6.length,rows,dnsBlocked}))})`
  const result = spawnSync('docker', ['exec', container, 'node', '-e', source], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error(`NETWORK_ISOLATION_PROBE_FAILED:${String(result.stderr)}`)
  const row = JSON.parse(result.stdout.trim()) as { interfaces?: unknown; externalRoutes?: unknown; rows?: unknown; dnsBlocked?: unknown }
  const interfaces = Array.isArray(row.interfaces) ? row.interfaces.filter((value): value is string => typeof value === 'string') : []
  const probes = Array.isArray(row.rows) ? row.rows as Array<{ url?: unknown; blocked?: unknown }> : []
  if (interfaces.length !== 1 || interfaces[0] !== 'lo') throw new Error(`NETWORK_INTERFACE_PRESENT:${interfaces.join(',')}`)
  if (row.externalRoutes !== 0) throw new Error(`NETWORK_ROUTE_PRESENT:${String(row.externalRoutes)}`)
  if (row.dnsBlocked !== true || probes.length !== 4 || probes.some(probe => probe.blocked !== true)) throw new Error('NETWORK_DESTINATION_REACHABLE')
  return { interfaces, externalRoutes: 0, probes: probes.map(probe => String(probe.url)) }
}

function assertHardened(inspect: Record<string, unknown>, user: string): void {
  const config = recordField(inspect, 'Config'); const host = recordField(inspect, 'HostConfig')
  if (config.User !== user || host.ReadonlyRootfs !== true || host.Privileged !== false || host.PublishAllPorts !== false) throw new Error('CONTAINER_NOT_HARDENED')
  if (JSON.stringify(host.CapDrop) !== '["ALL"]' || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges')) throw new Error('CONTAINER_SECURITY_OPTIONS_INVALID')
  if (Object.keys(recordField(host, 'PortBindings')).length !== 0) throw new Error('CONTAINER_PORT_EXPOSED')
}

function assertNoAttachedNetwork(inspect: Record<string, unknown>, role: string): void {
  // Docker represents NetworkMode=none with a synthetic `none` row. It is
  // acceptable only while no ordinary network, address, or gateway exists.
  const networks = recordField(recordField(inspect, 'NetworkSettings'), 'Networks')
  const entries = Object.entries(networks)
  if (entries.length > 1 || entries.some(([name, value]) => {
    const network = recordField(value, '')
    return name !== 'none'
      || String(network.IPAddress ?? '') !== ''
      || String(network.Gateway ?? '') !== ''
  })) throw new Error(`${role}_NETWORK_ATTACHED`)
}

function containerByRole(rows: readonly Record<string, unknown>[], role: string): Record<string, unknown> {
  const row = rows.find(item => recordField(item, 'Labels')['dz23.role'] === role)
  if (row === undefined) throw new Error(`CONTAINER_ROLE_MISSING_${role}`)
  return row
}
function containerName(row: Record<string, unknown>): string {
  const names = row.Names
  const first = Array.isArray(names) ? names.find(value => typeof value === 'string') : undefined
  if (typeof first !== 'string') throw new Error('DOCKER_FIELD_Names')
  return first.replace(/^\//u, '')
}
function recordField(value: unknown, field: string): Record<string, unknown> { const row = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}; const item = field === '' ? row : row[field]; return typeof item === 'object' && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : {} }
function stringField(value: Record<string, unknown>, field: string): string { const item = value[field]; if (typeof item !== 'string') throw new Error(`DOCKER_FIELD_${field}`); return item }
function nestedString(value: Record<string, unknown>, parent: string, field: string): string { return stringField(recordField(value, parent), field) }
function dockerJson(args: readonly string[]): unknown[] { const output = execFileSync('docker', args, { encoding: 'utf8' }).trim(); if (output === '') return []; return args.includes('--format') ? output.split(/\r?\n/u).map(line => JSON.parse(line) as unknown) : JSON.parse(output) as unknown[] }
function readDigest(path: string): `sha256:${string}` { return requiredDigest(readFileSync(path, 'utf8').trim()) }
function requiredDigest(value: string | undefined): `sha256:${string}` { if (value === undefined || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error('PINNED_IMAGE_DIGEST_REQUIRED'); return value as `sha256:${string}` }
