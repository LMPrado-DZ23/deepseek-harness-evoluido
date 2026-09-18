#!/usr/bin/env node
/**
 * O PORTÃO DOS TRÊS IDIOMAS.
 *
 * Adendo `FRIGG-CONTA-APOIADOR-INTERNACIONAL-R2`: o produto passa a ter
 * português do Brasil, inglês e espanhol de verdade. Este portão existe porque
 * "de verdade" tem quatro formas de ser falso, e nenhuma delas é pega por
 * `gate:i18n`, que confere outra coisa — se o texto exibido está em catálogo.
 *
 * 1. **chave faltando.** Um catálogo sem uma chave desenha `undefined` no meio
 *    de um botão. O TypeScript pega o que passa pelo registro tipado; este
 *    portão pega o resto, inclusive chave A MAIS, que é lixo que ninguém lê.
 * 2. **tradução que é cópia.** Copiar o português e trocar o nome do arquivo
 *    passa em qualquer conferência de paridade. O adendo proíbe exatamente
 *    isso: "não aprovar traduções idênticas por mera paridade".
 * 3. **interpolação perdida.** `{n}` que some na tradução deixa a frase sem o
 *    número, e ninguém percebe até alguém ler a tela em espanhol.
 * 4. **arquivo órfão.** Um catálogo traduzido que existe no disco e não está no
 *    registro é trabalho que não chega a ninguém; o inverso é um registro que
 *    aponta para um arquivo que não existe.
 *
 * ## O que ele NÃO afirma
 *
 * Que o produto INTEIRO está em três idiomas. Ele mede os espaços de nomes
 * DECLARADOS como traduzidos, e a cobertura real está escrita na tela de
 * Preferências. Um portão que contasse cobertura pelo que já foi migrado seria
 * o teto móvel que o adendo proíbe.
 *
 * Uso: node scripts/check-idiomas.mjs [--self-test]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const raiz = process.cwd()
const PASTA = 'apps/studio-web/src/i18n'
const REGISTRO = join(PASTA, 'catalogos.ts')
const REFERENCIA = 'pt-BR'

/**
 * Os idiomas e os espaços de nomes que o registro declara.
 *
 * Lidos do CÓDIGO, e não de uma lista repetida aqui: uma segunda lista
 * divergiria no dia em que um idioma entrasse, e a que divergisse em silêncio
 * seria justamente a do portão — que passaria a aprovar dois idiomas achando
 * que confere três.
 * @param fonte - o texto de `catalogos.ts`.
 * @param fonteIdioma - o texto de `idioma.ts`.
 * @returns os idiomas e os espaços.
 */
export function declarados(fonte, fonteIdioma) {
  const idiomas = [...(/export const IDIOMAS = \[([^\]]+)\]/u.exec(fonteIdioma)?.[1] ?? '')
    .matchAll(/'([^']+)'/gu)].map(achado => achado[1])
  const espacos = [...(/ESPACOS_TRADUZIDOS: readonly EspacoDeNomes\[\] = \[([^\]]+)\]/u.exec(fonte)?.[1] ?? '')
    .matchAll(/'([^']+)'/gu)].map(achado => achado[1])
  return { idiomas, espacos }
}

/**
 * Todos os caminhos de chave de um catálogo, achatados.
 * @param valor - o objeto ou folha.
 * @param prefixo - o caminho até aqui.
 * @returns os caminhos, ordenados.
 */
export function caminhos(valor, prefixo = '') {
  if (typeof valor !== 'object' || valor === null) return [prefixo.slice(0, -1)]
  return Object.entries(valor).flatMap(([chave, dentro]) => caminhos(dentro, `${prefixo}${chave}.`)).sort()
}

/**
 * O valor de um caminho dentro de um catálogo.
 * @param catalogo - o catálogo.
 * @param caminho - o caminho com pontos.
 * @returns o valor, ou `undefined`.
 */
export function valorEm(catalogo, caminho) {
  return caminho.split('.').reduce((atual, parte) => (atual == null ? undefined : atual[parte]), catalogo)
}

/** As interpolações de um texto, como `{n}` e `{custo}`. */
export function interpolacoes(texto) {
  return typeof texto === 'string' ? [...texto.matchAll(/\{(\w+)\}/gu)].map(achado => achado[1]).sort() : []
}

/**
 * Os achados, dados os catálogos já lidos.
 *
 * Extraída porque a decisão que mora no corpo do roteiro não é exercitada por
 * teste nenhum — a lição que este repositório aprendeu mais de dez vezes.
 * @param catalogos - espaço → idioma → catálogo.
 * @param idiomas - os idiomas declarados.
 * @param espacos - os espaços declarados.
 * @returns os achados.
 */
export function achados(catalogos, idiomas, espacos) {
  const lista = []
  const reprove = (onde, motivo) => lista.push({ onde, motivo })
  if (idiomas.length < 2) reprove(REGISTRO, 'o registro declara menos de dois idiomas — não há o que conferir')
  if (espacos.length === 0) reprove(REGISTRO, 'nenhum espaço de nomes declarado como traduzido')

  for (const espaco of espacos) {
    const referencia = catalogos[espaco]?.[REFERENCIA]
    if (referencia === undefined) {
      reprove(`${espaco}.${REFERENCIA}`, 'o catálogo de referência não existe')
      continue
    }
    const esperados = caminhos(referencia)
    for (const idioma of idiomas) {
      if (idioma === REFERENCIA) continue
      const catalogo = catalogos[espaco]?.[idioma]
      if (catalogo === undefined) {
        reprove(`${espaco}.${idioma}`, 'declarado no registro e ausente do disco')
        continue
      }
      const tem = caminhos(catalogo)
      for (const chave of esperados) if (!tem.includes(chave)) reprove(`${espaco}.${idioma}`, `falta a chave \`${chave}\``)
      for (const chave of tem) if (!esperados.includes(chave)) reprove(`${espaco}.${idioma}`, `tem a chave \`${chave}\`, que não existe na referência`)

      let iguais = 0
      for (const chave of esperados) {
        const daReferencia = valorEm(referencia, chave)
        const traduzido = valorEm(catalogo, chave)
        if (traduzido === undefined) continue
        const esperada = interpolacoes(daReferencia)
        const obtida = interpolacoes(traduzido)
        if (esperada.join(',') !== obtida.join(',')) {
          reprove(`${espaco}.${idioma}`, `a chave \`${chave}\` perdeu ou inventou interpolação: ${JSON.stringify(esperada)} → ${JSON.stringify(obtida)}`)
        }
        if (typeof traduzido === 'string' && traduzido === daReferencia) iguais += 1
      }
      /*
        UM catálogo inteiro igual ao português é cópia, e não tradução.

        A comparação é por PROPORÇÃO e não por ocorrência: "FRIGG", "Plugins" e
        "Tokens" são iguais nas três línguas de propósito, e reprovar cada uma
        delas obrigaria a inventar diferença onde não há. Metade igual, não.
      */
      if (esperados.length > 0 && iguais / esperados.length > 0.5) {
        reprove(`${espaco}.${idioma}`, `${iguais} de ${esperados.length} textos são idênticos ao português — isto é cópia, não tradução`)
      }
    }
  }
  return lista
}

if (process.argv.includes('--self-test')) {
  let casos = 0
  const check = (condicao, mensagem) => { casos += 1; if (!condicao) { process.stdout.write(`IDIOMAS_SELF_TEST=FAIL ${mensagem}\n`); process.exit(1) } }
  const base = { a: { 'pt-BR': { x: 'olá', y: { z: 'com {n}' } } } }
  const bom = { a: { ...base.a, en: { x: 'hello', y: { z: 'with {n}' } } } }
  check(caminhos({ a: { b: 'x' } }).join() === 'a.b', 'nao achatou o caminho')
  check(valorEm({ a: { b: 'x' } }, 'a.b') === 'x', 'nao leu o valor pelo caminho')
  check(interpolacoes('tem {n} e {custo}').join() === 'custo,n', 'nao achou as interpolacoes')
  check(achados(bom, ['pt-BR', 'en'], ['a']).length === 0, 'reprovou catalogo correto')
  check(achados({ a: base.a }, ['pt-BR', 'en'], ['a']).length === 1, 'nao pegou catalogo ausente')
  check(achados({ a: { ...base.a, en: { x: 'hello' } } }, ['pt-BR', 'en'], ['a']).length === 1, 'nao pegou chave faltando')
  check(achados({ a: { ...base.a, en: { x: 'hello', y: { z: 'with {n}' }, w: 'extra' } } }, ['pt-BR', 'en'], ['a']).length === 1, 'nao pegou chave a mais')
  check(achados({ a: { ...base.a, en: { x: 'hello', y: { z: 'without it' } } } }, ['pt-BR', 'en'], ['a']).length === 1, 'nao pegou interpolacao perdida')
  check(achados({ a: { ...base.a, en: { x: 'olá', y: { z: 'com {n}' } } } }, ['pt-BR', 'en'], ['a']).length === 1, 'aceitou copia do portugues')
  check(achados({}, ['pt-BR'], ['a']).length === 2, 'nao reprovou registro de um idioma so')
  process.stdout.write(`IDIOMAS_SELF_TEST=PASS casos=${casos}\n`)
  process.exit(0)
}

const fonte = readFileSync(resolve(raiz, REGISTRO), 'utf8')
const fonteIdioma = readFileSync(resolve(raiz, PASTA, 'idioma.ts'), 'utf8')
const { idiomas, espacos } = declarados(fonte, fonteIdioma)

const catalogos = {}
for (const espaco of espacos) {
  catalogos[espaco] = {}
  for (const idioma of idiomas) {
    const arquivo = resolve(raiz, PASTA, `${espaco}.${idioma}.json`)
    if (existsSync(arquivo)) catalogos[espaco][idioma] = JSON.parse(readFileSync(arquivo, 'utf8'))
  }
}

const lista = achados(catalogos, idiomas, espacos)

/*
  O ÓRFÃO: um catálogo traduzido no disco que o registro não conhece.

  Ele é trabalho que não chega a ninguém — e pior, dá a impressão de cobertura
  para quem olha a pasta.
*/
for (const arquivo of readdirSync(resolve(raiz, PASTA))) {
  const achado = /^(.+)\.([a-z]{2}(?:-[A-Z]{2})?)\.json$/u.exec(arquivo)
  if (achado === null) continue
  const [, espaco, idioma] = achado
  if (idioma === REFERENCIA || !idiomas.includes(idioma)) continue
  if (!espacos.includes(espaco)) lista.push({ onde: join(PASTA, arquivo), motivo: 'traduzido e fora do registro: ninguém o lê' })
}

for (const { onde, motivo } of lista) process.stdout.write(`  ${onde}: ${motivo}\n`)
process.stdout.write(`IDIOMAS=${lista.length === 0 ? 'PASS' : 'FAIL'} idiomas=${idiomas.join(',')} espacos=${espacos.join(',')} achados=${lista.length}\n`)
process.exitCode = lista.length === 0 ? 0 : 1
