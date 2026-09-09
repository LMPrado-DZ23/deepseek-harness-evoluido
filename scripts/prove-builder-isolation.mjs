import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const digest = readFileSync(resolve(root, 'runtime/builder-image-digest'), 'utf8').trim()
if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error('Digest da imagem ausente ou inválido.')

const trustStore = '/etc/ssl/certs/ca-certificates.crt'
const trustBefore = sha256(readFileSync(trustStore))
const proofRoot = mkdtempSync(join(tmpdir(), 'dz23-builder-proof-'))
const workspace = resolve(proofRoot, 'workspace')
mkdirSync(workspace)
const templateStore = resolve(root, 'runtime/template-store-v2')
const name = `dz23-builder-proof-${randomUUID()}`
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000

/**
 * As opções de segurança vêm do PRODUTO, e não desta prova.
 *
 * Elas eram redigitadas aqui, à mão. Uma prova assim aprova a CÓPIA: o dia em
 * que `hardenedHost` deixasse de mandar `--network none`, este arquivo
 * continuaria verde dizendo que o construtor não alcança a rede. É a mesma
 * classe de erro que a prova de endurecimento já denunciava no próprio
 * cabeçalho — e ela mesma cometia, importando o `lib/` em vez do `src/`.
 */
const { hardenedHost } = await import(pathToFileURL(resolve(root, 'plugins/builder-supervisor/src/docker-adapter.ts')).href)
const host = hardenedHost({ pids: 256, memoryBytes: 1_073_741_824, nanoCpus: 1_000_000_000 }, [])

const securityArgs = [
  ...productFlags(host),
  // O ÚNICO desvio do produto, e ele é do ambiente da prova, não da política:
  // em produção o contêiner roda como 10001, dono do `/tmp` que o produto cria;
  // aqui o `/workspace` montado pertence a quem roda a prova, e um contêiner
  // com outro dono não conseguiria escrever nele. O `/tmp` do produto é
  // traduzido com o mesmo dono, por isso, logo abaixo.
  '--user', `${uid}:${gid}`,
  '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/.config', '--env', 'CI=true',
  '--mount', `type=bind,src=${workspace},dst=/workspace`,
  '--mount', `type=bind,src=${templateStore},dst=/template-store,readonly`,
  '--workdir', '/workspace',
]

/**
 * A configuração do produto traduzida para linha de comando do Docker.
 * @param value - o `HostConfig` que `hardenedHost` devolve.
 * @returns as opções equivalentes.
 */
function productFlags(value) {
  const flags = ['--network', value.NetworkMode]
  if (value.ReadonlyRootfs) flags.push('--read-only')
  for (const capability of value.CapDrop) flags.push('--cap-drop', capability)
  for (const option of value.SecurityOpt) flags.push('--security-opt', option)
  flags.push('--pids-limit', String(value.PidsLimit))
  flags.push('--memory', String(value.Memory))
  flags.push('--cpus', String(value.NanoCpus / 1_000_000_000))
  flags.push('--shm-size', String(value.ShmSize))
  if (value.IpcMode !== undefined && value.IpcMode !== '') flags.push('--ipc', value.IpcMode)
  for (const [target, options] of Object.entries(value.Tmpfs ?? {})) {
    flags.push('--tmpfs', `${target}:${options.replace(/uid=\d+/u, `uid=${uid}`).replace(/gid=\d+/u, `gid=${gid}`)}`)
  }
  for (const ulimit of value.Ulimits ?? []) flags.push('--ulimit', `${ulimit.Name}=${ulimit.Soft}:${ulimit.Hard}`)
  return flags
}

let inspection
let networkAttempt = ''
try {
  run('docker', ['run', '--detach', '--name', name, ...securityArgs, digest, 'sh', '-lc', 'sleep 120'])
  inspection = JSON.parse(run('docker', ['inspect', name]))[0]
  networkAttempt = run('docker', [
    'exec', name, 'node', '-e',
    "const http=require('node:http');let done=false;const finish=(ok)=>{if(done)return;done=true;console.log(ok?'NETWORK_BLOCKED':'NETWORK_REACHABLE');process.exit(ok?0:1)};const r=http.get({host:'203.0.113.1',port:80,timeout:1500},()=>finish(false));r.on('timeout',()=>r.destroy(new Error('timeout')));r.on('error',()=>finish(true));setTimeout(()=>finish(true),2500)",
  ]).trim()
} finally {
  try { run('docker', ['rm', '--force', name]) } catch {}
  if (proofRoot.startsWith(`${resolve(tmpdir())}/`) || proofRoot.startsWith(`${resolve(tmpdir())}\\`)) rmSync(proofRoot, { recursive: true, force: true })
}

const trustAfter = sha256(readFileSync(trustStore))
const mounts = inspection.Mounts.map(mount => ({ destination: mount.Destination, mode: mount.Mode, rw: mount.RW, source: mount.Source }))
const checks = {
  networkModeNone: inspection.HostConfig.NetworkMode === 'none',
  connectionBlockedInside: networkAttempt === 'NETWORK_BLOCKED',
  privilegedFalse: inspection.HostConfig.Privileged === false,
  capDropAll: inspection.HostConfig.CapDrop?.includes('ALL') === true,
  noNewPrivileges: inspection.HostConfig.SecurityOpt?.includes('no-new-privileges') === true,
  readOnlyRoot: inspection.HostConfig.ReadonlyRootfs === true,
  privateSharedMemory: inspection.HostConfig.IpcMode === 'private' && inspection.HostConfig.ShmSize === 268435456,
  nonRootUser: inspection.Config.User === `${uid}:${gid}` && uid !== 0,
  ephemeralHome: inspection.Config.Env.includes('HOME=/tmp') && inspection.Config.Env.includes('XDG_CONFIG_HOME=/tmp/.config') && inspection.Config.Env.includes('CI=true'),
  workspaceOnlyWritableMount: mounts.filter(mount => mount.rw).length === 1 && mounts.some(mount => mount.destination === '/workspace' && mount.rw),
  templateStoreReadOnly: mounts.some(mount => mount.destination === '/template-store' && !mount.rw),
  noDockerSocketMount: mounts.every(mount => !mount.source.includes('docker.sock') && !mount.destination.includes('docker.sock')),
  noTrustStoreMount: mounts.every(mount => !mount.source.includes('/etc/ssl') && !mount.destination.includes('/etc/ssl')),
  hostTrustStoreUnchanged: trustBefore === trustAfter,
}
const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length > 0) throw new Error(`Prova de isolamento falhou: ${failed.join(', ')}`)

const report = `# P32 — Prova executável do isolamento do construtor\n\n` +
  `- Resultado: **PASS**\n` +
  `- Imagem: \`${digest}\`\n` +
  `- NetworkMode: \`${inspection.HostConfig.NetworkMode}\`\n` +
  `- Tentativa de conexão dentro do contêiner: \`${networkAttempt}\`\n` +
  `- Usuário: \`${inspection.Config.User}\`\n` +
  `- Privileged: \`${inspection.HostConfig.Privileged}\`\n` +
  `- CapDrop: \`${inspection.HostConfig.CapDrop.join(',')}\`\n` +
  `- SecurityOpt: \`${inspection.HostConfig.SecurityOpt.join(',')}\`\n` +
  `- Raiz somente leitura: \`${inspection.HostConfig.ReadonlyRootfs}\`\n` +
  `- Montagens: workspace gravável e template-store somente leitura; sem docker.sock e sem trust store.\n` +
  `- SHA-256 do trust store do host antes/depois: \`${trustBefore}\` / \`${trustAfter}\` (idênticos).\n\n` +
  `A prova criou um contêiner descartável sem rede, inspecionou a configuração real com \`docker inspect\`, tentou conexão HTTP de dentro e removeu o contêiner ao final.\n`
mkdirSync(resolve(root, 'docs/proofs'), { recursive: true })
writeFileSync(resolve(root, 'docs/proofs/P32-builder-isolation-proof.md'), report)
process.stdout.write('BUILDER_ISOLATION_PROOF=PASS\n')

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
