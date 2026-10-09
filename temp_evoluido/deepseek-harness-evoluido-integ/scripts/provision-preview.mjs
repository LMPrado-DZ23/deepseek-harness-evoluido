#!/usr/bin/env node
/**
 * A PRÉVIA na instalação PESSOAL — `pnpm preview:install`.
 *
 * O construtor já é instalado por `scripts/provision-builder.mjs`. Faltava a
 * outra metade da jornada: abrir o aplicativo verificado. Este comando liga as
 * peças que já existiam (o supervisor de prévias e o plugin de prévia) e a
 * borda local (`scripts/preview-edge.mjs`), sem nenhuma mudança de sistema:
 *
 * 1. segredos NOVOS, gerados aqui e gravados só em arquivos 0600 fora do
 *    repositório (`<base>/preview/segredos`). Nenhum valor passa por argumento
 *    de linha de comando, variável de ambiente persistente ou arquivo versionado;
 * 2. a imagem do supervisor, construída sobre a imagem do construtor que JÁ
 *    está na máquina (nada é baixado), e fixada pelo ID;
 * 3. o contêiner do supervisor: sem rede, só leitura, sem capacidades, com o
 *    soquete do Docker em modo leitura, rodando como a PRÓPRIA pessoa — para que
 *    o harness nativo alcance os soquetes sem criar grupo no sistema;
 * 4. a sobreposição `preview.patch.yml`, com os caminhos desta máquina, e o
 *    `preview.local.json` que `pnpm studio` lê para subir a borda.
 *
 * Reexecutável: rodar de novo confere, não duplica. NUNCA substitui um
 * contêiner, uma imagem ou um arquivo que já existe e é diferente — diz o que
 * encontrou e para.
 *
 * Desfazer: `docker rm -f frigg-preview-supervisor` e apagar os dois arquivos
 * da sobreposição.
 *
 * Uso: node scripts/provision-preview.mjs [--base /abs] [--porta 8088] [--atualizar] [--self-test]
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CONTEINER = 'frigg-preview-supervisor'
export const REPOSITORIO_DA_IMAGEM = 'frigg-preview-supervisor'
export const IMAGEM_DO_CONSTRUTOR = 'dz23-studio-builder:local'
export const SOBREPOSICAO_DA_PREVIA = 'dsh-home/profiles/studio/preview.patch.yml'
export const CONFIGURACAO_DA_PREVIA = 'dsh-home/profiles/studio/preview.local.json'

/**
 * Os caminhos desta instalação.
 * @param {string} base - a pasta de dados (a mesma do construtor).
 */
export function caminhosDaPrevia(base) {
  const previa = `${base}/preview`
  return {
    previa,
    soquetes: `${previa}/run`,
    proxies: `${previa}/proxies`,
    segredos: `${previa}/segredos`,
    tokenDoSupervisor: `${previa}/segredos/supervisor-token`,
    segredoDaBorda: `${previa}/segredos/edge-secret`,
    execucoes: `${base}/generated-runs`,
  }
}

/**
 * A sobreposição do perfil. Valores ABSOLUTOS e por extenso, como a do
 * construtor; o único valor secreto entra por NOME (`edgeSecretRef`).
 * @param {{ base: string, porta: number, portaDoHarness: number }} opcoes
 */
export function sobreposicaoDaPrevia({ base, porta, portaDoHarness }) {
  const c = caminhosDaPrevia(base)
  const q = valor => JSON.stringify(valor)
  const host = `studio.dz23.localhost:${String(porta)}`
  const origem = `http://${host}`
  const hosts = [`127.0.0.1:${String(portaDoHarness)}`, `localhost:${String(portaDoHarness)}`, host]
  const origens = [`http://localhost:${String(portaDoHarness)}`, `http://127.0.0.1:${String(portaDoHarness)}`, origem]
  const lista = (itens, recuo) => itens.map(item => `${recuo}- ${q(item)}`)
  return [
    '# GERADO por scripts/provision-preview.mjs — a prévia desta máquina.',
    '# Não versionado. Apague-o (e preview.local.json) para desligar a prévia.',
    '- id: connection',
    '  config:',
    '    trustedHosts:',
    ...lista([host], '      '),
    '- id: dz23-studio-preview',
    '  config:',
    `    publicPort: ${String(porta)}`,
    // Repetido da base: esta entrada substitui a configuração inteira.
    '    runtimeTimeoutMs: 30000',
    '    capacityMode: single-process',
    '    supervisor:',
    '      enabled: true',
    `      socketPath: ${q(`${c.soquetes}/supervisor.sock`)}`,
    `      tokenFile: ${q(c.tokenDoSupervisor)}`,
    `      artifactRoot: ${q(c.execucoes)}`,
    `      proxySocketRoot: ${q(c.proxies)}`,
    `      studioOrigin: ${q(origem)}`,
    '      edgeSecretRef: DZ23_EDGE_SECRET',
    '- id: dz23-studio-identity',
    '  config:',
    '    allowedHosts:',
    ...lista(hosts, '      '),
    '    allowedOrigins:',
    ...lista(origens, '      '),
    // Só a IDENTIDADE recebe os hosts: os outros plugins partem da lista
    // dela (`confiancaPara`). Uma entrada aqui SUBSTITUI a configuração
    // inteira do plugin — medido em 19/09/2026: a do `dz23-studio-web`
    // apagava `assistantRepositories`.
    '',
  ].join('\n')
}

/**
 * Os argumentos do `docker run` do supervisor.
 * @param {{ base: string, uid: number, gid: number, gidDoDocker: number, imagemDoSupervisor: string, imagemDoRuntime: string }} o
 */
export function argumentosDoSupervisor({ base, uid, gid, gidDoDocker, imagemDoSupervisor, imagemDoRuntime }) {
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) throw new Error('A prévia não roda como root.')
  for (const id of [imagemDoSupervisor, imagemDoRuntime]) if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error(`imagem sem ID fixado: ${id}`)
  const c = caminhosDaPrevia(base)
  const usuario = `${String(uid)}:${String(gid)}`
  return [
    'run', '-d', '--name', CONTEINER,
    '--network', 'none', '--user', usuario, '--group-add', String(gidDoDocker),
    '--read-only', '--tmpfs', `/tmp:rw,noexec,nosuid,size=64m,uid=${String(uid)},gid=${String(gid)}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '128', '--memory', '512m', '--cpus', '1.0', '--restart', 'unless-stopped',
    '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
    '-v', `${c.execucoes}:${c.execucoes}:ro`,
    '-v', `${c.soquetes}:/run/dz23-preview`,
    // PASTA, e não volume nomeado: o Docker repovoa um volume vazio com a
    // pasta da imagem (dona 10001) e a pessoa perde o acesso aos próprios
    // soquetes — medido em 19/09/2026. Pasta montada nunca é repovoada.
    '-v', `${c.proxies}:/run/dz23-preview-proxies`,
    '-v', `${c.tokenDoSupervisor}:/run/secrets/dz23-preview-supervisor-token:ro`,
    '-e', 'DZ23_DOCKER_SOCKET=/var/run/docker.sock',
    '-e', 'DZ23_SUPERVISOR_SOCKET=/run/dz23-preview/supervisor.sock',
    '-e', 'DZ23_SUPERVISOR_TOKEN_FILE=/run/secrets/dz23-preview-supervisor-token',
    '-e', `DZ23_ARTIFACT_ROOT=${c.execucoes}`,
    '-e', 'DZ23_PROXY_SOCKET_ROOT=/run/dz23-preview-proxies',
    '-e', `DZ23_PROXY_SOCKET_BIND=${c.proxies}`,
    '-e', `DZ23_RUNTIME_IMAGE_DIGEST=${imagemDoRuntime}`,
    '-e', `DZ23_PROXY_IMAGE_DIGEST=${imagemDoSupervisor}`,
    '-e', 'DZ23_INSTANCE_ID=frigg-local',
    '-e', `DZ23_PROXY_USER=${usuario}`,
    imagemDoSupervisor,
  ]
}

/**
 * A etiqueta da imagem, derivada do CONTEÚDO que entra nela.
 *
 * Com uma etiqueta fixa (`:local`), uma imagem velha — a que morria por falta
 * do catálogo de mensagens — seria reaproveitada para sempre, e um conserto no
 * código nunca chegaria à máquina. Com o conteúdo na etiqueta, código novo é
 * imagem nova, e a antiga não é tocada.
 * @param base - a raiz do repositório.
 * @returns `frigg-preview-supervisor:<12 hex>`.
 */
export function etiquetaDaImagem(base) {
  const hash = createHash('sha256')
  const incluir = relativo => { hash.update(`${relativo}\0`); hash.update(readFileSync(resolve(base, relativo))); hash.update('\0') }
  incluir('deploy/preview-supervisor/Dockerfile')
  incluir('deploy/preview-supervisor/Dockerfile.dockerignore')
  for (const pasta of ['plugins/preview-supervisor/lib', 'plugins/preview-supervisor/i18n']) {
    const arquivos = readdirSync(resolve(base, pasta), { recursive: true, withFileTypes: true })
      .filter(entrada => entrada.isFile())
      .map(entrada => `${pasta}/${resolve(entrada.parentPath, entrada.name).slice(resolve(base, pasta).length + 1)}`)
      .sort()
    for (const arquivo of arquivos) incluir(arquivo)
  }
  return `${REPOSITORIO_DA_IMAGEM}:${hash.digest('hex').slice(0, 12)}`
}

/** Grava um segredo novo, 0600, só se ainda não existe. */
function segredo(caminho) {
  if (existsSync(caminho)) {
    if ((statSync(caminho).mode & 0o077) !== 0) throw new Error(`O segredo ${caminho} está legível por outros. Nada foi feito.`)
    return 'MANTIDO'
  }
  writeFileSync(caminho, `${randomBytes(48).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
  return 'CRIADO'
}

/**
 * Grava um arquivo gerado; se já existe diferente, para — salvo com
 * `--atualizar`, e só quando o arquivo existente é um que ESTE instalador
 * gerou (a primeira linha diz). Arquivo escrito à mão nunca é trocado.
 */
function gravarUmaVez(caminho, texto, atualizar = false) {
  if (!existsSync(caminho)) { writeFileSync(caminho, texto, { mode: 0o600, flag: 'wx' }); return 'CRIADO' }
  const atual = readFileSync(caminho, 'utf8')
  if (atual === texto) return 'IGUAL'
  if (atualizar && geradoPorEsteInstalador(atual)) { writeFileSync(caminho, texto, { mode: 0o600 }); return 'ATUALIZADO' }
  throw new Error(`${caminho} já existe e é DIFERENTE. Nada foi trocado; confira-o à mão.`)
}

/** O arquivo foi gerado por este instalador? */
export function geradoPorEsteInstalador(texto) {
  return texto.startsWith('# GERADO por scripts/provision-preview.mjs') || /^\{\s*"porta"/u.test(texto)
}

function docker(...argumentos) {
  const r = spawnSync('docker', argumentos, { encoding: 'utf8' })
  return { ok: r.status === 0, saida: (r.stdout ?? '').trim(), erro: (r.stderr ?? '').trim() }
}

function selfTest() {
  const casos = []
  const ok = (nome, condicao) => { casos.push(condicao); if (!condicao) console.error(`  autoteste FALHOU: ${nome}`) }
  const texto = sobreposicaoDaPrevia({ base: '/h/.frigg', porta: 8088, portaDoHarness: 3080 })
  ok('origem da prévia é studio.dz23.localhost', texto.includes('studioOrigin: "http://studio.dz23.localhost:8088"'))
  ok('segredo só por nome', texto.includes('edgeSecretRef: DZ23_EDGE_SECRET') && !texto.includes('process.env'))
  ok('mantém os hosts de sempre', texto.includes('"127.0.0.1:3080"') && texto.includes('"localhost:3080"'))
  let recusouRoot = false
  try { argumentosDoSupervisor({ base: '/h', uid: 0, gid: 0, gidDoDocker: 1, imagemDoSupervisor: `sha256:${'a'.repeat(64)}`, imagemDoRuntime: `sha256:${'b'.repeat(64)}` }) } catch { recusouRoot = true }
  ok('recusa root', recusouRoot)
  const falhas = casos.filter(caso => !caso).length
  console.log(`PROVISION_PREVIEW_SELF_TEST=${falhas === 0 ? 'PASS' : 'FAIL'} casos=${String(casos.length)}`)
  return falhas === 0
}

const chamadoDiretamente = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`
if (chamadoDiretamente && process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1)

if (chamadoDiretamente) {
  const valor = nome => { const i = process.argv.indexOf(nome); return i >= 0 ? process.argv[i + 1] : undefined }
  const base = valor('--base') ?? resolve(homedir(), '.frigg')
  const porta = Number(valor('--porta') ?? '8088')
  const portaDoHarness = 3080
  const c = caminhosDaPrevia(base)
  const relatorio = {}
  try {
    for (const pasta of [c.previa, c.soquetes, c.proxies, c.segredos]) mkdirSync(pasta, { recursive: true, mode: 0o700 })
    relatorio.tokenDoSupervisor = segredo(c.tokenDoSupervisor)
    relatorio.segredoDaBorda = segredo(c.segredoDaBorda)

    const construtor = docker('image', 'inspect', '-f', '{{.Id}}', IMAGEM_DO_CONSTRUTOR)
    if (!construtor.ok) throw new Error('A imagem do construtor não está nesta máquina. Rode antes: pnpm builder:install')
    const imagemDoRuntime = construtor.saida

    const etiqueta = etiquetaDaImagem(raiz)
    let supervisor = docker('image', 'inspect', '-f', '{{.Id}}', etiqueta)
    if (!supervisor.ok) {
      const construcao = spawnSync('docker', ['build', '-f', 'deploy/preview-supervisor/Dockerfile', '--build-arg', `DZ23_SUPERVISOR_BASE_IMAGE=${IMAGEM_DO_CONSTRUTOR}`, '-t', etiqueta, '.'], { cwd: raiz, stdio: 'inherit', env: { ...process.env, DOCKER_BUILDKIT: '1' } })
      if (construcao.status !== 0) throw new Error('A imagem do supervisor não foi construída.')
      supervisor = docker('image', 'inspect', '-f', '{{.Id}}', etiqueta)
      relatorio.imagem = `CONSTRUIDA ${etiqueta}`
    } else relatorio.imagem = `EXISTENTE ${etiqueta}`
    const imagemDoSupervisor = supervisor.saida

    const existente = docker('inspect', '-f', '{{.Image}} {{.State.Running}}', CONTEINER)
    const atualizar = process.argv.includes('--atualizar')
    if (existente.ok && existente.saida.split(' ')[0] !== imagemDoSupervisor) {
      /*
        O supervisor NÃO guarda estado: ao subir, ele drena o que era dele e
        recomeça. Trocá-lo por um de código novo é atualização, e não perda —
        mas continua sendo pedido explicitamente (`--atualizar`), e só este
        contêiner, pelo nome, é trocado.
      */
      if (!atualizar) throw new Error(`Já existe um ${CONTEINER} com OUTRA imagem. Nada foi substituído; para trocá-lo pelo código atual, rode de novo com --atualizar.`)
      const removido = docker('rm', '-f', CONTEINER)
      if (!removido.ok) throw new Error(`O ${CONTEINER} antigo não saiu: ${removido.erro}`)
      relatorio.substituido = 'SIM'
    }
    const atual = docker('inspect', '-f', '{{.Image}} {{.State.Running}}', CONTEINER)
    if (atual.ok) {
      const [, rodando] = atual.saida.split(' ')
      if (rodando !== 'true' && !docker('start', CONTEINER).ok) throw new Error(`O ${CONTEINER} existe e não iniciou.`)
      relatorio.supervisor = 'EXISTENTE'
    } else {
      const gidDoDocker = statSync('/var/run/docker.sock').gid
      const r = docker(...argumentosDoSupervisor({ base, uid: process.getuid(), gid: process.getgid(), gidDoDocker, imagemDoSupervisor, imagemDoRuntime }))
      if (!r.ok) throw new Error(`O supervisor não subiu: ${r.erro}`)
      relatorio.supervisor = 'INICIADO'
    }

    relatorio.sobreposicao = gravarUmaVez(resolve(raiz, SOBREPOSICAO_DA_PREVIA), sobreposicaoDaPrevia({ base, porta, portaDoHarness }), atualizar)
    relatorio.configuracao = gravarUmaVez(resolve(raiz, CONFIGURACAO_DA_PREVIA), `${JSON.stringify({ porta, portaDoHarness, segredoDaBorda: c.segredoDaBorda }, null, 2)}\n`, atualizar)
    console.log(JSON.stringify({ ...relatorio, abrir: `http://studio.dz23.localhost:${String(porta)}` }, null, 2))
  } catch (erro) {
    console.error(JSON.stringify({ erro: erro instanceof Error ? erro.message : String(erro), feito: relatorio }))
    process.exit(70)
  }
}
