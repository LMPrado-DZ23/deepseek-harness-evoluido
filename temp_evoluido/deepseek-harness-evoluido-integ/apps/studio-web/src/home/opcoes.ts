import type { Category } from '../categories'
import type { PrivacyProfile } from '../presentation'
import t from '../i18n/pt-BR.json'

/** As quatro aparências oferecidas antes da criação. */
export type DesignPreset = 'modern' | 'professional' | 'colorful' | 'brand'

/**
 * Um atalho da home: o texto que ele escreve no compositor, o tipo que ele
 * escolhe, e se esse tipo ainda é protótipo inicial.
 *
 * O terceiro campo é a honestidade chegando na HORA da escolha. Ele estava num
 * parágrafo embaixo dos sete botões, o que obrigava a pessoa a casar três
 * palavras com três dos sete — e ninguém casa.
 */
export interface Atalho {
  readonly texto: string
  readonly categoria: Category
  readonly inicial: boolean
}

export const ATALHOS: readonly Atalho[] = [
  { texto: t.idea.landing, categoria: 'landing-page', inicial: false },
  { texto: t.idea.catalog, categoria: 'catalog', inicial: false },
  { texto: t.idea.formDatabase, categoria: 'form-database', inicial: false },
  { texto: t.idea.crudPanel, categoria: 'crud-panel', inicial: false },
  { texto: t.idea.scheduling, categoria: 'scheduling', inicial: true },
  { texto: t.idea.dashboard, categoria: 'dashboard', inicial: true },
  { texto: t.idea.saas, categoria: 'saas-authenticated', inicial: true },
  /*
    O ÚLTIMO atalho é o que diz que a lista não é a fronteira do produto.

    Sem ele, as sete pílulas são lidas como "isto é tudo que dá para pedir" — e
    era verdade até 18/09/2026. A medição contra o modelo real mostrou o custo:
    um jogo da velha tinha de se declarar página de apresentação.
  */
  { texto: t.idea.outro, categoria: 'outro', inicial: true },
]

/** Quantos atalhos a home mostra antes de "Mais". */
export const ATALHOS_VISIVEIS = 4

/**
 * Os atalhos que a home desenha agora.
 *
 * A referência mostra quatro pílulas e um "Mais". Sete pílulas numa linha só
 * quebram em duas fileiras e afundam o espaço livre que a especificação pede
 * para preservar — mas esconder as três de trás sem botão as tornaria
 * invisíveis, e três dos sete tipos do produto ficariam sem porta na home.
 * @param expandido - se a pessoa já apertou "Mais".
 * @returns os atalhos a desenhar, na ordem.
 */
export function atalhosDaHome(expandido: boolean): readonly Atalho[] {
  return expandido ? ATALHOS : ATALHOS.slice(0, ATALHOS_VISIVEIS)
}

/**
 * Se o botão "Mais" tem o que revelar.
 * @returns `true` quando existem atalhos além dos visíveis.
 */
export function temMaisAtalhos(): boolean {
  return ATALHOS.length > ATALHOS_VISIVEIS
}

/**
 * Os três perfis na ordem em que a tela os oferece, cada um com a frase que
 * diz o que ele faz com os dados de quem escreve. O nome sozinho
 * ("Equilibrado") não conta nada a quem não programa: o que decide a escolha é
 * a frase.
 */
export const PERFIS_PRIVACIDADE: ReadonlyArray<readonly [PrivacyProfile, string, string]> = [
  ['privado-local', t.privacy.privadoLocal, t.privacy.privadoLocalDetail],
  ['equilibrado', t.privacy.equilibrado, t.privacy.equilibradoDetail],
  ['melhor-qualidade', t.privacy.melhorQualidade, t.privacy.melhorQualidadeDetail],
]

/** As aparências, com o nome e a frase de cada uma. */
export const APARENCIAS: ReadonlyArray<readonly [DesignPreset, string, string]> = [
  ['modern', t.design.modern, t.design.modernDetail],
  ['professional', t.design.professional, t.design.professionalDetail],
  ['colorful', t.design.colorful, t.design.colorfulDetail],
  ['brand', t.design.brand, t.design.brandDetail],
]

/** De onde veio o tipo mostrado na tela. `person` é a escolha à mão, que o palpite não faz. */
export type CategoryBasis = import('../categorySuggestion').CategoryGuess['basis'] | 'person'
