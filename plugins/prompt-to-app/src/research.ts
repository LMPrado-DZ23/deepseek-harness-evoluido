import { createHash } from 'node:crypto'
import { t } from './i18n.js'
import type { ContextSection } from './context.js'

/**
 * O que o Studio SOUBE de fora, e de onde.
 *
 * Uma pesquisa que entra na geração sem procedência é indistinguível de uma
 * invenção — e o modo de falhar não é o modelo mentir de propósito: é ele
 * PARAFRASEAR uma fonte real até a frase deixar de estar lá, e ninguém
 * conseguir voltar e conferir.
 *
 * Por isso a unidade aqui não é "um fato": é um fato MAIS o trecho literal que
 * o sustenta, MAIS de onde o trecho veio. Uma nota sem os três não entra.
 *
 * A conferência central deste arquivo é uma só, e ela é literal: **o trecho
 * tem de aparecer no conteúdo da fonte.** Não parecido, não equivalente —
 * aparecer. É a única verificação que uma máquina consegue fazer sobre uma
 * citação, e é exatamente a que separa citar de lembrar.
 */

/** Uma nota de pesquisa, com o que a sustenta. */
export interface ResearchNote {
  readonly note_id: string
  /** O que se afirma, em português, para quem vai ler. */
  readonly claim: string
  /** O trecho LITERAL da fonte que sustenta a afirmação. */
  readonly excerpt: string
  readonly source_url: string
  /** Quando o conteúdo foi lido. */
  readonly retrieved_at: string
  /** A impressão do conteúdo lido, que liga a nota a bytes. */
  readonly content_sha256: string
}

export type ResearchRefusal =
  | 'NO_CLAIM'
  | 'NO_EXCERPT'
  | 'NO_SOURCE'
  | 'EXCERPT_NOT_FOUND'
  | 'CONTENT_CHANGED'
  | 'EXPIRED'

/**
 * Quantos dias uma nota vale sem ser lida de novo.
 *
 * A escolha é sobre o MUNDO: preço, horário, endereço e disponibilidade mudam,
 * e uma nota de meio ano atrás afirmada como presente é pior que nenhuma nota,
 * porque ela tem procedência e por isso convence.
 */
export const RESEARCH_MAX_AGE_DAYS = 90

/**
 * A impressão de um conteúdo, do mesmo jeito em que ela é gravada.
 * @param content - o conteúdo lido.
 * @returns o hash.
 */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Normaliza um texto para a comparação do trecho.
 *
 * Só espaço: quebra de linha e indentação mudam entre uma leitura e outra do
 * MESMO conteúdo — uma página reformatada, um `\r\n` virando `\n` — sem que
 * uma palavra mude. O que a normalização NÃO faz é mexer em pontuação, acento
 * ou caixa: "não" e "nao" são palavras diferentes, e um trecho que só casa
 * depois de tirar o acento não é o trecho que está lá.
 * @param text - o texto.
 * @returns a forma comparável.
 */
export function normalizeForQuote(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Se a nota se sustenta contra o conteúdo que ela cita.
 *
 * A ordem das recusas é o contrato: falta de campo vem antes de conferência de
 * conteúdo, porque uma nota sem trecho não pode ser comparada com coisa alguma
 * e dizer `EXCERPT_NOT_FOUND` para ela culparia a fonte por um defeito da nota.
 * @param note - a nota.
 * @param content - o conteúdo da fonte, como foi lido agora.
 * @param options - o relógio e a validade.
 * @returns a recusa, ou `undefined` quando ela se sustenta.
 */
export function refusalFor(
  note: ResearchNote,
  content: string | undefined,
  options: { readonly now: Date; readonly maxAgeDays?: number | undefined },
): ResearchRefusal | undefined {
  if (normalizeForQuote(note.claim) === '') return 'NO_CLAIM'
  if (normalizeForQuote(note.excerpt) === '') return 'NO_EXCERPT'
  // `http(s)` só. Um `file:` apontaria para o disco de quem hospeda, e um
  // esquema inventado não é endereço que alguém consiga abrir para conferir.
  if (!/^https?:\/\/\S+$/u.test(note.source_url.trim())) return 'NO_SOURCE'

  const age = options.now.getTime() - Date.parse(note.retrieved_at)
  const maxAge = (options.maxAgeDays ?? RESEARCH_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
  // Data ilegível conta como VENCIDA, e não como recente: uma nota cuja data
  // ninguém consegue ler não pode ser afirmada como atual.
  if (!Number.isFinite(age) || age > maxAge) return 'EXPIRED'

  // Sem conteúdo para comparar, a nota NÃO passa. "Não consegui reler a fonte"
  // e "a fonte confirma" são coisas diferentes, e tratá-las igual é como uma
  // citação inventada atravessa.
  if (content === undefined) return 'CONTENT_CHANGED'
  if (contentDigest(content) !== note.content_sha256) return 'CONTENT_CHANGED'
  if (!normalizeForQuote(content).includes(normalizeForQuote(note.excerpt))) return 'EXCERPT_NOT_FOUND'
  return undefined
}

export interface ResearchOutcome {
  readonly accepted: readonly ResearchNote[]
  readonly refused: readonly { readonly note_id: string; readonly reason: ResearchRefusal }[]
}

/**
 * Separa as notas que se sustentam das que não.
 *
 * A recusa é POR NOTA: uma nota que não se sustenta não derruba as outras nem
 * o pedido de quem pediu. O que ela não faz é entrar.
 * @param notes - as notas.
 * @param contentOf - o conteúdo relido de cada fonte.
 * @param options - o relógio e a validade.
 * @returns as aceitas e as recusadas, com o motivo.
 */
export function screenNotes(
  notes: readonly ResearchNote[],
  contentOf: (url: string) => string | undefined,
  options: { readonly now: Date; readonly maxAgeDays?: number | undefined },
): ResearchOutcome {
  const accepted: ResearchNote[] = []
  const refused: { note_id: string; reason: ResearchRefusal }[] = []
  for (const note of notes) {
    const reason = refusalFor(note, contentOf(note.source_url), options)
    if (reason === undefined) accepted.push(note); else refused.push({ note_id: note.note_id, reason })
  }
  return { accepted, refused }
}

/**
 * As notas aceitas, como partes de contexto.
 *
 * `evidence` e não `instruction`: uma nota é material sobre o qual o modelo
 * raciocina, e ela PODE ser cortada pelo teto sem mudar nenhuma regra. A
 * prioridade é baixa de propósito — o que a pessoa pediu vem antes do que o
 * Studio descobriu.
 *
 * A `source` de cada parte leva o endereço E a data. Sem a data, quem for
 * conferir depois não sabe contra qual versão da página a frase foi escrita.
 * @param notes - as notas aceitas.
 * @returns as partes.
 */
export function researchSections(notes: readonly ResearchNote[]): readonly ContextSection[] {
  return notes.map(note => ({
    id: `research:${note.note_id}`,
    kind: 'evidence' as const,
    priority: 50,
    source: `${note.source_url} (${note.retrieved_at})`,
    text: t('prompts.researchNote', { claim: note.claim, excerpt: note.excerpt, url: note.source_url }),
  }))
}
