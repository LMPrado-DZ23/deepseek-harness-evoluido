import { z } from 'zod'
import { t } from './i18n.js'

/**
 * O estado de um critério de aceite.
 *
 * Quatro, e a distinção entre os dois últimos é a razão deste tipo existir:
 * `UNPROVEN` pede TRABALHO, `BLOCKED_EXTERNAL` pede OUTRA PESSOA. Juntá-los num
 * "pendente" faria uma missão parada por falta de credencial parecer uma missão
 * parada por falta de esforço, e quem olhasse o painel tentaria a coisa errada.
 *
 * `REFUTED` não é o mesmo que `UNPROVEN`: a prova foi executada e reprovou. Uma
 * missão com critério refutado não está no meio do caminho, está no caminho
 * errado.
 */
export const CRITERION_STATES = ['UNPROVEN', 'PROVEN', 'REFUTED', 'BLOCKED_EXTERNAL'] as const
export type CriterionState = (typeof CRITERION_STATES)[number]

/**
 * O estado de uma missão.
 *
 * `CANDIDATE_COMPLETED` existe porque o executor NÃO pode declarar `COMPLETED`.
 * Ele declara que acredita ter terminado; a passagem para `COMPLETED` é
 * conferida contra os critérios, e recusa quando algum não está provado. Sem
 * esse degrau, "terminei" é autoavaliação — que é exatamente a prova que não
 * vale.
 */
export const MISSION_STATUSES = ['RUNNING', 'CANDIDATE_COMPLETED', 'COMPLETED', 'ABANDONED'] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

const identifier = z.string().min(1).max(120)

export const missionCriterionSchema = z.object({
  criterion_id: identifier,
  /** O que precisa ser verdade, escrito para quem vai conferir. */
  statement: z.string().min(3).max(2_000),
  state: z.enum(CRITERION_STATES),
  /**
   * Onde está a prova.
   *
   * Obrigatória quando o critério está `PROVEN` — a validação abaixo recusa o
   * par (`PROVEN`, sem evidência), porque um critério que se declara provado
   * sem dizer onde está a prova é o verde artificial com outro nome.
   */
  evidence: z.string().min(1).max(2_000).nullable(),
  /** De quem ou de quê depende, quando `BLOCKED_EXTERNAL`. */
  blocked_reason: z.string().min(1).max(2_000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === 'PROVEN' && value.evidence === null) {
    context.addIssue({ code: 'custom', message: t('errors.provenSemEvidencia'), path: ['evidence'] })
  }
  if (value.state === 'BLOCKED_EXTERNAL' && value.blocked_reason === null) {
    context.addIssue({ code: 'custom', message: t('errors.bloqueioSemMotivo'), path: ['blocked_reason'] })
  }
  // O caminho contrário também: um motivo de bloqueio num critério que não está
  // bloqueado é registro que sobrou de um estado anterior, e ele mente sobre o
  // presente para quem ler a linha sem olhar o estado.
  if (value.state !== 'BLOCKED_EXTERNAL' && value.blocked_reason !== null) {
    context.addIssue({ code: 'custom', message: t('errors.motivoSemBloqueio'), path: ['blocked_reason'] })
  }
})

export type MissionCriterion = z.infer<typeof missionCriterionSchema>

export const missionRecordSchema = z.object({
  mission_id: identifier,
  org_id: identifier,
  tenant_id: identifier,
  /** O que se quer alcançar, em palavras de gente. */
  objective: z.string().min(3).max(4_000),
  status: z.enum(MISSION_STATUSES),
  /**
   * O teto da MISSÃO inteira, e não de uma equipe.
   *
   * `null` quer dizer sem teto declarado — e não teto infinito conferido: a
   * diferença aparece em `missionSpend`, que devolve `NO_LIMIT` em vez de
   * fingir que cabe.
   */
  max_total_tokens: z.number().int().positive().nullable(),
  /**
   * As execuções que pertencem a esta missão.
   *
   * É o que dá escopo AMPLO: uma missão atravessa execuções de projetos e
   * equipes diferentes, e é sobre este conjunto que o teto e a prova valem.
   */
  run_ids: z.array(identifier).max(10_000),
  criteria: z.array(missionCriterionSchema).min(1).max(200),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  /** Quando o executor declarou que acredita ter terminado. */
  candidate_at: z.string().min(1).nullable(),
  completed_at: z.string().min(1).nullable(),
}).strict().superRefine((value, context) => {
  const ids = value.criteria.map(item => item.criterion_id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: t('errors.criterioRepetido'), path: ['criteria'] })
  }
  const runs = value.run_ids
  if (new Set(runs).size !== runs.length) {
    // Execução repetida contaria o mesmo consumo duas vezes, e o teto estouraria
    // por erro de registro em vez de por gasto.
    context.addIssue({ code: 'custom', message: t('errors.execucaoRepetida'), path: ['run_ids'] })
  }
  if (value.status === 'COMPLETED' && value.completed_at === null) {
    context.addIssue({ code: 'custom', message: t('errors.concluidaSemData'), path: ['completed_at'] })
  }
  if (value.status !== 'COMPLETED' && value.completed_at !== null) {
    context.addIssue({ code: 'custom', message: t('errors.dataSemConclusao'), path: ['completed_at'] })
  }
})

export type MissionRecord = z.infer<typeof missionRecordSchema>

/** O consumo de uma execução, no recorte mínimo de que a missão precisa. */
export interface MissionRunUsage {
  readonly run_id: string
  readonly status: string
  readonly tokens_used?: number | null
}
