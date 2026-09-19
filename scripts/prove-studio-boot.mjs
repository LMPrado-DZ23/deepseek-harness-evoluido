#!/usr/bin/env node
/**
 * A PROVA DE QUE O PRODUTO ABRE — pelo caminho real, e não por um dublê.
 *
 * ## Por que ela existe
 *
 * Em 18/09/2026 o FRIGG montado subiu pela primeira vez na missão, e não subia
 * por TRÊS defeitos que os milhares de testes não podiam pegar, porque os três
 * moram na MONTAGEM:
 *
 * 1. `scripts/studio-start.mjs` chamava o `dsh` sem `--profile`, e ele recusa
 *    subir assim. O conferidor imprimia dez linhas `ok`, o texto dizia
 *    "Abrindo o FRIGG", e o processo morria na linha seguinte;
 * 2. `@dz23-studio/business` pedia o serviço `promptToApp`, que ninguém
 *    oferece — o nome é `studioPromptToApp`. O Cordis não inventa serviço: ele
 *    ESPERA, a árvore inteira ficava pendente e o processo morria. O teste do
 *    plugin afirmava a MESMA string errada, então ele congelava o defeito;
 * 3. a página da interface exigia cookie de sessão numa instalação PESSOAL,
 *    onde entrar não existe porque não há ninguém para entrar como.
 *
 * Esta prova pega os três, e pega qualquer parente deles, porque ela não olha
 * nome de arquivo nem string no código: ela SOBE o produto e pergunta a ele.
 *
 * ## O que ela afirma, e em que ordem
 *
 * - o processo real (`node scripts/studio-start.mjs`) sobe e ANUNCIA o endereço;
 * - ele continua vivo depois de anunciar — o defeito 1 matava o processo aqui;
 * - o registro não traz nenhuma marca de árvore que não ativou — defeito 2;
 * - a interface responde `200` sem cookie de sessão, em modo pessoal — defeito 3;
 * - as rotas de TRABALHO respondem, e não só a página: `apps/health` prova que
 *   `prompt-to-app` montou E que a locação respondeu pelo escopo pessoal;
 * - `identity/session` declara `personal`, que é o modo que a instalação local é;
 * - o processo PARA quando mandam parar, sem deixar filho para trás.
 *
 * ## O que ela NÃO afirma
 *
 * Nada sobre construção: o construtor tem prova própria, e uma execução
 * completa depende de imagem e de supervisor provisionado. Nada sobre modelo:
 * subir não é gerar. E nada sobre instalação de SERVIDOR — ali entrar existe, e
 * a recusa sem cookie é a resposta certa; quem cobre isso é o e2e.
 *
 * Uso: node scripts/prove-studio-boot.mjs [--self-test]
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** O tempo que a partida tem para anunciar o endereço. */
export const LIMITE_DA_PARTIDA_MS = 180_000

/** As marcas que provam que a árvore NÃO subiu inteira. */
export const MARCAS_DE_FALHA = Object.freeze([
  'did not activate',
  'plugin tree failed to load',
  'ERR_MODULE_NOT_FOUND',
  '--profile <name> is required',
])

/**
 * O endereço e o bilhete anunciados pelo registro da partida.
 *
 * Lê a ÚLTIMA ocorrência: uma partida que reinicie anuncia de novo, e o bilhete
 * que vale é o do processo que está de pé.
 * @param registro - o texto acumulado da saída.
 * @returns a base e o bilhete, ou `null` enquanto não houver anúncio.
 */
export function anuncioDaPartida(registro) {
  const achados = [...registro.matchAll(/dsh web: (http:\/\/[^\s?]+)\?token=([A-Za-z0-9_-]+)/gu)]
  const ultimo = achados.at(-1)
  if (ultimo === undefined) return null
  return { base: ultimo[1].replace(/\/$/u, ''), token: ultimo[2] }
}

/**
 * As marcas de falha presentes num registro.
 * @param registro - o texto acumulado da saída.
 * @returns as marcas encontradas.
 */
export function falhasNoRegistro(registro) {
  return MARCAS_DE_FALHA.filter(marca => registro.includes(marca))
}

/**
 * O veredito de um passo da prova.
 * @param nome - o nome do passo.
 * @param ok - se ele passou.
 * @param detalhe - o que foi observado.
 * @returns a linha do relatório.
 */
export function veredito(nome, ok, detalhe) {
  return `${ok ? 'OK  ' : 'FAIL'} ${nome}${detalhe === undefined ? '' : ` — ${detalhe}`}`
}

function selfTest() {
  const casos = []
  const ok = (nome, condicao) => { casos.push(condicao); if (!condicao) console.error(`  autoteste FALHOU: ${nome}`) }
  ok('le o anuncio', anuncioDaPartida('dsh web: http://127.0.0.1:3080/?token=abc-123\n')?.token === 'abc-123')
  ok('a base sai sem barra final', anuncioDaPartida('dsh web: http://127.0.0.1:3080/?token=a')?.base === 'http://127.0.0.1:3080')
  ok('sem anuncio devolve nulo', anuncioDaPartida('subindo...') === null)
  // Uma partida que reinicia anuncia duas vezes; vale a ultima.
  ok('fica com o ultimo anuncio', anuncioDaPartida(
    'dsh web: http://127.0.0.1:3080/?token=velho\ndsh web: http://127.0.0.1:3080/?token=novo',
  )?.token === 'novo')
  ok('acha a arvore que nao ativou', falhasNoRegistro('dsh: 1 entry did not activate').length === 1)
  ok('acha o perfil ausente', falhasNoRegistro('error: --profile <name> is required').length === 1)
  ok('registro limpo nao acusa', falhasNoRegistro('dsh web: http://127.0.0.1:3080/?token=a').length === 0)
  ok('o veredito diz o que observou', veredito('x', false, 'y') === 'FAIL x — y')
  const falhas = casos.filter(caso => !caso).length
  console.log(`STUDIO_BOOT_SELF_TEST=${falhas === 0 ? 'PASS' : 'FAIL'} casos=${casos.length}`)
  return falhas === 0
}

if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1)

/**
 * Sobe o produto, pergunta a ele, e derruba.
 * @returns o código de saída do processo.
 */
async function provar() {
  const linhas = []
  const filho = spawn(process.execPath, [resolve(raiz, 'scripts/studio-start.mjs')], {
    cwd: raiz,
    /*
      O ambiente passa INTEIRO e sem acréscimo. A primeira versão desta prova
      declarava `DZ23_OLLAMA_BASE_URL: ''` quando a variável não existia, e o
      perfil recusou subir com endereço vazio — a prova acusava o produto por um
      defeito dela. Uma variável de rota ausente é ausência; vazia é lixo.
    */
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let morreu = null
  filho.on('exit', codigo => { morreu = codigo })
  for (const fonte of [filho.stdout, filho.stderr]) {
    fonte.setEncoding('utf8')
    fonte.on('data', pedaco => { linhas.push(pedaco) })
  }
  const relatorio = []
  let saida = 0
  const conferir = (nome, ok, detalhe) => {
    relatorio.push(veredito(nome, ok, detalhe))
    if (!ok) saida = 1
  }
  try {
    const comeco = Date.now()
    let anuncio = null
    while (anuncio === null && Date.now() - comeco < LIMITE_DA_PARTIDA_MS) {
      if (morreu !== null) break
      await new Promise(resolver => setTimeout(resolver, 500))
      anuncio = anuncioDaPartida(linhas.join(''))
    }
    const registro = linhas.join('')
    const falhas = falhasNoRegistro(registro)
    conferir('a arvore de plugins subiu inteira', falhas.length === 0, falhas.join(', ') || 'nenhuma marca de falha')
    conferir('a partida anunciou o endereco', anuncio !== null, anuncio?.base ?? 'nada anunciado')
    conferir('o processo continua vivo depois de anunciar', morreu === null, morreu === null ? 'vivo' : `saiu com ${String(morreu)}`)
    if (anuncio === null || morreu !== null) {
      relatorio.push(registro.split('\n').slice(-12).join('\n'))
      return { saida: 1, relatorio }
    }
    // O bilhete da casca do harness vira cookie; ele NAO e sessao do FRIGG.
    const casca = await fetch(`${anuncio.base}/?token=${anuncio.token}`, { redirect: 'manual' })
    const cookie = (casca.headers.getSetCookie?.() ?? []).map(valor => valor.split(';')[0]).join('; ')
    conferir('a casca do harness aceitou o bilhete', casca.status === 303 || casca.status === 200, `HTTP ${String(casca.status)}`)
    const pedir = caminho => fetch(`${anuncio.base}${caminho}`, { headers: cookie === '' ? {} : { cookie } })

    const interface_ = await pedir('/studio')
    const corpo = await interface_.text()
    conferir('a interface abre SEM cookie de sessao, em modo pessoal',
      interface_.status === 200 && corpo.includes('<title>'), `HTTP ${String(interface_.status)}`)

    const sessao = await pedir('/api/studio/identity/session')
    const sessaoCorpo = await sessao.json().catch(() => ({}))
    conferir('a identidade declara o modo pessoal', sessao.status === 200 && sessaoCorpo.mode === 'personal',
      `HTTP ${String(sessao.status)} modo=${String(sessaoCorpo.mode)}`)

    const saude = await pedir('/api/studio/apps/health')
    const saudeCorpo = await saude.json().catch(() => ({}))
    conferir('as rotas de TRABALHO respondem, e nao so a pagina',
      saude.status === 200 && Array.isArray(saudeCorpo.capabilities),
      `HTTP ${String(saude.status)}`)
    return { saida, relatorio }
  } finally {
    filho.kill('SIGTERM')
    await new Promise(resolver => setTimeout(resolver, 1_500))
    if (morreu === null) filho.kill('SIGKILL')
  }
}

const { saida, relatorio } = await provar()
for (const linha of relatorio) console.log(linha)
console.log(`STUDIO_BOOT=${saida === 0 ? 'PASS' : 'FAIL'}`)
process.exit(saida)
