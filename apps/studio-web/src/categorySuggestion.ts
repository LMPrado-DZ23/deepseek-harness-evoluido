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

/** A chave do catálogo com o ramo de atividade — não é uma categoria. */
const TRADE_KEY = 'ramo-de-atividade'

/**
 * O RAMO da pessoa, quando o texto não diz o que o aplicativo faz.
 *
 * "sistema pra barbearia" e "app de delivery" não descrevem função nenhuma: os
 * sinais de cima pontuam zero e a pessoa recebia uma página de apresentação,
 * que é o padrão. O ramo é um palpite melhor do que o padrão — quem escreve
 * "barbearia" quer marcar horário — e é o ÚNICO lugar onde este arquivo
 * adivinha a partir do ofício, e não do que foi escrito.
 *
 * Por isso ele NÃO liga `understood`. A tela só afirma "entendemos isto pelo
 * seu texto" quando algum sinal de função pontuou; o ramo escolhe um ponto de
 * partida melhor e continua dizendo, com honestidade, que não entendeu o
 * pedido. Confundir as duas coisas foi o achado C-N4, e ele não volta por aqui.
 */
const TRADES: readonly (readonly [string, Category])[] = (() => {
  const raw = (SIGNAL_SOURCE as Record<string, readonly (readonly (string | number)[])[]>)[TRADE_KEY]
  if (raw === undefined || raw.length === 0) throw new Error(`CATEGORY_TRADES_MISSING`)
  return raw.map(entry => {
    const category = String(entry[1]) as Category
    // Um ramo apontando para categoria que não existe mandaria a pessoa para
    // uma tela que não existe. Erro na carga, e não na hora de usar.
    if (!STUDIO_CATEGORIES.includes(category)) throw new Error(`CATEGORY_TRADE_UNKNOWN:${String(entry[0])}`)
    return [String(entry[0]), category] as const
  })
    // O mais ESPECÍFICO primeiro. Casando pela ordem do arquivo, "oficina"
    // ganharia de "oficina mecânica" só por estar escrito antes — e o palpite
    // passaria a depender de onde alguém colou a linha nova.
    .sort((left, right) => right[0].length - left[0].length)
})()

/**
 * De onde veio o palpite.
 *
 * São TRÊS estados, e não dois, porque a tela tem três coisas diferentes para
 * dizer: entendi o que você quer (`text`), reconheci só o seu ramo e escolhi um
 * começo (`trade`), e não entendi nada (`none`). Com dois estados, quem
 * escrevia "sistema pra barbearia" via o tipo já em "Agenda de horários" E a
 * frase "não deu para entender o tipo pelo seu texto" — duas afirmações que se
 * contradizem na mesma tela.
 *
 * `understood` continua existindo e continua querendo dizer a mesma coisa: o
 * palpite veio do TEXTO. Ele é `basis === 'text'`.
 */
export interface CategoryGuess {
  readonly category: Category
  readonly understood: boolean
  readonly basis: 'text' | 'trade' | 'none'
}

/** A categoria usada quando o texto não diz nada que este palpite reconheça. */
export const DEFAULT_CATEGORY: Category = 'landing-page'

/**
 * O palpite de categoria para um texto, e SE ele entendeu alguma coisa.
 *
 * Devolver só a categoria era indistinguível de não entender nada: o padrão
 * `landing-page` saía igual quando o texto falava de página e quando o texto
 * não dizia nada que este palpite reconheça. A tela, por cima, afirmava
 * "Entendemos isto pelo seu texto" — e afirmava isso para a maioria dos textos
 * curtos. Uma afirmação dessas, falsa, é pior do que não afirmar nada: ela
 * convence a pessoa a não corrigir.
 * @param brief - a ideia, com as palavras da pessoa.
 * @returns a categoria e `understood`, que diz se algum sinal pontuou.
 */
export function categoryGuess(brief: string): CategoryGuess {
  const text = normalize(brief)
  if (text.trim() === '') return { category: DEFAULT_CATEGORY, understood: false, basis: 'none' }
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
  if (bestScore > 0) return { category: best, understood: true, basis: 'text' }
  for (const [trade, category] of TRADES) if (text.includes(` ${trade}`)) return { category, understood: false, basis: 'trade' }
  return { category: DEFAULT_CATEGORY, understood: false, basis: 'none' }
}

/**
 * A categoria palpitada, sem a informação de confiança.
 * @param brief - a ideia.
 * @returns a categoria.
 */
export function suggestCategory(brief: string): Category {
  return categoryGuess(brief).category
}
