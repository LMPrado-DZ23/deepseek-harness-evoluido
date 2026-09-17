import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * Todo pacote de workspace IMPORTADO precisa estar DECLARADO por quem importa.
 *
 * Este portão nasceu de um defeito que a CI apanhou e a máquina local não: o
 * `plugins/action-approval` importava `@deepseek-ai/dsh-user-approval` sem
 * declará-lo, e `gate:typecheck` passava aqui há cinco entregas seguidas
 * enquanto o clone limpo da CI reprovava com quatro erros de tipo.
 *
 * O motivo de passar localmente é o pnpm: a árvore de links da raiz deixa um
 * pacote não declarado alcançável quando alguém mais no workspace o declara.
 * Num clone limpo com `--frozen-lockfile --filter '@dz23-studio/*...'` ele
 * simplesmente não é instalado, e o `import type` falha. Um `import type` que
 * falha não quebra só uma linha: o tipo do evento some, a chave deixa de
 * pertencer a `keyof Events` e os parâmetros do ouvinte viram `any` implícito —
 * foi assim que UMA dependência ausente virou quatro erros.
 *
 * A lição é a de sempre neste repositório: existir localmente não é existir em
 * execução. A máquina de quem desenvolve é mais permissiva que a de destino, e
 * portão que roda só na máquina permissiva não é portão.
 */

const raiz = process.cwd()

/** Os prefixos que são pacotes DESTE workspace, e não dependências públicas. */
const PREFIXOS = ['@deepseek-ai/', '@dz23-studio/', '@studio/']

/**
 * Os pacotes que cada `package.json` do workspace declara.
 * @param manifesto - o conteúdo do `package.json`.
 * @returns o conjunto de nomes declarados, de qualquer natureza.
 */
export function declarados(manifesto) {
  const campos = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  return new Set(campos.flatMap(campo => Object.keys(manifesto[campo] ?? {})))
}

/**
 * Os pacotes de workspace que um arquivo TypeScript importa.
 *
 * Reconhece `import`, `import type`, `export ... from` e `import(...)`. O que
 * ele NÃO faz é resolver o módulo: a pergunta aqui é sobre o que está escrito,
 * e resolver usaria justamente a árvore de links que esconde o defeito.
 * @param fonte - o conteúdo do arquivo.
 * @returns os nomes de pacote importados.
 */
export function importados(fonte) {
  const achados = new Set()
  // `from '<x>'`, `import '<x>'` e `import('<x>')`, com aspas simples ou duplas.
  const padrao = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu
  for (const casamento of fonte.matchAll(padrao)) {
    const especificador = casamento[1]
    const prefixo = PREFIXOS.find(candidato => especificador.startsWith(candidato))
    if (prefixo === undefined) continue
    // `@escopo/pacote/subcaminho` declara-se pelo pacote, não pelo subcaminho.
    const partes = especificador.split('/')
    achados.add(`${partes[0]}/${partes[1]}`)
  }
  return achados
}

function arquivosDe(diretorio) {
  const saida = []
  for (const entrada of readdirSync(diretorio)) {
    if (entrada === 'node_modules' || entrada === 'lib' || entrada === 'dist') continue
    const caminho = resolve(diretorio, entrada)
    if (statSync(caminho).isDirectory()) { saida.push(...arquivosDe(caminho)); continue }
    if (/\.(ts|tsx|mts)$/u.test(entrada)) saida.push(caminho)
  }
  return saida
}

/**
 * Confere um pacote do workspace.
 * @param diretorio - a pasta do pacote.
 * @returns as faltas encontradas.
 */
export function conferirPacote(diretorio) {
  const manifesto = JSON.parse(readFileSync(resolve(diretorio, 'package.json'), 'utf8'))
  const jaDeclarados = declarados(manifesto)
  const faltas = new Map()
  for (const arquivo of arquivosDe(resolve(diretorio, 'src'))) {
    for (const pacote of importados(readFileSync(arquivo, 'utf8'))) {
      if (pacote === manifesto.name || jaDeclarados.has(pacote)) continue
      if (!faltas.has(pacote)) faltas.set(pacote, relative(raiz, arquivo))
    }
  }
  return [...faltas].map(([pacote, arquivo]) => ({ pacote, arquivo, dono: manifesto.name }))
}

function pacotesDoWorkspace() {
  const saida = []
  for (const area of ['plugins', 'apps']) {
    const base = resolve(raiz, area)
    let entradas = []
    try { entradas = readdirSync(base) } catch { continue }
    for (const entrada of entradas) {
      const caminho = resolve(base, entrada)
      try {
        statSync(resolve(caminho, 'package.json'))
        statSync(resolve(caminho, 'src'))
      } catch { continue }
      saida.push(caminho)
    }
  }
  return saida
}

function autoTeste() {
  const conferencias = []
  const declara = nome => declarados({ dependencies: { [nome]: 'workspace:*' } }).has(nome)
  conferencias.push(['declaração em dependencies conta', declara('@dz23-studio/identity')])
  conferencias.push([
    'declaração em devDependencies também conta',
    declarados({ devDependencies: { '@studio/x': '*' } }).has('@studio/x'),
  ])
  conferencias.push([
    'import type é import',
    importados(`import type {} from '@deepseek-ai/dsh-user-approval'`).has('@deepseek-ai/dsh-user-approval'),
  ])
  conferencias.push([
    'reexport conta',
    importados(`export { x } from '@dz23-studio/policy'`).has('@dz23-studio/policy'),
  ])
  conferencias.push([
    'import dinâmico conta',
    importados(`const m = await import('@studio/coisa')`).has('@studio/coisa'),
  ])
  conferencias.push([
    'subcaminho é atribuído ao PACOTE',
    importados(`import x from '@dz23-studio/identity/sub/mod.js'`).has('@dz23-studio/identity'),
  ])
  conferencias.push([
    'pacote público não entra',
    importados(`import z from 'zod'`).size === 0,
  ])
  conferencias.push([
    'caminho relativo não entra',
    importados(`import x from './vizinho.js'`).size === 0,
  ])
  const falhas = conferencias.filter(([, passou]) => !passou).map(([nome]) => nome)
  console.log(`DECLARED_IMPORTS_SELF_TEST=${falhas.length === 0 ? 'PASS' : 'FAIL'} checks=${String(conferencias.length)}`)
  for (const falha of falhas) console.log(`- autoteste falhou: ${falha}`)
  return falhas.length === 0
}

if (process.argv.includes('--self-test')) {
  process.exit(autoTeste() ? 0 : 1)
}

const faltas = pacotesDoWorkspace().flatMap(conferirPacote)
console.log(`DECLARED_IMPORTS=${faltas.length === 0 ? 'PASS' : 'FAIL'} pacotes=${String(pacotesDoWorkspace().length)} faltas=${String(faltas.length)}`)
for (const falta of faltas) {
  console.log(`- ${falta.dono} importa ${falta.pacote} sem declarar (${falta.arquivo.split(sep).join('/')})`)
}
process.exit(faltas.length === 0 ? 0 : 1)
