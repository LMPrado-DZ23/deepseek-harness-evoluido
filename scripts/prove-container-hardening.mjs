#!/usr/bin/env node
/**
 * S-15 / P-09 — o endurecimento do contêiner, EXECUTADO contra o Docker real.
 *
 * O que `prove-builder-isolation.mjs` faz e este não substitui: aquele roda a
 * IMAGEM DO CONSTRUTOR de verdade, e por isso depende de construí-la. Esta
 * prova responde a outra pergunta, e é a pergunta de segurança:
 *
 *   as opções que o produto manda para o Docker são REALMENTE aplicadas, e o
 *   que elas prometem impedir é REALMENTE impedido?
 *
 * A diferença importa porque uma opção pode estar escrita, ser aceita sem erro
 * e não fazer nada — foi exatamente isso que aconteceu no A-06, onde
 * `deny: ['network']` nomeava uma ferramenta inexistente e o filtro não
 * filtrava. Uma opção mal escrita aqui teria o mesmo destino: o Docker aceita
 * o corpo, o contêiner sobe, e ninguém descobre que a rede estava aberta.
 *
 * Por isso a prova IMPORTA `hardenedHost` do produto em vez de redigitar as
 * opções: redigitar provaria a cópia, não o que o produto manda.
 *
 * A imagem usada é uma base local qualquer, e é de propósito: o que está sob
 * prova é o CONFINAMENTO, não o conteúdo da imagem. Se o confinamento vale para
 * uma imagem arbitrária, vale para a do construtor.
 *
 * `--self-test` sobe um contêiner DELIBERADAMENTE ENFRAQUECIDO e exige que
 * esta prova o reprove. Sem isso, uma prova que só passa não diz nada: ela
 * poderia estar passando por não olhar.
 *
 * Uso: node scripts/prove-container-hardening.mjs [--self-test]
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.cwd())
// O FONTE, não o `lib/`.
//
// A prova importava `plugins/builder-supervisor/lib/docker-adapter.js` — a saída
// de build, ignorada pelo Git — enquanto anunciava `src/docker-adapter.ts` como
// origem. Uma auditoria reescreveu `hardenedHost` no FONTE para bridge, rootfs
// gravável e nenhuma capacidade derrubada, e a prova continuou dizendo GO: ela
// estava provando um artefato velho. Agora ela lê o mesmo arquivo que a pessoa
// revisa, com o removedor de tipos do Node.
const SOURCE = 'plugins/builder-supervisor/src/docker-adapter.ts'
const { hardenedHost } = await import(pathToFileURL(join(root, SOURCE)).href)

/** Os mesmos tetos que o produto usa por padrão. */
const LIMITS = { pids: 256, memoryBytes: 1_073_741_824, nanoCpus: 1_000_000_000 }

/** Uma base já presente localmente. O que está sob prova é o confinamento, não a imagem. */
const IMAGE = 'node:22.23.1-bookworm-slim'

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

function must(args) {
  const answer = docker(args)
  assert.equal(answer.status, 0, `docker ${args.slice(0, 3).join(' ')}: ${answer.stderr || answer.stdout}`)
  return answer.stdout
}

/** Traduz o corpo da API do Docker para as opções de linha de comando equivalentes. */
function commandFlags(host) {
  const flags = []
  flags.push('--network', host.NetworkMode)
  if (host.ReadonlyRootfs) flags.push('--read-only')
  for (const capability of host.CapDrop) flags.push('--cap-drop', capability)
  for (const option of host.SecurityOpt) flags.push('--security-opt', option)
  flags.push('--pids-limit', String(host.PidsLimit))
  flags.push('--memory', String(host.Memory))
  flags.push('--cpus', String(host.NanoCpus / 1_000_000_000))
  flags.push('--ipc', host.IpcMode)
  flags.push('--shm-size', String(host.ShmSize))
  for (const [target, options] of Object.entries(host.Tmpfs)) flags.push('--tmpfs', `${target}:${options}`)
  for (const ulimit of host.Ulimits) flags.push('--ulimit', `${ulimit.Name}=${ulimit.Soft}:${ulimit.Hard}`)
  return flags
}

/**
 * Roda a bateria contra UM contêiner e devolve os achados.
 * @param flags - as opções de linha de comando.
 * @param label - o nome do contêiner, para o Docker.
 * @returns os achados e o que o Docker declarou ter aplicado.
 */
function inspectContainer(flags, label) {
  const workspace = mkdtempSync(join(tmpdir(), 'dz23-hardening-'))
  const name = `dz23-hardening-${label}-${Date.now()}`
  const findings = []
  try {
    must(['run', '--detach', '--name', name, ...flags,
      '--user', '10001:10001', '--workdir', '/workspace',
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
      IMAGE, 'sh', '-lc', 'sleep 180'])
    const inspected = JSON.parse(must(['inspect', name]))[0]
    const applied = inspected.HostConfig
    const inside = (script) => docker(['exec', name, 'sh', '-lc', script])

    if (applied.NetworkMode !== 'none') findings.push(`NetworkMode declarado ${String(applied.NetworkMode)}`)
    if (applied.ReadonlyRootfs !== true) findings.push('ReadonlyRootfs não foi aplicado')
    if (applied.Privileged !== false) findings.push('o contêiner subiu privilegiado')
    if ((applied.CapDrop ?? []).join(',') !== 'ALL') findings.push(`CapDrop declarado ${String(applied.CapDrop)}`)
    if ((applied.SecurityOpt ?? []).join(',') !== 'no-new-privileges') findings.push(`SecurityOpt declarado ${String(applied.SecurityOpt)}`)
    if (applied.PidsLimit !== LIMITS.pids) findings.push(`PidsLimit declarado ${String(applied.PidsLimit)}`)
    if (applied.Memory !== LIMITS.memoryBytes) findings.push(`Memory declarado ${String(applied.Memory)}`)
    if (applied.NanoCpus !== LIMITS.nanoCpus) findings.push(`NanoCpus declarado ${String(applied.NanoCpus)}`)
    if (applied.IpcMode !== 'private') findings.push(`IpcMode declarado ${String(applied.IpcMode)}`)

    const identity = inside('id -u').stdout
    if (identity !== '10001') findings.push(`o processo roda como uid ${identity}, e não 10001`)
    const rootWrite = inside('touch /provaS15 2>&1; echo RC=$?')
    if (!rootWrite.stdout.includes('RC=1')) findings.push(`a raiz aceitou escrita: ${rootWrite.stdout}`)
    // O `noexec` do /tmp é conferido nas OPÇÕES DE MONTAGEM, e não tentando
    // executar: neste kernel a execução a partir dessa tmpfs é recusada com ou
    // sem `noexec`, então "não executou" não distinguiria nada — passaria
    // igual com a opção ausente, que é o defeito que uma prova não pode ter.
    // A linha de /proc/mounts distingue, e é o que a opção realmente liga.
    const tmpMount = inside("awk '$2==\"/tmp\"{print $4}' /proc/mounts").stdout.trim()
    if (!tmpMount.split(',').includes('noexec')) findings.push(`o /tmp não está noexec: ${tmpMount || '(sem linha em /proc/mounts)'}`)
    if (!tmpMount.split(',').includes('nosuid')) findings.push(`o /tmp não está nosuid: ${tmpMount || '(sem linha em /proc/mounts)'}`)
    // E a tentativa de executar continua, como segunda tranca: se um dia o
    // kernel deixar de recusar por conta própria, é `noexec` que tem de recusar.
    const tmpExec = inside('printf "#!/bin/sh\\necho executou\\n" > /tmp/p.sh && chmod +x /tmp/p.sh && /tmp/p.sh 2>&1; echo RC=$?')
    if (tmpExec.stdout.includes('executou')) findings.push('o /tmp executou um script — noexec não valeu')
    const capability = inside('chown 0:0 /workspace 2>&1; echo RC=$?')
    if (capability.stdout.includes('RC=0')) findings.push('o contêiner conseguiu chown — CapDrop ALL não valeu')
    const network = inside("node -e \"const http=require('node:http');let done=false;const finish=(blocked)=>{if(done)return;done=true;console.log(blocked?'BLOQUEADA':'ALCANCAVEL');process.exit(0)};const r=http.get({host:'1.1.1.1',port:80,timeout:1500},()=>finish(false));r.on('timeout',()=>{r.destroy();finish(true)});r.on('error',()=>finish(true));setTimeout(()=>finish(true),2500)\"")
    if (network.stdout.trim() !== 'BLOQUEADA') findings.push(`a rede não foi bloqueada: ${network.stdout}`)
    const interfaces = inside('ls /sys/class/net').stdout.split(/\s+/u).filter(Boolean).sort()
    if (interfaces.join(',') !== 'lo') findings.push(`o contêiner enxerga interfaces além do loopback: ${interfaces.join(', ')}`)
    const socket = inside('test -S /var/run/docker.sock && echo PRESENTE || echo AUSENTE').stdout.trim()
    if (socket !== 'AUSENTE') findings.push('o socket do Docker está DENTRO do contêiner')
    const noNewPrivs = inside('grep -m1 NoNewPrivs /proc/1/status').stdout.trim()
    if (!noNewPrivs.endsWith('1')) findings.push(`no-new-privileges não está ativo: ${noNewPrivs}`)
    const capEff = inside('grep -m1 CapEff /proc/1/status').stdout.trim()
    if (!/CapEff:\s+0+$/u.test(capEff)) findings.push(`o processo mantém capacidades: ${capEff}`)
    return findings
  } finally {
    docker(['rm', '--force', name])
    if (workspace.startsWith(`${resolve(tmpdir())}/`)) rmSync(workspace, { recursive: true, force: true })
  }
}

const host = hardenedHost(LIMITS, [])
const findings = inspectContainer(commandFlags(host), 'real')

if (process.argv.includes('--self-test')) {
  // Cada enfraquecimento tem de produzir pelo menos um achado. Uma prova que
  // passa e nunca reprova nada pode estar passando por nao olhar.
  const weakened = [
    ['sem --read-only', commandFlags(host).filter((value, index, all) => value !== '--read-only' && all[index] !== '--read-only')],
    ['com a rede da ponte', commandFlags(host).map(value => value === 'none' ? 'bridge' : value)],
    ['sem cap-drop', dropPair(commandFlags(host), '--cap-drop')],
    ['sem no-new-privileges', dropPair(commandFlags(host), '--security-opt')],
    // NAO ha caso de "/tmp executavel" aqui, e a ausencia e deliberada: o
    // Docker acrescenta `noexec` a toda tmpfs por conta propria, e tirar a
    // opcao da nossa linha nao muda /proc/mounts (conferido: sem `noexec` na
    // opcao, a montagem sai com `noexec` mesmo assim). Ou seja, a propriedade
    // NAO pode ser enfraquecida por essa alavanca, e um caso negativo aqui
    // reprovaria sempre por um motivo que nao e o nosso. Quem acrescentar esse
    // caso de volta vai ver o self-test falhar sem que nada esteja errado.
  ]
  const missed = []
  for (const [label, flags] of weakened) {
    const caught = inspectContainer(flags, 'weak')
    if (caught.length === 0) missed.push(label)
  }
  if (missed.length > 0) {
    process.stdout.write(`CONTAINER_HARDENING_SELF_TEST=FAIL nao reprovou: ${missed.join('; ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`CONTAINER_HARDENING_SELF_TEST=PASS enfraquecimentos=${String(weakened.length)}\n`)
}

/** Remove um par `--opcao valor` da lista de opcoes. */
function dropPair(flags, option) {
  const result = []
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === option) { index += 1; continue }
    result.push(flags[index])
  }
  return result
}

if (findings.length > 0) {
  process.stdout.write(`CONTAINER_HARDENING=FAIL\n${findings.map(line => `- ${line}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify({
  decision: 'GO',
  engine: execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim(),
  image: IMAGE,
  source: `${SOURCE} hardenedHost()`,
  declared: 'NetworkMode=none ReadonlyRootfs CapDrop=ALL no-new-privileges IpcMode=private PidsLimit Memory NanoCpus tmpfs(noexec,nosuid)',
  enforced: {
    uid: 10001, rootfsWrite: 'REFUSED', tmpExec: 'REFUSED', chown: 'REFUSED',
    network: 'BLOCKED', interfaces: 'lo', dockerSocket: 'ABSENT', noNewPrivs: 1, capEff: 0,
  },
  note: 'imagem base local de proposito: o que esta sob prova e o CONFINAMENTO, nao o conteudo da imagem',
}, null, 2)}\n`)
