#!/usr/bin/env node
/**
 * C-24 — o Harness em LOOPBACK, provado no soquete real.
 *
 * O requisito tem duas metades. Esta prova responde a primeira, que é a que
 * protege sozinha: **o Studio só aceita conexão de dentro da própria máquina**.
 * A segunda — "acesso externo só pela borda autenticada" — depende do Caddy
 * rodando, e continua sem execução por outro motivo, registrado no S-04.
 *
 * O que se prova aqui não é a linha do `docker-compose.yml`. Uma configuração
 * correta é uma afirmação; o soquete é um fato. A diferença aparece quando
 * alguém troca `--host` por um padrão diferente, quando uma versão do Harness
 * passa a ignorar o parâmetro, ou quando o servidor abre um segundo soquete que
 * ninguém pediu. Nenhum desses casos muda o YAML.
 *
 * As três perguntas:
 *
 * 1. o soquete que escuta está em 127.0.0.1, e NÃO em 0.0.0.0 nem em `::`;
 * 2. uma conexão pelo loopback FUNCIONA — senão a prova estaria celebrando um
 *    servidor que não subiu;
 * 3. uma conexão pelo endereço NÃO-loopback da própria máquina é RECUSADA. É
 *    esta que distingue: com `--host 0.0.0.0` ela passaria.
 *
 * `--self-test` sobe o MESMO servidor com `--host 0.0.0.0` e exige que esta
 * prova o REPROVE. Sem esse caso a prova poderia estar passando por nao olhar.
 *
 * Uso: node scripts/prove-loopback-binding.mjs [--self-test]
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const studioRoot = resolve(process.cwd())
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? join(studioRoot, 'third_party', 'deepseek-harness'))
const profile = join(studioRoot, 'dsh-home', 'profiles', 'studio')

assert.equal(process.platform, 'linux', 'a prova de loopback roda em Linux')
assert.ok(existsSync(join(upstreamRoot, '.git')), `upstream ausente: ${upstreamRoot}`)

const runtimeParent = join(studioRoot, 'runtime')
await mkdir(runtimeParent, { recursive: true })
const runtimeRoot = await mkdtemp(join(runtimeParent, 'loopback-proof-'))

/** O primeiro endereço IPv4 desta máquina que NÃO é loopback. Sem ele, a pergunta 3 não existe. */
function externalAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

/** As linhas de escuta de /proc/net/tcp, já com o endereço em forma legível. */
function listeningSockets() {
  const rows = []
  for (const [file, ipv6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/u)
      if (columns.length < 4 || columns[3] !== '0A') continue
      const [hex, portHex] = columns[1].split(':')
      rows.push({ address: ipv6 ? ipv6Address(hex) : ipv4Address(hex), port: Number.parseInt(portHex, 16) })
    }
  }
  return rows
}
function ipv4Address(hex) {
  return [0, 2, 4, 6].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).reverse().join('.')
}
function ipv6Address(hex) {
  const groups = []
  for (let index = 0; index < 32; index += 4) groups.push(hex.slice(index, index + 4).toLowerCase())
  return groups.join(':')
}

const selfTest = process.argv.includes('--self-test')

/**
 * Sobe o servidor com UM endereco e responde as tres perguntas.
 * @param host - o endereco passado ao Harness.
 * @returns os achados e o retrato do que foi observado.
 */
async function probe(host) {
let app
const findings = []
try {
  const dshHome = join(runtimeRoot, 'dsh-home')
  const profileLink = join(dshHome, 'profiles', 'studio')
  await mkdir(dirname(profileLink), { recursive: true })
  if (!existsSync(profileLink)) await symlink(profile, profileLink, 'dir')
  process.env.DSH_HOME = dshHome
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DZ23_AGENT_WORKTREE_ROOT = join(runtimeRoot, 'agent-worktrees')
  process.env.DZ23_COORDINATOR_PRESET_ROOT = join(studioRoot, 'dsh-home', '.agent-presets')
  process.env.DZ23_OLLAMA_PLACEHOLDER = 'ollama-local-placeholder-not-a-secret'

  const moduleAt = relative => import(pathToFileURL(join(upstreamRoot, relative)).href)
  const cliBin = readFileSync(join(upstreamRoot, 'apps/cli/lib/bin.js'), 'utf8')
  const chunk = cliBin.match(/import\("\.\/(profile-boot-[^"]+\.js)"\)/)?.[1]
  assert.ok(chunk, 'o CLI construído não expõe o boot de perfil')
  const [{ loadLayeredEnv }, { runProfile }] = await Promise.all([
    moduleAt('packages/boot/app-boot/lib/index.js'),
    moduleAt(`apps/cli/lib/${chunk}`),
  ])

  const before = new Set(listeningSockets().map(row => `${row.address}:${String(row.port)}`))
  const originalLog = console.log
  let announced
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: http://')) { announced = args[0]; return }
    originalLog(...args)
  }
  try {
    // As MESMAS opções do docker-compose.yml, menos a porta fixa: a porta 0
    // deixa o sistema escolher, e o que está sob prova é o ENDEREÇO.
    app = await runProfile({
      environment: loadLayeredEnv('dz23-studio-loopback-proof', studioRoot),
      profile: 'studio',
      patchFiles: [join(profile, 'poc-01b.patch.yml')],
      args: ['--host', host, '--port', '0', '--no-open'],
    })
  } finally { console.log = originalLog }

  const opened = listeningSockets().filter(row => !before.has(`${row.address}:${String(row.port)}`))
  assert.ok(opened.length > 0, 'nenhum soquete novo escutando: o servidor não subiu')

  // 1. todo soquete NOVO tem de ser de loopback. Um servidor que abre um
  //    segundo soquete que ninguém pediu não muda o YAML e é pego aqui.
  for (const row of opened) {
    const loopback = row.address === '127.0.0.1' || row.address === '0000:0000:0000:0000:0000:0000:0000:0001'
    if (!loopback) findings.push(`soquete escutando fora do loopback: ${row.address}:${String(row.port)}`)
  }
  const port = opened[0].port

  // 2. o loopback FUNCIONA. Sem isto a prova celebraria um servidor morto.
  const local = await fetch(`http://127.0.0.1:${String(port)}/api/studio/identity/session`)
    .then(response => response.status, () => undefined)
  if (local === undefined) findings.push('o loopback não respondeu: o servidor não está atendendo')

  // 3. o endereço externo da própria máquina é RECUSADO. É esta pergunta que
  //    distingue `--host 127.0.0.1` de `--host 0.0.0.0`.
  const external = externalAddress()
  let externalResult = 'SEM_ENDERECO_EXTERNO'
  if (external !== undefined) {
    const reached = await fetch(`http://${external}:${String(port)}/api/studio/identity/session`, {
      signal: AbortSignal.timeout(4000),
    }).then(() => true, () => false)
    externalResult = reached ? 'ALCANCAVEL' : 'RECUSADO'
    if (reached) findings.push(`o servidor respondeu no endereço externo ${external}: não está em loopback`)
  }

  return { findings, report: {
    decision: 'GO',
    args: ['--host', host, '--port', '0', '--no-open'],
    // A linha anunciada traz um TOKEN de sessao na query. Ele nunca entra na
    // saida da prova: uma prova que imprime segredo cria o vazamento que ela
    // deveria estar procurando.
    announced: announced === undefined ? null : announced.replace(/:\d+/u, ':<porta>').replace(/\?.*$/u, '?<omitido>'),
    listening: opened.map(row => `${row.address}:<porta>`),
    loopbackStatus: local,
    externalAddress: external ?? null,
    externalResult,
    note: 'a porta e 0 de proposito: o que esta sob prova e o ENDERECO, nao o numero',
  } }
} finally {
  if (app !== undefined) await app.shutdown.shutdown(0).catch(() => undefined)
}
}

try {
  if (selfTest) {
    // O caso que distingue. E ele revelou algo MELHOR do que o requisito pedia:
    // o proprio Harness RECUSA `--host 0.0.0.0`, dizendo que isso exporia
    // execucao remota de codigo a rede. Ou seja, o loopback nao depende so da
    // nossa configuracao — nao da para desligar por essa alavanca.
    //
    // Entao o self-test aceita DOIS desfechos, e os dois sao aprovacao:
    // o servidor recusa subir, ou ele sobe e esta prova o reprova. O que NAO
    // pode acontecer e ele subir fora do loopback e a prova passar.
    // SÓ `0.0.0.0`, e a limitação está escrita: uma segunda tentativa no mesmo
    // processo falha por contaminação da árvore de plugins, e não pelo
    // endereço — apresentar aquela falha como recusa seria contar uma prova
    // que não aconteceu. Um segundo caso exigiria processo separado.
    const outcomes = []
    for (const host of ['0.0.0.0']) {
      const result = await probe(host).then(
        value => value.findings.length > 0 ? `REPROVADO_PELA_PROVA(${host})` : `ACEITO(${host})`,
        error => `RECUSADO_PELO_RUNTIME(${host}): ${String(error.message).slice(0, 90)}`,
      )
      outcomes.push(result)
      if (result.startsWith('ACEITO')) {
        process.stdout.write(`LOOPBACK_BINDING_SELF_TEST=FAIL a prova aceitou um endereco fora do loopback: ${result}\n`)
        process.exit(1)
      }
    }
    process.stdout.write(`LOOPBACK_BINDING_SELF_TEST=PASS ${outcomes.join(' | ')}\n`)
  }
  const real = await probe('127.0.0.1')
  if (real.findings.length > 0) {
    process.stdout.write(`LOOPBACK_BINDING=FAIL\n${real.findings.map(line => `- ${line}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(real.report, null, 2)}\n`)
} finally {
  const normalized = resolve(runtimeRoot)
  assert.ok(normalized.startsWith(resolve(runtimeParent, 'loopback-proof-')), `recusando remover raiz inesperada: ${normalized}`)
  await rm(normalized, { recursive: true, force: true })
}
