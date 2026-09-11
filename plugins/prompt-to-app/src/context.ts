import { t } from './i18n.js'

/**
 * O que uma parte do contexto É, e o que isso autoriza.
 *
 * `instruction` e `schema` são o que faz o modelo responder no formato que
 * conseguimos ler. `evidence` é o material sobre o qual ele raciocina.
 *
 * A distinção não é organizacional: ela decide o que pode ser CORTADO. Cortar
 * evidência produz uma resposta pior; cortar schema produz uma resposta que
 * não é sequer analisável — e aí a pessoa vê um erro de formato sobre um
 * problema que era de TAMANHO.
 */
export type ContextKind = 'instruction' | 'schema' | 'evidence'

/** Uma parte do contexto, com de onde veio e quanto pesa. */
export interface ContextSection {
  /** Identificador estável. Duas partes com o mesmo id são a mesma parte. */
  readonly id: string
  readonly kind: ContextKind
  /** Maior ganha quando falta espaço. Só vale entre partes `evidence`. */
  readonly priority: number
  readonly text: string
  /**
   * De onde este texto veio.
   *
   * Sem procedência, ninguém reconstrói por que o modelo respondeu o que
   * respondeu — e a primeira pergunta depois de uma resposta ruim é sempre
   * "o que exatamente ele viu?".
   */
  readonly source: string
}

/** O que entrou, o que ficou de fora, e por quê. */
export interface ContextLedger {
  readonly included: readonly { readonly id: string; readonly kind: ContextKind; readonly source: string; readonly chars: number }[]
  readonly dropped: readonly { readonly id: string; readonly source: string; readonly chars: number; readonly reason: 'BUDGET' | 'DUPLICATE' }[]
  readonly chars: number
  readonly budget: number
}

export interface AssembledContext {
  readonly prompt: string
  readonly ledger: ContextLedger
}

/**
 * O contexto obrigatório sozinho já não cabe.
 *
 * Erro próprio, e não um corte silencioso, porque as duas saídas são muito
 * diferentes para quem está do outro lado: cortar o schema produziria uma
 * resposta que o `parse` recusa, e a pessoa leria "formato inválido" sobre um
 * problema que é de tamanho. Falhar aqui é o que deixa dizer a verdade.
 */
export class ContextBudgetExceededError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED'
  constructor(readonly requiredChars: number, readonly budget: number) {
    super(t('errors.contextBudget'))
  }
}

/** O teto padrão, em caracteres. */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 24_000

/** O separador entre partes. */
const SEPARATOR = '\n'

/**
 * O custo de uma lista de partes, contando os separadores entre elas.
 * @param list - as partes.
 * @returns o total em caracteres.
 */
function cost(list: readonly ContextSection[]): number {
  return list.reduce((total, section) => total + section.text.length, 0) + Math.max(list.length - 1, 0) * SEPARATOR.length
}

/**
 * Monta o prompt a partir das partes, respeitando o teto.
 *
 * As regras, e cada uma existe por um motivo:
 *
 * 1. **Instrução e schema nunca são cortados.** Se eles sozinhos estouram o
 *    teto, isto FALHA — ver `ContextBudgetExceededError`.
 * 2. **Parte duplicada entra uma vez só.** O mesmo texto repetido não
 *    acrescenta informação e ainda empurra outra coisa para fora.
 * 3. **O corte é por prioridade e é determinístico.** Mesma entrada, mesma
 *    saída: um prompt que muda sozinho entre execuções torna impossível
 *    reproduzir o que o modelo viu. Empate se resolve pela ORDEM DE ENTRADA,
 *    nunca por ordenação instável.
 * 4. **A ordem final é a de entrada, não a de prioridade.** Prioridade decide
 *    quem fica, não onde aparece; reordenar o prompt mudaria a resposta por um
 *    motivo que ninguém pediu.
 * 5. **O que foi cortado fica registrado.** Um contexto que encolhe em
 *    silêncio é a forma mais direta de o resultado piorar sem ninguém
 *    entender por quê.
 *
 * @param sections - as partes, na ordem em que devem aparecer.
 * @param options - o teto em caracteres.
 * @returns o prompt e o registro do que entrou e do que saiu.
 */
export function assembleContext(
  sections: readonly ContextSection[],
  options: { readonly budgetChars?: number | undefined } = {},
): AssembledContext {
  const budget = options.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS

  const seen = new Set<string>()
  const unique: ContextSection[] = []
  const dropped: { id: string; source: string; chars: number; reason: 'BUDGET' | 'DUPLICATE' }[] = []
  for (const section of sections) {
    // JSON e nao concatenacao com separador: qualquer separador escolhido pode
    // aparecer DENTRO do proprio texto, e ai duas partes diferentes colidiriam
    // e uma sumiria em silencio - o oposto do que esta funcao existe para
    // fazer. E um byte nulo literal no fonte e invisivel em revisao.
    const fingerprint = JSON.stringify([section.kind, section.text])
    if (seen.has(fingerprint)) {
      dropped.push({ id: section.id, source: section.source, chars: section.text.length, reason: 'DUPLICATE' })
      continue
    }
    seen.add(fingerprint)
    unique.push(section)
  }

  const required = unique.filter(section => section.kind !== 'evidence')
  const optional = unique.filter(section => section.kind === 'evidence')

  const requiredChars = cost(required)
  if (requiredChars > budget) throw new ContextBudgetExceededError(requiredChars, budget)

  const order = new Map(optional.map((section, index) => [section.id, index]))
  const byPriority = [...optional].sort((left, right) =>
    right.priority - left.priority || order.get(left.id)! - order.get(right.id)!)

  const keep = new Set<string>()
  let used = requiredChars
  for (const section of byPriority) {
    const extra = section.text.length + (used === 0 ? 0 : SEPARATOR.length)
    if (used + extra > budget) {
      dropped.push({ id: section.id, source: section.source, chars: section.text.length, reason: 'BUDGET' })
      continue
    }
    keep.add(section.id)
    used += extra
  }

  const included = unique.filter(section => section.kind !== 'evidence' || keep.has(section.id))
  return {
    prompt: included.map(section => section.text).join(SEPARATOR),
    ledger: {
      included: included.map(section => ({ id: section.id, kind: section.kind, source: section.source, chars: section.text.length })),
      dropped,
      chars: cost(included),
      budget,
    },
  }
}
