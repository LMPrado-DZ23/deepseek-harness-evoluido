#!/usr/bin/env node
/**
 * Portão da FRESCURA do artefato versionado.
 *
 * `gate:tracked-lib` confere se o `lib/` versionado está COMPLETO — se todo
 * import relativo dele aponta para outro arquivo que o git tem. Ele nunca
 * conferiu se o `lib/` corresponde ao `src/` de hoje, e essa diferença custou
 * caro: `plugins/tenancy/lib/` ficou parado na OS-23 enquanto o `src/` chegava
 * à OS-38, e o estreitamento de `listMembers` — uma correção de autorização —
 * nunca esteve em vigor para quem executasse o artefato versionado. Dezenas de
 * commits, e nada acusava, porque quem roda no monorepo resolve os TIPOS no
 * `src/` e não percebe que o CÓDIGO vem do `lib/`.
 *
 * Um artefato desatualizado é a forma mais silenciosa de SEGUNDA VERDADE que
 * este repositório já produziu: o código está certo no lugar que todo mundo lê
 * e errado no lugar que de fato executa.
 *
 * Como ele confere: compila o `src/` de cada plugin com o MESMO
 * `tsconfig.build.json` para um diretório temporário e compara byte a byte com
 * o que o git tem. A saída do `tsc` é determinística para a mesma entrada e a
 * mesma versão — inclusive os `.map`, cujos caminhos são relativos —, então uma
 * diferença é diferença de FONTE, não de máquina.
 *
 * Ele lê do ÍNDICE do git, e não do disco, pelo mesmo motivo do portão irmão:
 * precisa reprovar o estado que está prestes a ser commitado.
 *
 * Uso: node scripts/check-lib-freshness.mjs [--self-test]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const DIVERGENCIAS = ['AUSENTE', 'DESATUALIZADO', 'SOBRANDO', 'NAO_COMPILA']

/**
 * Onde o artefato versionado difere do que o `src/` de hoje produz.
 *
 * As três formas são respostas diferentes e nunca colapsam:
 * `AUSENTE` é um arquivo que a compilação produz e o git não tem — é o módulo
 * novo que o `.gitignore` engoliu; `DESATUALIZADO` é o mesmo caminho com bytes
 * diferentes — é o conserto que não chegou ao artefato; `SOBRANDO` é um arquivo
 * versionado que a compilação NÃO produz mais — é o módulo removido do `src/`
 * que continua executável para quem consome o pacote.
 * @param compilado - caminho relativo → conteúdo, recém-compilado.
 * @param versionado - caminho relativo → conteúdo, como o git tem.
 * @returns as divergências, uma por caminho.
 */
export function divergencias(compilado, versionado) {
  const achados = []
  for (const [caminho, conteudo] of compilado) {
    if (!versionado.has(caminho)) { achados.push({ caminho, tipo: 'AUSENTE' }); continue }
    if (versionado.get(caminho) !== conteudo) achados.push({ caminho, tipo: 'DESATUALIZADO' })
  }
  for (const caminho of versionado.keys()) {
    if (!compilado.has(caminho)) achados.push({ caminho, tipo: 'SOBRANDO' })
  }
  return achados
}

/**
 * As divergências de UM plugin, incluindo a de não compilar.
 *
 * Função exportada, e não um `try` dentro do laço do script: um plugin que NÃO
 * COMPILA é uma reprovação nomeada, e nunca um plugin "sem divergência" — não
 * dá para comparar contra o que não existe. Enquanto essa decisão morava na
 * montagem, sabotá-la não fazia teste nenhum falhar, que é a lição repetida
 * deste repositório.
 * @param plugin - o nome da pasta do plugin.
 * @param compilar - compila o `src/` e devolve caminho → conteúdo; pode lançar.
 * @param versionado - lê o `lib/` que o git tem: caminho → conteúdo.
 * @returns as divergências, já com o nome do plugin, ou a falha de compilação.
 */
export function achadosDoPlugin(plugin, compilar, versionado) {
  let compilado
  try {
    compilado = compilar(plugin)
  } catch (erro) {
    const detalhe = String(erro.stdout ?? erro.message).split('\n').slice(0, 3).join(' ')
    return [{ caminho: '', tipo: 'NAO_COMPILA', mensagem: `${plugin}: nao compila — ${detalhe}` }]
  }
  return divergencias(compilado, versionado(plugin)).map(achado => ({
    ...achado, mensagem: `${plugin}/lib/${achado.caminho}: ${achado.tipo}`,
  }))
}

/** Os plugins cujo `lib/` o git tem, pelo nome da pasta. */
function pluginsComLibVersionado() {
  const saida = execFileSync('git', ['ls-files', '-z', '--', 'plugins'], { encoding: 'utf8' })
  const nomes = new Set()
  for (const arquivo of saida.split('\0')) {
    const encontrado = /^plugins\/([^/]+)\/lib\//u.exec(arquivo)
    if (encontrado !== null) nomes.add(encontrado[1])
  }
  return [...nomes].sort()
}

/** O `lib/` versionado de um plugin, lido do ÍNDICE: caminho relativo → conteúdo. */
function libVersionado(plugin) {
  const saida = execFileSync('git', ['ls-files', '-z', '--', `plugins/${plugin}/lib`], { encoding: 'utf8' })
  const mapa = new Map()
  for (const arquivo of saida.split('\0').filter(Boolean)) {
    mapa.set(relative(`plugins/${plugin}/lib`, arquivo), execFileSync('git', ['show', `:${arquivo}`], { encoding: 'utf8' }))
  }
  return mapa
}

function arquivosDe(raiz, prefixo = '') {
  const mapa = new Map()
  for (const entrada of readdirSync(join(raiz, prefixo))) {
    const caminho = prefixo === '' ? entrada : `${prefixo}/${entrada}`
    if (statSync(join(raiz, caminho)).isDirectory()) {
      for (const [interno, conteudo] of arquivosDe(raiz, caminho)) mapa.set(interno, conteudo)
    } else {
      mapa.set(caminho, readFileSync(join(raiz, caminho), 'utf8'))
    }
  }
  return mapa
}

/**
 * Compila o `src/` do plugin para um diretório temporário DENTRO do pacote.
 *
 * Dentro, e não em `/tmp`: os `.d.ts.map` guardam o caminho da fonte RELATIVO
 * ao `outDir`, então compilar para fora do pacote produz `../../home/...` onde
 * o artefato versionado tem `../src/...`. A diferença seria de LOCAL DE BUILD e
 * não de fonte, e sessenta falsos positivos afogariam os quatro verdadeiros —
 * que é como um portão barulhento deixa de ser lido.
 * @param plugin - o nome da pasta do plugin.
 * @returns caminho relativo → conteúdo, recém-compilado.
 */
function compilar(plugin) {
  const destino = mkdtempSync(resolve(`plugins/${plugin}`, '.lib-freshness-'))
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', destino], {
      cwd: resolve(`plugins/${plugin}`), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return arquivosDe(destino)
  } finally {
    rmSync(destino, { recursive: true, force: true })
  }
}

function selfTest() {
  const compilado = new Map([['a.js', 'um'], ['b.js', 'dois'], ['novo.js', 'tres']])
  const versionado = new Map([['a.js', 'um'], ['b.js', 'OUTRO'], ['velho.js', 'quatro']])
  const achados = divergencias(compilado, versionado)
  const tipos = Object.fromEntries(achados.map(item => [item.caminho, item.tipo]))
  const iguaisNaoAcusam = divergencias(new Map([['a.js', 'um']]), new Map([['a.js', 'um']])).length === 0
  // Um portão que passa com entrada vazia não é portão: sem esta linha, um
  // `lib/` inteiro apagado do índice passaria como "nada divergente".
  const vazioAcusa = divergencias(new Map([['a.js', 'um']]), new Map()).length === 1
  // O plugin que NAO COMPILA: ele reprova NOMEADO, e nunca passa como
  // "sem divergencia". Sem esta linha, apagar a contagem dessa reprovacao nao
  // fazia teste nenhum falhar.
  const naoCompila = achadosDoPlugin('x', () => { throw new Error('erro de tipo') }, () => new Map())
  const compilaAcusa = naoCompila.length === 1 && naoCompila[0].tipo === 'NAO_COMPILA'
  const compilaOk = achadosDoPlugin('x', () => new Map([['a.js', 'um']]), () => new Map([['a.js', 'um']])).length === 0
  const passou = compilaAcusa && compilaOk && achados.length === 3
    && tipos['novo.js'] === 'AUSENTE' && tipos['b.js'] === 'DESATUALIZADO' && tipos['velho.js'] === 'SOBRANDO'
    && iguaisNaoAcusam && vazioAcusa
  console.log(`LIB_FRESHNESS_SELF_TEST=${passou ? 'PASS' : 'FAIL'} achados=${String(achados.length)} casos=5`)
  return passou
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  const plugins = pluginsComLibVersionado()
  if (plugins.length === 0) {
    console.error('LIB_FRESHNESS=FAIL motivo=nenhum plugin com lib versionado foi encontrado')
    process.exitCode = 1
  } else {
    let total = 0
    for (const plugin of plugins) {
      const achados = achadosDoPlugin(plugin, compilar, libVersionado)
      for (const achado of achados) console.error(achado.mensagem)
      total += achados.length
    }
    console.log(`LIB_FRESHNESS=${total === 0 ? 'PASS' : 'FAIL'} plugins=${String(plugins.length)} achados=${String(total)}`)
    process.exitCode = total === 0 ? 0 : 1
  }
}
