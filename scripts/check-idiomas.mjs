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
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
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
 *//**
 * O que denuncia uma frase portuguesa parada no lugar da tradução.
 *
 * `ã`, `õ`, `ç`, `ê` e `ô` não existem em inglês nem em espanhol. As palavras da
 * lista existem em português e não nas outras duas — `aqui` é `aquí` em
 * espanhol, `suas` é `sus`, `aparecem` é `aparecen`. A lista é curta e fechada
 * de propósito: ela não tenta adivinhar idioma, só reconhecer o caso óbvio.
 */
const PORTUGUES_INCONFUNDIVEL = /[ãõçêô]|\b(?:não|você|vocês|são|então|também|aqui|suas|seus|sua|seu|está|estão|isso|aparecem|precisa|fazer|quem|onde)\b/iu

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
        if (typeof traduzido === 'string' && traduzido === daReferencia) {
          iguais += 1
          /*
            A proporção abaixo pega o catálogo copiado inteiro. UMA chave copiada
            ela não pega — e uma chave é suficiente para a pessoa ler português
            no meio da tela em inglês. Uma sabotagem provou isso: `tarefasVazio`
            voltou ao português no catálogo inglês e nada reprovou.

            Cobrar toda igualdade seria pior: "Plugins", "FRIGG" e "Tokens" são
            iguais nas três línguas de propósito. O que distingue coincidência de
            cópia é a frase TRAZER português dentro — um caractere que o inglês e
            o espanhol não têm, ou uma palavra que só existe em português. Aí não
            é a mesma palavra nas duas línguas: é a frase portuguesa parada no
            lugar da tradução.
          */
          if (PORTUGUES_INCONFUNDIVEL.test(daReferencia)) {
            reprove(`${espaco}.${idioma}`, `a chave \`${chave}\` é o português copiado: ${JSON.stringify(daReferencia)}`)
          }
        }
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
  // UMA chave copiada, com portugues inconfundivel dentro: a proporcao nao pega.
  check(achados({ a: { 'pt-BR': { x: 'Suas tarefas aparecem aqui.', y: 'abrir', z: 'fechar', w: 'salvar' },
    en: { x: 'Suas tarefas aparecem aqui.', y: 'open', z: 'close', w: 'save' } } }, ['pt-BR', 'en'], ['a']).length === 1,
    'aceitou UMA chave copiada do portugues, com a proporcao abaixo do limite')
  // E a coincidencia legitima continua passando: tres chaves iguais, sem portugues dentro.
  check(achados({ a: { 'pt-BR': { y: 'Plugins', z: 'Tokens', v: 'olá', u: 'abrir', t: 'fechar' },
    en: { y: 'Plugins', z: 'Tokens', v: 'hello', u: 'open', t: 'close' } } }, ['pt-BR', 'en'], ['a']).length === 0,
    'reprovou palavra que e igual nas duas linguas por natureza propria')
  process.stdout.write(`IDIOMAS_SELF_TEST=PASS casos=${casos}\n`)
  process.exit(0)
}

/**
 * O idioma ESCRITO NO CÓDIGO de uma tela traduzida, e dos módulos que ela usa.
 *
 * ## O que este pedaço pega, e nenhum catálogo pegaria
 *
 * Uma tela pode ter os três catálogos completos e ainda assim falar português a
 * quem escolheu inglês, porque o texto não veio de catálogo nenhum: veio de uma
 * FUNÇÃO. Foi o que uma revisão externa achou em 18/09/2026 — o rótulo acessível
 * do logotipo era `${MARCA.nome}: ir para a tela inicial`, fixo, dito em voz
 * alta só para quem usa leitor de tela — e o mesmo defeito estava, calado, nos
 * dois formatadores de número das Preferências: `toLocaleString('pt-BR')` escreve
 * `1.234` para quem lê `1,234`, o que não parece errado, parece OUTRO número.
 *
 * A marca de água mecânica dessa família é a ETIQUETA DE IDIOMA escrita à mão. É
 * o que este pedaço procura, no grafo de importações que sai das telas
 * declaradas em `TELAS_TRADUZIDAS`. A cobertura cresce sozinha: migrar um espaço
 * de nomes obriga a declarar a tela dele, e a tela entra na varredura no mesmo
 * dia.
 *
 * ## O que ele NÃO pega
 *
 * Prosa em português dentro de uma função. `ir para a tela inicial` não tem
 * acento, não tem etiqueta de idioma e é indistinguível de um identificador para
 * qualquer varredura. O que cobre essa metade é teste de comportamento: as telas
 * traduzidas são desenhadas nos três idiomas e o resultado é comparado entre
 * eles. Nenhum dos dois substitui o outro, e dizer o contrário aqui seria a
 * mentira mais cara deste arquivo.
 * @param raizDoApp - `apps/studio-web/src`, absoluto.
 * @param entradas - os caminhos das telas, relativos a ele.
 * @param ler - lê um arquivo, ou devolve `null` quando ele não existe.
 * @returns as reprovações.
 */
export function idiomaNoCodigo(raizDoApp, entradas, ler) {
  const vistos = new Set()
  const lista = []
  const fila = [...entradas]
  /*
    A varredura PARA na fronteira de uma área que ainda não foi migrada.

    Sem isso ela não para em lugar nenhum: o trilho importa uma constante de
    caminho da tela de Projetos, e por essa única linha o grafo alcança o
    aplicativo inteiro. Medido em 18/09/2026: dez etiquetas de idioma escritas à
    mão, das quais NOVE em telas que a interface declara, na cara da pessoa,
    como ainda em português.

    Cobrar essas nove aqui seria cobrar de uma área que ninguém prometeu — e a
    saída fácil seria afrouxar o portão. A fronteira é a PASTA: valem as pastas
    que hospedam uma tela declarada traduzida, mais a infraestrutura que serve a
    todas. Migrar um espaço de nomes declara a tela dele, e a pasta dele entra
    na varredura no mesmo dia.
  */
  const INFRAESTRUTURA = ['i18n', 'marca']
  const pastas = new Set([...entradas.map(caminho => caminho.split('/')[0]), ...INFRAESTRUTURA])
  const dentro = caminho => pastas.has(caminho.includes('/') ? caminho.split('/')[0] : '')
  /*
    O módulo de idioma é a ÚNICA exceção, e é evidente: ele é o lugar onde as
    etiquetas `pt-BR`, `en` e `es` têm de estar escritas, porque é ele que as
    declara. Uma exceção por pasta inteira — "i18n é exceção" — abriria a porta
    para esconder um formatador ali dentro.
  */
  const EXCECOES = new Set(['i18n/idioma.ts', 'i18n/catalogos.ts', 'i18n/texto.ts'])
  const ETIQUETA = /\b(?:toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)|Intl\.[A-Za-z]+)\s*\(\s*(['"`])((?:pt|en|es|fr|de|it|ja|zh)(?:-[A-Z]{2})?)\1/gu
  while (fila.length > 0) {
    const relativo = fila.shift()
    if (vistos.has(relativo)) continue
    vistos.add(relativo)
    const conteudo = ler(relativo)
    if (conteudo === null) continue
    if (!EXCECOES.has(relativo)) {
      for (const achado of conteudo.matchAll(ETIQUETA)) {
        lista.push({ onde: `apps/studio-web/src/${relativo}`, motivo: `escreve a etiqueta de idioma ${JSON.stringify(achado[2])} à mão: quem lê a tela em outro idioma recebe número ou texto na convenção errada` })
      }
    }
    for (const achado of conteudo.matchAll(/from\s+'(\.[^']+)'/gu)) {
      const destino = resolverRelativo(relativo, achado[1], ler)
      if (destino !== null && dentro(destino)) fila.push(destino)
    }
  }
  return lista
}

/**
 * O caminho de um import relativo, com a extensão que existe de verdade.
 * @param deOnde - o módulo que importa, relativo à raiz do app.
 * @param especificador - o texto do import.
 * @param ler - lê um arquivo, ou devolve `null`.
 * @returns o caminho, ou `null` quando nada resolve.
 */
export function resolverRelativo(deOnde, especificador, ler) {
  const base = deOnde.includes('/') ? deOnde.slice(0, deOnde.lastIndexOf('/')) : ''
  const partes = `${base}/${especificador}`.split('/')
  const pilha = []
  for (const parte of partes) {
    if (parte === '' || parte === '.') continue
    if (parte === '..') pilha.pop()
    else pilha.push(parte)
  }
  const alvo = pilha.join('/')
  for (const sufixo of ['', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']) {
    if (ler(`${alvo}${sufixo}`) !== null) return `${alvo}${sufixo}`
  }
  return null
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

/*
  E as TELAS declaradas traduzidas falam algum idioma à mão?
*/
const RAIZ_DO_APP = resolve(raiz, 'apps/studio-web/src')
const telas = [...(/TELAS_TRADUZIDAS: Readonly<Record<EspacoDeNomes, readonly string\[\]>> = \{([\s\S]*?)\n\}/u.exec(fonte)?.[1] ?? '').matchAll(/'([^']+\.tsx?)'/gu)].map(achado => achado[1])
if (telas.length === 0) {
  lista.push({ onde: REGISTRO, motivo: 'não declara nenhuma tela traduzida: sem elas, o portão confere catálogo e não confere tela' })
} else {
  const ler = relativo => {
    const arquivo = resolve(RAIZ_DO_APP, relativo)
    return existsSync(arquivo) && statSync(arquivo).isFile() ? readFileSync(arquivo, 'utf8') : null
  }
  lista.push(...idiomaNoCodigo(RAIZ_DO_APP, telas, ler))
}

for (const { onde, motivo } of lista) process.stdout.write(`  ${onde}: ${motivo}\n`)
process.stdout.write(`IDIOMAS=${lista.length === 0 ? 'PASS' : 'FAIL'} idiomas=${idiomas.join(',')} espacos=${espacos.join(',')} telas=${telas.length} achados=${lista.length}\n`)
process.exitCode = lista.length === 0 ? 0 : 1
