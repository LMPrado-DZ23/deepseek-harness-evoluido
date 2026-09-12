import { t } from './i18n.js'
import type { ContextLedger } from './context.js'
import type { PlannerSkillReport } from './planner.js'

/**
 * O que o Studio CONSULTOU para montar este plano.
 *
 * Três motores guardam a resposta para "o que exatamente o modelo viu?" — o
 * registro de contexto, o relatório de habilidades e o inventário de código —
 * e até aqui nenhum deles chegava a lugar nenhum. Eram três respostas escritas
 * para uma pergunta que ninguém podia fazer.
 *
 * A regra que decide o que entra aqui: **o que a pessoa não tem como adivinhar
 * sozinha**. Ela sabe o que escreveu; ela não sabe que uma instrução de
 * terceiro entrou no pedido, que metade do código não foi lida, ou que a
 * descrição dela foi CORTADA por falta de espaço.
 *
 * Esse último é o item mais importante e o menos intuitivo: um plano montado
 * sobre um contexto truncado é um plano montado sobre menos do que a pessoa
 * disse — e sem esta lista ele se parece exatamente com um plano montado sobre
 * tudo.
 */

export interface ConsultedItem {
  /** A frase que a pessoa lê. */
  readonly label: string
  /** De onde aquilo veio, como o registro de contexto guardou. */
  readonly source: string
}

export interface ConsultedView {
  /** O que entrou no pedido, na ordem em que aparece. */
  readonly used: readonly ConsultedItem[]
  /** O que NÃO coube, com o motivo. Vazio quando coube tudo. */
  readonly dropped: readonly ConsultedItem[]
  /** As habilidades que foram recusadas, com o motivo em português. */
  readonly refusedSkills: readonly ConsultedItem[]
  /** Se o inventário de código estava incompleto. */
  readonly incompleteCode: boolean
}

/**
 * O rótulo de uma parte do contexto, para quem não escreve código.
 *
 * O identificador interno (`plan.spec`, `skill:formularios`) nunca aparece: ele
 * é nome de variável, e mostrá-lo troca uma explicação por um enigma.
 * @param id - o identificador da parte.
 * @param source - a procedência que o registro guardou.
 * @returns a frase.
 */
export function labelFor(id: string, source: string): string {
  if (id.startsWith('skill:')) return t('consulted.skill', { source })
  if (id.startsWith('research:')) return t('consulted.research', { source })
  if (id === 'plan.code') return t('consulted.code')
  if (id === 'plan.spec') return t('consulted.spec')
  if (id === 'plan.change') return t('consulted.change')
  if (id === 'plan.schema') return t('consulted.schema')
  if (id.startsWith('plan.')) return t('consulted.rule')
  return t('consulted.other', { source })
}

/** O motivo de uma habilidade não ter entrado, em português. */
export function skillRefusalLabel(reason: string): string {
  if (reason === 'DISABLED') return t('consulted.skillDisabled')
  if (reason === 'OVERSIZED') return t('consulted.skillTooBig')
  if (reason === 'BUDGET') return t('consulted.skillNoRoom')
  if (reason === 'SIZE_MISMATCH') return t('consulted.skillMismatch')
  if (reason === 'LOAD_FAILED') return t('consulted.skillUnreadable')
  // `NO_MATCH` e `DUPLICATE` NÃO chegam aqui: uma habilidade que não tem a ver
  // com o pedido não é uma recusa, é o funcionamento normal — e listá-la faria
  // toda tela ter uma lista de "problemas" que não são problema nenhum.
  return t('consulted.skillOther')
}

/** Os motivos que valem a pena contar à pessoa. */
const REPORTABLE = new Set(['DISABLED', 'OVERSIZED', 'BUDGET', 'SIZE_MISMATCH', 'LOAD_FAILED'])

/**
 * Monta o que a tela mostra.
 * @param ledger - o registro do contexto montado.
 * @param skills - o relatório das habilidades, quando houve.
 * @param codeLines - o inventário de código, quando houve.
 * @returns o que foi consultado.
 */
export function consultedView(
  ledger: ContextLedger | undefined,
  skills: PlannerSkillReport | undefined,
  codeLines: readonly string[] | undefined,
): ConsultedView {
  if (ledger === undefined) return { used: [], dropped: [], refusedSkills: [], incompleteCode: false }
  const used = ledger.included
    // A regra do prompt e o esquema da resposta são mecânica interna: mostrá-los
    // encheria a lista com linhas que não dizem nada a quem lê.
    .filter(item => item.kind !== 'schema')
    .map(item => ({ label: labelFor(item.id, item.source), source: item.source }))
  const dropped = ledger.dropped.map(item => ({ label: labelFor(item.id, item.source), source: item.source }))

  const refused: ConsultedItem[] = []
  for (const item of skills?.selection.skipped ?? []) {
    if (!REPORTABLE.has(item.reason)) continue
    refused.push({ label: skillRefusalLabel(item.reason), source: item.skill_id })
  }
  for (const item of skills?.refused ?? []) {
    refused.push({ label: skillRefusalLabel(item.reason), source: item.skill_id })
  }

  return {
    used,
    dropped,
    refusedSkills: refused,
    // A frase de incompletude é escrita pelo próprio inventário, e a busca é
    // por ela: reconstruir a condição aqui criaria uma segunda verdade que
    // diverge no primeiro conserto de um dos lados.
    incompleteCode: (codeLines ?? []).some(line => line.includes('INCOMPLETA')),
  }
}
