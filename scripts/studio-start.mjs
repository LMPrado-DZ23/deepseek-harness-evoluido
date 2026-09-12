#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bloqueios, conferencias, relatorio, versaoEsperada } from './studio-doctor.mjs'

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
const require = createRequire(resolve(raiz, 'package.json'))

/**
 * O que dá para ver do disco, sem iniciar nada.
 *
 * Toda pergunta aqui é barata e nenhuma delas tem efeito: a conferência não
 * pode ser o que estraga o ambiente que ela veio conferir.
 */
export function observar(base = raiz, ambiente = process) {
  const harness = resolve(base, 'third_party', 'deepseek-harness')
  return {
    nodeVersion: ambiente.versions?.node,
    nodeEsperado: versaoEsperada(base),
    submoduloPresente: existsSync(resolve(harness, 'package.json')),
    harnessInstalado: existsSync(resolve(harness, 'node_modules')),
    // Um pacote QUALQUER do Harness já compilado. Conferir todos custaria uma
    // varredura inteira para responder a mesma pergunta.
    harnessCompilado: existsSync(resolve(harness, 'packages', 'core', 'agent-default-model', 'lib')),
    arranqueResolvivel: resolvivel('@deepseek-ai/dsh-app-boot'),
    studioInstalado: existsSync(resolve(base, 'node_modules', '@dz23-studio')),
    studioCompilado: existsSync(resolve(base, 'plugins', 'prompt-to-app', 'lib')),
    perfilPresente: existsSync(resolve(base, 'dsh-home', 'profiles', 'studio', 'package.json')),
    docker: docker(),
    rotasConfiguradas: undefined,
  }
}

/** O pacote existe e dá para chegar até ele a partir daqui? */
function resolvivel(nome) {
  try { require.resolve(`${nome}/package.json`); return true } catch { return false }
}

/**
 * O construtor respondeu?
 *
 * `docker info` e não `docker --version`: a versão responde com o Docker
 * parado, e "instalado" não é a pergunta — a pergunta é se ele atende agora.
 * Falha de qualquer tipo vira `false`, e nunca `undefined`: aqui a pergunta FOI
 * feita, e a resposta foi não.
 */
function docker() {
  try {
    const resultado = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 })
    return resultado.status === 0
  } catch { return false }
}

/**
 * A partida propriamente dita.
 *
 * O `DSH_HOME` aponta para o `dsh-home` DO CLONE, e não para `/var/lib`: em
 * desenvolvimento tudo que o Studio guarda fica dentro da pasta que a pessoa
 * baixou, onde ela consegue ver, copiar e apagar. Espalhar estado pelo sistema
 * de alguém que só quer experimentar o produto seria cobrar um preço que ela
 * não concordou em pagar.
 */
function arrancar(base) {
  const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  const filho = spawn(process.execPath, [bin], {
    cwd: base,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: resolve(base, 'dsh-home') },
  })
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

  process.stdout.write('\nAbrindo o DZ23 STUDIO. Quando ele terminar de subir, o endereço aparece abaixo.\n')
  process.stdout.write('Para parar, aperte Ctrl+C.\n\n')
  arrancar(base)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) principal()
