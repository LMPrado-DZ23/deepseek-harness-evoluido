#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { iniciarBorda, segredoValido } from './preview-edge.mjs'
import { bloqueios, conferencias, relatorio, rotasConfiguradas, versaoEsperada } from './studio-doctor.mjs'

/**
 * `pnpm studio` — o comando que faltava.
 *
 * O `package.json` tinha quarenta scripts `prove:*` e nenhum que iniciasse o
 * produto. O `BOOTSTRAP.md` dizia, na primeira linha, "ele não inicia
 * serviços". O caminho do Windows se declarava quebrado. O único ponto de
 * entrada real foi escrito para dentro do contêiner.
 *
 * Ou seja: existia um produto inteiro, provado por 3412 testes, que ninguém
 * conseguia abrir.
 *
 * Este arquivo faz UMA coisa e faz inteira: olha o disco, pergunta ao doctor, e
 * ou explica em português o que falta, ou dá a partida.
 */

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * O que dá para ver do disco, sem iniciar nada.
 *
 * Toda pergunta aqui é barata e nenhuma delas tem efeito: a conferência não
 * pode ser o que estraga o ambiente que ela veio conferir.
 *
 * ## Por que a sonda do Docker é INJETADA
 *
 * Porque ela é a única pergunta desta função que sai da máquina, e ela pode
 * demorar. `docker info` espera até dez segundos por um daemon que não responde
 * — e o teste que exercita esta função tem cinco. Isso não é instabilidade: é
 * uma falha garantida sempre que o Docker demorar mais que o orçamento do teste,
 * e foi assim que a CI reprovou em 18/09/2026, num teste que não tem nada a ver
 * com Docker.
 *
 * O conserto NÃO foi aumentar o limite do teste, que é o conserto que esconde o
 * problema: com o limite maior, a suíte inteira passa a esperar um daemon
 * externo. Foi tirar o mundo de dentro do teste — quem mede disco passa uma
 * sonda que responde na hora, e a produção continua perguntando de verdade.
 */
export function observar(base = raiz, ambiente = process, sonda = SONDA_PADRAO) {
  const harness = resolve(base, 'third_party', 'deepseek-harness')
  return {
    nodeVersion: ambiente.versions?.node,
    nodeEsperado: versaoEsperada(base),
    submoduloPresente: existsSync(resolve(harness, 'package.json')),
    harnessInstalado: existsSync(resolve(harness, 'node_modules')),
    // Um pacote QUALQUER do Harness já compilado. Conferir todos custaria uma
    // varredura inteira para responder a mesma pergunta.
    harnessCompilado: existsSync(resolve(harness, 'packages', 'core', 'agent-default-model', 'lib')),
    arranqueResolvivel: arranqueDoHarness(base),
    studioInstalado: existsSync(resolve(base, 'node_modules', '@dz23-studio')),
    studioCompilado: existsSync(resolve(base, 'plugins', 'prompt-to-app', 'lib')),
    perfilPresente: existsSync(resolve(base, 'dsh-home', 'profiles', 'studio', 'package.json')),
    docker: sonda.docker(),
    // Lida do AMBIENTE, e não do Studio: perguntar ao Studio exigiria que ele
    // já estivesse no ar, e esta conferência existe para o caso em que ele
    // ainda não está.
    rotasConfiguradas: rotasConfiguradas(ambiente.env),
  }
}

/** O pacote existe e dá para chegar até ele a partir daqui? */
/**
 * O binário do `dsh` que dá a partida: o do Harness FIXADO, e não uma cópia.
 *
 * Medido em 19/09/2026 no primeiro clone limpo (WSL2, `ext4`) que seguiu a
 * sequência canônica do README: a partida resolvia `@deepseek-ai/dsh` pela raiz
 * do repositório, onde o pnpm deixa a cópia INJETADA do `apps/studio-runtime`
 * — sem as dependências dela. O conferidor dizia "o pacote que dá a partida:
 * não encontrado" e mandava rodar o mesmo `pnpm install` que acabara de rodar,
 * num laço sem saída. No ambiente onde a partida tinha sido provada, a raiz
 * tinha 262 ligações de uma instalação completa anterior, e o defeito não
 * aparecia. O Harness compilado pelo `build:official` tem o `bin.js` e resolve
 * o `dsh-app-boot` pelo `node_modules` dele — é o caminho que o próprio
 * bootstrap prepara.
 * @param base - a raiz do repositório.
 * @returns o caminho absoluto do `bin.js`.
 */
export function binDoHarness(base) {
  return resolve(base, 'third_party', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
}

/**
 * A partida resolve? O `bin.js` existe E o `dsh-app-boot` se resolve A PARTIR
 * DELE — que é exatamente o que o Node vai fazer quando o `dsh` subir.
 * @param base - a raiz do repositório.
 * @returns se dá para dar a partida.
 */
export function arranqueDoHarness(base) {
  const bin = binDoHarness(base)
  if (!existsSync(bin)) return false
  try { createRequire(bin).resolve('@deepseek-ai/dsh-app-boot'); return true } catch { return false }
}

/**
 * O construtor respondeu?
 *
 * `docker info` e não `docker --version`: a versão responde com o Docker
 * parado, e "instalado" não é a pergunta — a pergunta é se ele atende agora.
 * Falha de qualquer tipo vira `false`, e nunca `undefined`: aqui a pergunta FOI
 * feita, e a resposta foi não.
 */
export function docker() {
  try {
    const resultado = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 })
    return resultado.status === 0
  } catch { return false }
}

/**
 * A sonda que a PRODUÇÃO usa.
 *
 * Ela existe como constante exportada, e não como `{ docker }` escrito no valor
 * padrão do parâmetro, porque um valor padrão não é exercitado por teste nenhum:
 * trocá-lo por `() => true` faria o produto afirmar que o Docker atende sem ter
 * perguntado, e nenhuma suíte acusaria. Uma sabotagem provou isso. Sendo uma
 * constante, o teste consegue afirmar QUEM ela é.
 */
export const SONDA_PADRAO = { docker }

/**
 * A partida propriamente dita.
 *
 * O `DSH_HOME` aponta para o `dsh-home` DO CLONE, e não para `/var/lib`: em
 * desenvolvimento tudo que o Studio guarda fica dentro da pasta que a pessoa
 * baixou, onde ela consegue ver, copiar e apagar. Espalhar estado pelo sistema
 * de alguém que só quer experimentar o produto seria cobrar um preço que ela
 * não concordou em pagar.
 */
/** O nome do perfil que o FRIGG abre. É o diretório em `dsh-home/profiles/`. */
export const PERFIL = 'studio'

/**
 * Os argumentos com que o `dsh` é chamado.
 *
 * ELE EXISTE PORQUE A OMISSÃO NÃO TINHA PESO. O `dsh` recusa subir sem
 * `--profile <nome>` — ele hospeda vários perfis e não adivinha qual —, e esta
 * função chamava o binário SEM argumento nenhum. O conferidor dizia as dez
 * linhas `ok`, escrevia "Abrindo o FRIGG", e o que aparecia em seguida era
 * `error: --profile <name> is required`. Medido em 18/09/2026, neste
 * repositório, no caminho que o `COMECAR.md` manda usar para abrir o produto.
 *
 * Nenhum teste podia pegar: a decisão morava dentro de `arrancar`, que é
 * montagem — a lição mais repetida deste repositório. Agora ela é função
 * exportada, e tem caso.
 * @param bin - o caminho do binário do `dsh`.
 * @returns a lista de argumentos, na ordem.
 */
export function argumentosDaPartida(bin, sobreposicao, previa) {
  // A sobreposição LOCAL — os caminhos absolutos desta máquina, gravados pelo
  // instalador do construtor — entra só quando o arquivo existe. Sem ela, o
  // perfil sobe com os caminhos de produção, byte por byte como antes. A da
  // PRÉVIA vem depois, e só quando `pnpm preview:install` a gravou.
  return [bin, '--profile', PERFIL, ...(sobreposicao === undefined ? [] : ['--patch', sobreposicao]), ...(previa === undefined ? [] : ['--patch', previa])]
}

/**
 * A prévia local, quando `pnpm preview:install` a instalou.
 *
 * Os DOIS arquivos precisam existir: a sobreposição liga o supervisor no
 * perfil, e a configuração diz onde está o segredo da borda. Um sem o outro
 * subiria um Studio que exige um segredo que ninguém entrega — e o harness
 * recusaria a partida inteira.
 * @param base - a raiz do repositório.
 * @returns a prévia, ou `undefined`.
 */
export function previaLocalPresente(base) {
  const patch = resolve(base, 'dsh-home', 'profiles', PERFIL, 'preview.patch.yml')
  const arquivo = resolve(base, 'dsh-home', 'profiles', PERFIL, 'preview.local.json')
  if (!existsSync(patch) || !existsSync(arquivo)) return undefined
  const config = JSON.parse(readFileSync(arquivo, 'utf8'))
  if (!Number.isInteger(config.porta) || !Number.isInteger(config.portaDoHarness) || typeof config.segredoDaBorda !== 'string') {
    throw new Error(`${arquivo} está incompleto.`)
  }
  return { patch, porta: config.porta, portaDoHarness: config.portaDoHarness, segredoDaBorda: config.segredoDaBorda }
}

/**
 * O endereço para abrir o FRIGG QUANDO há prévia: o mesmo convite que o `dsh`
 * anuncia, no host da borda. O cookie de admissão da prévia só é de primeira
 * parte se o Studio e a prévia forem do mesmo site (`dz23.localhost`).
 * @param linha - uma linha da saída do `dsh`.
 * @param porta - a porta da borda.
 * @returns o endereço, ou `undefined`.
 */
export function enderecoComPrevia(linha, porta) {
  const achado = /dsh web: http:\/\/127\.0\.0\.1:\d+(\/\S*)/u.exec(linha)
  return achado === null ? undefined : `http://studio.dz23.localhost:${String(porta)}${achado[1]}`
}

/**
 * A sobreposição local, quando o instalador a gravou.
 * @param base - a raiz do repositório.
 * @returns o caminho, ou `undefined`.
 */
export function sobreposicaoLocalPresente(base) {
  const caminho = resolve(base, 'dsh-home', 'profiles', PERFIL, 'local.patch.yml')
  return existsSync(caminho) ? caminho : undefined
}

/**
 * O ambiente com que o `dsh` sobe.
 *
 * `DZ23_OLLAMA_PLACEHOLDER` é o "nome de chave" que o perfil declara para a
 * rota do Ollama (`apiKeyEnv`), porque o adaptador de modelos recusa rota sem
 * chave — e o Ollama local não tem chave nenhuma. Os roteiros de prova sempre
 * o preenchiam; a PARTIDA de verdade não. Medido em 19/09/2026 na primeira
 * jornada no WSL2: a leitura do pedido (que vai pelo caminho estruturado)
 * funcionou, e a síntese da especificação, que passa pelo adaptador, morreu com
 * "no credential for provider route ollama" — e o conferidor tinha dito "IA:
 * Ollama, ok". O valor NÃO é segredo e diz isso no próprio texto; um valor que
 * a pessoa já tenha posto é respeitado.
 * @param base - a raiz do repositório.
 * @param ambiente - o ambiente de quem chamou.
 * @returns o ambiente do filho.
 */
export function ambienteDaPartida(base, ambiente, segredoDaBorda) {
  return {
    ...ambiente,
    DSH_HOME: resolve(base, 'dsh-home'),
    DZ23_OLLAMA_PLACEHOLDER: ambiente.DZ23_OLLAMA_PLACEHOLDER ?? 'ollama-local-placeholder-not-a-secret',
    // O segredo da borda vive num arquivo 0600 fora do repositório e só existe
    // no ambiente DO FILHO: não é impresso, não vai para argumento de linha de
    // comando e não fica no ambiente de quem chamou.
    ...(segredoDaBorda === undefined ? {} : { DZ23_EDGE_SECRET: segredoDaBorda }),
  }
}

async function arrancar(base) {
  const bin = binDoHarness(base)
  const previa = previaLocalPresente(base)
  const segredo = previa === undefined ? undefined : segredoValido(readFileSync(previa.segredoDaBorda, 'utf8'))
  if (previa !== undefined) await iniciarBorda({ porta: previa.porta, harnessHost: '127.0.0.1', harnessPorta: previa.portaDoHarness, segredo })
  const filho = spawn(process.execPath, argumentosDaPartida(bin, sobreposicaoLocalPresente(base), previa?.patch), {
    cwd: base,
    stdio: previa === undefined ? 'inherit' : ['inherit', 'pipe', 'inherit'],
    env: ambienteDaPartida(base, process.env, segredo),
  })
  if (previa !== undefined) {
    filho.stdout.on('data', pedaco => {
      process.stdout.write(pedaco)
      for (const linha of String(pedaco).split('\n')) {
        const endereco = enderecoComPrevia(linha, previa.porta)
        if (endereco !== undefined) process.stdout.write(`\nFRIGG com prévia — abra este endereço: ${endereco}\n`)
      }
    })
  }
  filho.on('exit', codigo => { process.exit(codigo ?? 0) })
  // Sem isto, um `Ctrl+C` deixaria o Studio rodando sem dono.
  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, () => { filho.kill(sinal) })
  }
}

export function principal(argumentos = process.argv.slice(2), base = raiz) {
  const lista = conferencias(observar(base))
  const texto = relatorio(lista)
  const somenteConferir = argumentos.includes('--conferir')

  if (texto.length > 0) process.stdout.write(`${texto}\n`)

  if (somenteConferir) {
    // O doctor sozinho NÃO falha quando só há avisos: ele foi perguntado, e
    // responder é o trabalho dele. Ele falha quando o Studio não abriria.
    process.exit(bloqueios(lista).length > 0 ? 1 : 0)
  }
  if (bloqueios(lista).length > 0) process.exit(1)

  process.stdout.write('\nAbrindo o FRIGG. Quando ele terminar de subir, o endereço aparece abaixo.\n')
  process.stdout.write('Para parar, aperte Ctrl+C.\n\n')
  void arrancar(base).catch(erro => {
    process.stderr.write(`O FRIGG não subiu: ${erro instanceof Error ? erro.message : String(erro)}\n`)
    process.exit(1)
  })
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) principal()
