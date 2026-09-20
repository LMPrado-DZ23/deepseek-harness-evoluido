#!/usr/bin/env node
/**
 * O INSTALADOR DO CONSTRUTOR, pela linha de comando — `pnpm builder:install`.
 *
 * Ele liga as quatro peças que já existiam (manifesto, provisionamento, ativação
 * e gerente) por meio de `instalarConstrutor`, e faz as duas coisas que só um
 * comando de máquina sabe fazer:
 *
 * 1. escolhe o ESCOPO que o produto vai procurar. O produto deriva o escopo de
 *    `opaqueTenantIdentity(org, tenant)` e de `PROMPT_APP_BUILDER_INSTANCE_ID`;
 *    um instalador que inventasse outro par criaria um construtor que o produto
 *    nunca encontra, e a resposta seria `BUILDER_SCOPE_UNAVAILABLE` com o
 *    construtor de pé logo ali. Os dois valores vêm do MESMO módulo que o
 *    produto usa;
 * 2. grava a SOBREPOSIÇÃO LOCAL do perfil — os caminhos absolutos desta máquina
 *    — num arquivo que `pnpm studio` aplica quando ele existe. É arquivo, e não
 *    variável de ambiente, por uma decisão que já estava no perfil: a pasta das
 *    execuções é a fronteira de exportação do hub de integrações, e "uma
 *    variável não pode ser capaz de movê-la".
 *
 * Reexecutável: rodar de novo confere, não duplica. Ele NUNCA substitui uma
 * instalação existente por outra, nunca apaga nada e nunca troca o arquivo de
 * sobreposição por um diferente.
 *
 * Uso: node scripts/provision-builder.mjs [--base /caminho/absoluto] [--self-test]
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Onde a sobreposição local do perfil mora. Fora do controle de versão. */
export const SOBREPOSICAO_LOCAL = 'dsh-home/profiles/studio/local.patch.yml'

/**
 * A sobreposição local do perfil, em texto.
 *
 * Ela diz às DUAS partes que precisam concordar — o `prompt-to-app` e o hub de
 * integrações — onde ficam as execuções, e diz ao `prompt-to-app` onde está o
 * construtor. Os valores são ABSOLUTOS e escritos por extenso: nenhuma
 * expressão, nenhuma variável.
 * @param base - a pasta de dados desta instalação.
 * @param raizes - as raízes do construtor.
 * @returns o YAML.
 */
export function sobreposicaoLocal(base, raizes) {
  const q = valor => JSON.stringify(valor)
  return [
    '# GERADO por scripts/provision-builder.mjs — os caminhos desta máquina.',
    '# Não versionado. Apague-o para voltar aos caminhos de produção.',
    '- id: dz23-studio-prompt-to-app',
    '  config:',
    `    runsRoot: ${q(`${base}/generated-runs`)}`,
    `    logoStoreRoot: ${q(`${base}/assets`)}`,
    '    builderLifecycle:',
    '      roots:',
    ...Object.entries(raizes).map(([chave, valor]) => `        ${chave}: ${q(valor)}`),
    '- id: dz23-studio-integration-hub',
    '  config:',
    `    runsRoot: ${q(`${base}/generated-runs`)}`,
    `    exportsRoot: ${q(`${base}/exports`)}`,
    '',
  ].join('\n')
}

/**
 * O gerente que está de pé é O NOSSO, para ESTE registro?
 *
 * Um PID num arquivo não basta: o sistema reusa PIDs, e confiar só nele faria o
 * instalador achar que o gerente está vivo quando o número agora é de outro
 * processo. Confere-se a linha de comando do processo.
 * @param pidArquivo - o arquivo do PID.
 * @param registro - a referência do registro.
 * @returns se está vivo.
 */
export function gerenteVivoPeloPid(pidArquivo, registro) {
  try {
    const pid = Number(readFileSync(pidArquivo, 'utf8').trim())
    if (!Number.isSafeInteger(pid) || pid <= 1) return false
    const linha = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0')
    return linha.some(parte => parte.endsWith('start-builder-manager.js')) && linha.includes(registro)
  } catch { return false }
}

function selfTest() {
  const casos = []
  const ok = (nome, condicao) => { casos.push(condicao); if (!condicao) console.error(`  autoteste FALHOU: ${nome}`) }
  const texto = sobreposicaoLocal('/dados/frigg/.dz23-studio', { configRoot: '/dados/frigg/.dz23-studio/builder/config' })
  ok('as duas partes recebem a MESMA pasta de execucoes',
    texto.split('runsRoot: "/dados/frigg/.dz23-studio/generated-runs"').length === 3)
  ok('nenhuma expressao nem variavel', !texto.includes('!!js') && !texto.includes('process.env'))
  ok('as raizes do construtor vao para o prompt-to-app', texto.includes('configRoot: "/dados/frigg/.dz23-studio/builder/config"'))
  ok('pid inexistente nao e gerente vivo', gerenteVivoPeloPid('/nao/existe.pid', 'file:/x') === false)
  const falhas = casos.filter(caso => !caso).length
  console.log(`PROVISION_BUILDER_SELF_TEST=${falhas === 0 ? 'PASS' : 'FAIL'} casos=${String(casos.length)}`)
  return falhas === 0
}

const chamadoDiretamente = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (chamadoDiretamente && process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1)

if (chamadoDiretamente) {
  const { instalarConstrutor, provisionAndActivateBuilderRuntime, raizesDoConstrutorEm } = await import('../plugins/builder-supervisor/lib/index.js')
  const { opaqueTenantIdentity, PROMPT_APP_BUILDER_INSTANCE_ID } = await import('../plugins/prompt-to-app/lib/builder-resolver.js')
  const { lerDigestFixado } = await import('./builder-doctor.mjs')
  const indice = process.argv.indexOf('--base')
  const base = indice >= 0 ? process.argv[indice + 1] : resolve(homedir(), '.dz23-studio')
  const raizes = raizesDoConstrutorEm(`${base}/builder`)
  const digest = lerDigestFixado(raiz)
  if (digest === undefined) {
    console.error('A imagem do construtor ainda não foi fixada. Rode antes: node scripts/setup-templates.mjs --approve-t2')
    process.exit(64)
  }
  const diretorioDaInstalacao = `${base}/builder-install`
  const pidArquivo = `${diretorioDaInstalacao}/gerente.pid`
  const docker = (...argumentos) => new Promise(resolver => {
    const filho = spawn('docker', argumentos, { stdio: 'ignore' })
    filho.on('exit', codigo => { resolver(codigo === 0) })
    filho.on('error', () => { resolver(false) })
  })
  try {
    const resultado = await instalarConstrutor({
      raizes, diretorioDaInstalacao, storeDir: resolve(raiz, 'runtime/template-store-v2'), versaoDoStore: 'v2',
      digestFixado: digest,
      // O MESMO par que o produto deriva para a instalação pessoal.
      tenantId: opaqueTenantIdentity('org_local', 'tenant_local'), instanceId: PROMPT_APP_BUILDER_INSTANCE_ID,
    }, {
      imagemExiste: alvo => docker('image', 'inspect', alvo),
      provisionarEAtivar: provisionAndActivateBuilderRuntime,
      gerenteVivo: async registro => gerenteVivoPeloPid(pidArquivo, registro),
      iniciarGerente: async registro => {
        const log = openSync(`${diretorioDaInstalacao}/gerente.log`, 'a', 0o600)
        const filho = spawn(process.execPath, [resolve(raiz, 'plugins/builder-supervisor/lib/start-builder-manager.js'), '--registry', registro, '--roots-base', `${base}/builder`], {
          detached: true, stdio: ['ignore', log, log],
        })
        writeFileSync(pidArquivo, `${String(filho.pid)}\n`, { mode: 0o600 })
        filho.unref()
        return { pid: filho.pid }
      },
      socketExiste: async caminho => { try { return lstatSync(caminho).isSocket() } catch { return false } },
      esperar: ms => new Promise(resolver => setTimeout(resolver, ms)),
      uid: () => process.getuid(),
    })
    const destino = resolve(raiz, SOBREPOSICAO_LOCAL)
    const texto = sobreposicaoLocal(base, raizes)
    if (!existsSync(destino)) writeFileSync(destino, texto, { mode: 0o600, flag: 'wx' })
    else if (readFileSync(destino, 'utf8') !== texto) {
      console.error(`A sobreposição local já existe e é DIFERENTE: ${destino}. Nada foi trocado; confira-a à mão.`)
      process.exit(65)
    }
    console.log(JSON.stringify({ ...resultado, sobreposicao: destino }, null, 2))
    process.exit(0)
  } catch (erro) {
    console.error(JSON.stringify({ erro: erro.code ?? 'FALHA', detalhe: erro.detalhe ?? erro.message }))
    process.exit(70)
  }
}
