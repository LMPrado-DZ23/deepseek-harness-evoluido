import { STUDIO_CATEGORIES, type Category } from './categories'
import signals from './i18n/categorySignals.pt-BR.json'

/**
 * Qual tipo de aplicativo a pessoa está descrevendo.
 *
 * Isto existe porque o produto tinha um buraco no meio: a categoria só mudava
 * quando alguém CLICAVA numa das sete sugestões prontas. Quem escrevia a
 * própria ideia — "quero uma agenda para minha clínica marcar consultas" —
 * recebia uma página de apresentação, porque `landing-page` era o valor inicial
 * e nada nunca o revisava. E clicar numa sugestão para corrigir apagava o texto
 * escrito, então não havia como ter o texto próprio e a categoria certa.
 *
 * O palpite é DETERMINÍSTICO de propósito. Ele não pede nada a modelo nenhum:
 * roda enquanto a pessoa digita, não custa, não sai do computador e pode ser
 * conferido por teste. E ele é só um PALPITE — a tela mostra o que entendeu e
 * deixa corrigir, porque um palpite invisível é exatamente o defeito que isto
 * veio consertar.
 */

/** Sem acento, sem maiúscula e com pontuação virando espaço, para casar frase. */
function normalize(text: string): string {
  return ` ${text.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()} `
}

/**
 * Os sinais de cada categoria, com peso.
 *
 * Frase pesa mais do que palavra porque "painel" sozinho não distingue o painel
 * que MOSTRA números do painel que EDITA cadastros — e essa é a confusão mais
 * cara aqui: uma é só leitura, a outra escreve no banco.
 */
/**
 * Os sinais de cada categoria, com peso, no catálogo do idioma.
 *
 * Eles ficam em `i18n/categorySignals.pt-BR.json` porque são VOCABULÁRIO: o
 * palpite lê o que a pessoa escreve, e o que ela escreve depende do idioma. Um
 * dia em que o Studio falar outra língua, este arquivo é o que muda — o código
 * aqui não.
 *
 * Frase pesa mais do que palavra porque "painel" sozinho não distingue o painel
 * que MOSTRA números do painel que EDITA cadastros — e essa é a confusão mais
 * cara aqui: uma é só leitura, a outra escreve no banco.
 */
const SIGNAL_SOURCE = signals as Readonly<Record<string, readonly (readonly (string | number)[])[]>>

/**
 * A tabela lida do catálogo, conferida na carga.
 *
 * Uma categoria sem sinais no catálogo pontuaria ZERO para sempre e nunca seria
 * palpitada — um buraco silencioso, do tipo que só aparece quando uma pessoa
 * reclama de receber a coisa errada. Aqui ela é erro na hora de carregar.
 */
const SIGNALS: Readonly<Record<Category, readonly (readonly [string, number])[]>> = (() => {
  const table = {} as Record<Category, readonly (readonly [string, number])[]>
  for (const category of STUDIO_CATEGORIES) {
    const entries = SIGNAL_SOURCE[category]
    if (entries === undefined || entries.length === 0) throw new Error(`CATEGORY_SIGNALS_MISSING:${category}`)
    table[category] = entries.map(entry => [String(entry[0]), Number(entry[1])] as const)
  }
  return table
})()

/** A categoria usada quando o texto não diz nada que este palpite reconheça. */
export const DEFAULT_CATEGORY: Category = 'landing-page'

/**
 * O palpite de categoria para um texto.
 * @param brief - a ideia, com as palavras da pessoa.
 * @returns a categoria de maior pontuação; o padrão quando nada pontua.
 */
export function suggestCategory(brief: string): Category {
  const text = normalize(brief)
  if (text.trim() === '') return DEFAULT_CATEGORY
  let best: Category = DEFAULT_CATEGORY
  let bestScore = 0
  // A ordem do empate é a das categorias declaradas, e não a de iteração de um
  // objeto: empate resolvido por acaso muda de resposta quando alguém acrescenta
  // um sinal em outro lugar.
  for (const category of STUDIO_CATEGORIES) {
    let score = 0
    for (const [signal, weight] of SIGNALS[category]) if (text.includes(signal)) score += weight
    if (score > bestScore) { best = category; bestScore = score }
  }
  return best
}
