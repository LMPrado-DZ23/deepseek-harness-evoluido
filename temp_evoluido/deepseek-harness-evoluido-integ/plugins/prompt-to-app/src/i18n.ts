import { readFileSync } from 'node:fs'

interface CatalogObject { readonly [key: string]: string | CatalogObject }
type CatalogValue = string | CatalogObject

const catalog = JSON.parse(
  readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'),
) as CatalogObject

/**
 * O texto CRU do catálogo, antes de qualquer substituição.
 * @param key - o caminho no catálogo.
 * @returns o texto, com os marcadores ainda no lugar.
 */
function textoCru(key: string): string {
  const value = key.split('.').reduce<CatalogValue | undefined>((current, part) => {
    return typeof current === 'object' && current !== null ? current[part] : undefined
  }, catalog)
  if (typeof value !== 'string') throw new Error(`I18N_KEY_MISSING:${key}`)
  return value
}

export function t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  return textoCru(key).replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

/** Um marcador do MODELO do catálogo: `{assim}`. */
const MARCADOR = /\{([a-zA-Z0-9_]+)\}/gu

/**
 * Um texto do catálogo que vai para o MODELO, e não para uma pessoa.
 *
 * ## Por que ele é diferente de `t`
 *
 * `t` deixa um marcador sem valor VISÍVEL na frase, de propósito: numa mensagem
 * de erro, ler `{path}` é melhor que ler um buraco, e há um teste de contrato
 * afirmando isso para os três plugins de servidor. Essa decisão continua de pé.
 *
 * Num PROMPT ela se inverte. Visível para quem? O texto vai para o modelo, que
 * responde alguma coisa, e a resposta ruim aparece três etapas adiante, longe da
 * causa. Ninguém lê o prompt; lê-se só o resultado.
 *
 * Isto foi medido: uma sabotagem removeu o `schema` da montagem do reparo de
 * AppSpec e NADA acusou — nem o compilador, porque `params` é um `Record`
 * frouxo, nem teste nenhum. O produto teria passado a mandar ao modelo a palavra
 * `{schema}` no lugar da definição, e o sintoma seria "o modelo não conserta".
 * @param key - o caminho no catálogo.
 * @param params - os valores dos marcadores.
 * @returns o texto pronto, garantidamente sem marcador pendente.
 */
export function prompt(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  /*
    A conferência é sobre o MODELO, e acontece ANTES da substituição.

    A primeira versão desta função procurava marcadores no texto JÁ montado, e
    isso estava errado de um jeito que só aparece com conteúdo de verdade: o
    valor substituído pode conter chaves legitimamente. Quem escrevesse "uma API
    com rota /clientes/{id}" ou "um contador {contador}" derrubava o intake, com
    uma mensagem dizendo que faltava um parâmetro que nunca existiu.

    Ou seja: o conserto de hoje transformava texto da pessoa em falha do produto,
    que é pior que o defeito que ele veio consertar. Olhando o modelo, o dado
    passa intacto e a exigência continua de pé — o que se cobra é que QUEM CHAMA
    passe todo marcador que o catálogo declara.
  */
  const exigidos = [...textoCru(key).matchAll(MARCADOR)].map(achado => achado[1]!)
  const faltando = exigidos.filter(nome => params[nome] === undefined)
  if (faltando.length > 0) throw new Error(`PROMPT_PARAM_MISSING:${key}:${faltando.join(',')}`)
  return t(key, params)
}

