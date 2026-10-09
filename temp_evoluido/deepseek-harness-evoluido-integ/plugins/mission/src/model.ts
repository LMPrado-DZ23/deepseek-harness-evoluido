import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
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
 *
 * `ABANDONED` ESTEVE AQUI e saiu. Nenhum método o produzia, e duas
 * conferências o tratavam como terminal: era um estado que a tela precisava
 * saber desenhar e que nada podia alcançar. Um contrato com estado morto faz
 * quem lê acreditar que existe um caminho que não existe — e, quando alguém
 * finalmente escrever a transição, ela chega sem as conferências revisadas.
 */
export const MISSION_STATUSES = ['RUNNING', 'CANDIDATE_COMPLETED', 'COMPLETED'] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

const identifier = z.string().min(1).max(120)

/**
 * Quantas execuções cabem numa missão.
 *
 * O número não foi medido contra nada; é um teto para o registro não crescer
 * sem limite, e está escrito assim em vez de fingir que veio de uma medição.
 * Quem chega nele recebe uma frase de catálogo, e não o texto do esquema.
 */
export const MAX_RUNS_PER_MISSION = 10_000

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
  // E o PAR SIMÉTRICO da evidência, que faltava. Sem ele um critério
  // `UNPROVEN` podia carregar prova de um estado anterior, e a tela desenhava
  // "ainda sem prova" com "Onde está a prova: …" logo abaixo — o mesmo verde
  // artificial que este esquema existe para recusar, entrando pela outra
  // metade do par.
  if (value.state !== 'PROVEN' && value.evidence !== null) {
    context.addIssue({ code: 'custom', message: t('errors.evidenciaSemProva'), path: ['evidence'] })
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
   * O teto em DINHEIRO, em centavos inteiros da moeda da tabela de preço.
   *
   * `null` é o mesmo que no teto de tokens: sem teto DECLARADO, e não teto
   * infinito conferido. E declarar um teto de dinheiro não garante que ele
   * possa ser conferido — sem tabela de preço, `gastoEmDinheiro` devolve
   * `SEM_TABELA`, que é diferente de "cabe".
   *
   * Centavos INTEIROS, e nunca reais com vírgula: ponto flutuante soma errado,
   * e um teto que erra centavos ao longo de mil execuções erra o teto.
   */
  max_total_centavos: z.number().int().positive().nullable().default(null),
  /**
   * As execuções que pertencem a esta missão.
   *
   * É o que dá escopo AMPLO: uma missão atravessa execuções de projetos e
   * equipes diferentes, e é sobre este conjunto que o teto e a prova valem.
   */
  run_ids: z.array(identifier).max(MAX_RUNS_PER_MISSION),
  criteria: z.array(missionCriterionSchema).min(1).max(200),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  /**
   * Quantas vezes este registro foi gravado.
   *
   * É o testemunho de versão da gravação condicional. `updated_at` não serve:
   * duas gravações no mesmo milissegundo produzem o mesmo carimbo, e uma
   * condição que passa por empate de relógio não é condição.
   *
   * Começa em 0 e sobe de um a cada gravação. Quem grava declara a revisão que
   * LEU; se o registro andou nesse meio-tempo, a escrita não acontece.
   */
  revision: z.number().int().nonnegative(),
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
  // A candidatura tem o MESMO par, que faltava. Pelo serviço não era
  // alcançável, mas o esquema é a fronteira que a gravação usa contra
  // registros recompostos por outro caminho — e a assimetria contradizia a
  // regra que este arquivo documenta duas linhas acima.
  if (value.status === 'RUNNING' && value.candidate_at !== null) {
    context.addIssue({ code: 'custom', message: t('errors.candidaturaSemEstado'), path: ['candidate_at'] })
  }
  if (value.status !== 'RUNNING' && value.candidate_at === null) {
    context.addIssue({ code: 'custom', message: t('errors.estadoSemCandidatura'), path: ['candidate_at'] })
  }
})

export type MissionRecord = z.infer<typeof missionRecordSchema>

/**
 * O consumo de uma execução, no recorte mínimo de que a missão precisa.
 *
 * Os campos de DINHEIRO são opcionais, e a ausência deles não é zero: sem
 * provedor e modelo não dá para achar o preço, e sem a separação entre entrada
 * e saída não dá para aplicar os dois preços — que são diferentes, e em geral
 * por um fator de cinco. `custoDaExecucao` responde `SEM_PRECO` ou
 * `SEM_CONSUMO` nesses casos, e nunca soma zero.
 *
 * `tokens_used` continua sendo o total, e continua sendo o que o teto de TOKENS
 * usa: ele já existia, já é falsificado, e trocá-lo pela soma das duas metades
 * criaria uma segunda verdade sobre o mesmo número.
 */
export interface MissionRunUsage {
  readonly run_id: string
  readonly status: string
  readonly tokens_used?: number | null | undefined
  readonly provider?: string | null | undefined
  readonly model?: string | null | undefined
  readonly tokens_input?: number | null | undefined
  readonly tokens_output?: number | null | undefined
}

declare const missionKeyBrand: unique symbol
export type MissionKey = string & { readonly [missionKeyBrand]: true }

/**
 * A chave de armazenamento de uma missão.
 *
 * COMPOSTA, e não o `mission_id` sozinho. A tabela do seam de armazenamento é
 * um mapa PLANO: `put(chave, valor)` grava sem partição por escopo. E o
 * `mission_id` é escolhido por quem cria — nada impede duas organizações de
 * escolherem `entrega-q4`.
 *
 * Com a chave simples, a criação da segunda organização SOBRESCREVIA o registro
 * da primeira: objetivo, critérios, evidências e execuções ligadas, tudo
 * destruído em silêncio, com 201 devolvido a quem apagou. A primeira passava a
 * receber 404, e toda equipe dela apontando para aquela missão recebia
 * `MISSION_MISSING` e tinha as tarefas marcadas como estouro de teto. Era
 * destruição entre inquilinos, disparável por qualquer pessoa autenticada de
 * qualquer outra organização, bastando repetir um nome plausível.
 *
 * O separador é um byte nulo, que não aparece em identificador: sem ele,
 * dois pares diferentes de organização e inquilino poderiam produzir a mesma
 * chave por concatenação, e a separação voltaria a ser ilusão de string.
 * @param orgId - a organização.
 * @param tenantId - o inquilino.
 * @param missionId - o identificador escolhido por quem criou.
 * @returns a chave.
 */
export function missionKey(orgId: string, tenantId: string, missionId: string): MissionKey {
  return [orgId, tenantId, missionId].join(SEPARATOR) as MissionKey
}

/** Byte nulo: não aparece em identificador, então não dá para forjar colisão. */
const SEPARATOR = String.fromCharCode(0)

export const STUDIO_MISSIONS_PHYSICAL_DOMAIN = 'studio_missions'
export const STUDIO_MISSIONS_LOGICAL_DOMAIN = 'studio.missions'

export const studioMissionsDomainSpec = defineDomain({
  name: STUDIO_MISSIONS_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    missions: domainTable<MissionKey, MissionRecord>(missionRecordSchema),
  },
})
