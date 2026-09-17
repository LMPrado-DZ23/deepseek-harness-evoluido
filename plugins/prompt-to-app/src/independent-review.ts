import { t } from './i18n.js'

/**
 * REVISAO INDEPENDENTE — a metade que faltava do T-12.
 *
 * O `adversarial` do T-12 ja existe e e forte: `assertGeneratedSource` recusa
 * modulo, global, API de rede, tag, atributo e endereco fora da lista; e
 * `scanGeneratedContent` procura segredo e dado pessoal. A `convergencia`
 * fechou na OS-65. O que NAO existia era a parte INDEPENDENTE.
 *
 * O problema concreto: o pipeline declara `VERIFIED_PROTOTYPE` a partir de tres
 * booleanos que ele mesmo acabou de calcular (`buildPassed`, `testPassed`,
 * `lifecyclePassed`). Ninguem RE-DERIVA esse veredito do que ficou gravado. Um
 * defeito na propria contabilidade do pipeline — um criterio que sumiu do
 * relatorio, uma atestacao que nao foi escrita, um artefato sem impressao — sai
 * como aprovacao, porque quem afirma e quem executa.
 *
 * E a regra da missao: NUNCA CONFIE NA AUTOAVALIACAO DO EXECUTOR COMO PROVA
 * FINAL. Esta revisao le o REGISTRO e responde outra pergunta: as provas
 * presentes sustentam a afirmacao feita?
 *
 * TRES VEREDITOS, e o terceiro e o que da honestidade ao primeiro:
 * - `CONFIRMED` — as provas sustentam o que foi afirmado.
 * - `CONTRADICTED` — o registro diz o contrario do que foi afirmado.
 * - `INCONCLUSIVE` — falta prova para dizer qualquer das duas.
 *
 * `INCONCLUSIVE` NUNCA e tratado como confirmacao. Uma revisao que so soubesse
 * aprovar e reprovar teria de escolher um dos dois diante de uma prova ausente,
 * e escolheria aprovar — que e exatamente o defeito que ela existe para pegar.
 */

/** O que a revisao le. Nada aqui e calculado pelo pipeline no momento da revisao. */
export interface ReviewedRun {
  readonly state: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED_EXTERNAL' | 'BUDGET_EXCEEDED' | 'CANCELLED'
  readonly stage: 'generate' | 'build' | 'test' | 'verify'
  readonly acceptance_checks: readonly { readonly id: string; readonly label: string; readonly status: 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED' }[]
  readonly artifact_sha256?: string | null | undefined
  readonly template_integrity?: 'VERIFIED' | 'FAILED' | undefined
  readonly attestations?: Readonly<Record<string, string>> | undefined
  readonly steps?: readonly { readonly step: 'install' | 'build' | 'test' | 'e2e'; readonly state: 'RUNNING' | 'PASSED' | 'FAILED' }[] | undefined
  readonly failure_code?: string | null | undefined
}

export type ReviewVerdict =
  | 'CONFIRMED'
  | 'CONTRADICTED'
  | 'INCONCLUSIVE'
  /**
   * A execucao nao AFIRMOU aprovacao, entao nao ha o que contestar.
   *
   * Valor proprio porque `CONFIRMED` quer dizer "as provas sustentam o que foi
   * afirmado", e aqui o significado e "nao olhei". A revisao adversarial pegou
   * isso: `blocksVerification(reviewRun(execucaoReprovada))` devolvia `false`,
   * que lido literalmente e "esta execucao falhada nao bloqueia a verificacao".
   * Sobrevivia so porque o pipeline nunca chamava nesse estado — e um segundo
   * chamador leria "confirmado" sobre um `FAILED`.
   */
  | 'NOT_REVIEWED'

export interface ReviewProblem {
  /** Por que a prova nao sustenta a afirmacao. */
  readonly code:
    | 'CHECK_STILL_PENDING'
    | 'CHECK_FAILED'
    | 'NO_CHECKS'
    | 'ARTIFACT_MISSING'
    | 'INTEGRITY_NOT_RECORDED'
    | 'INTEGRITY_FAILED'
    | 'ATTESTATION_MISSING'
    | 'STEP_NOT_PASSED'
    | 'FAILURE_CODE_ON_PASS'
    /**
     * O perfil exige esta etapa e ela NAO ESTA no registro.
     *
     * Este codigo existe por causa de um achado de revisao independente: o laco
     * percorria `run.steps ?? []`, entao um registro com `steps: []` — ou com
     * `build` sozinho — nao produzia problema nenhum e saia CONFIRMED. A
     * revisao conferia as etapas PRESENTES e nunca perguntava quais deviam
     * estar la. Ausencia de etapa virava aprovacao, que e a forma mais cara de
     * "ausencia de prova vira prova".
     */
    | 'STEP_MISSING'
    /** Nem a LISTA de etapas foi gravada: nao ha o que conferir contra o perfil. */
    | 'STEPS_NOT_RECORDED'
    /**
     * A atestacao existe, mas nao TEM A FORMA de uma prova.
     *
     * Conferir presenca de string aprova `acceptance_sha256: "sim"`. O resumo
     * ou e um sha256 de 64 digitos, ou nao e resumo de coisa nenhuma.
     */
    | 'ATTESTATION_MALFORMED'
  /** O que exatamente esta faltando ou contradizendo, para quem for conferir. */
  readonly subject: string
}

export interface ReviewResult {
  readonly verdict: ReviewVerdict
  readonly problems: readonly ReviewProblem[]
  /**
   * As etapas que o PERFIL exigia desta execucao.
   *
   * Sai no resultado para que o veredito possa ser lido sem abrir o codigo: um
   * `CONFIRMED` que nao diga contra qual contrato foi conferido e uma opiniao,
   * nao uma revisao.
   */
  readonly contract?: readonly string[]
  /** Quantos criterios ninguem automatizou. DITO, e nunca somado aos aprovados. */
  readonly notAutomated: number
  readonly passed: number
}

/**
 * As etapas que uma execucao completa do construtor TEM de registrar.
 *
 * O contrato e passado pelo chamador porque um perfil pode exigir menos — uma
 * execucao sem e2e, por exemplo, num perfil que nao tenha navegador. O que NAO
 * pode e a revisao descobrir o contrato a partir do que foi gravado: seria
 * perguntar ao revisado quais provas ele devia ter trazido.
 */
export const DEFAULT_STEP_CONTRACT = ['install', 'build', 'test', 'e2e'] as const

/** A forma de um resumo sha256, conferida e nao presumida. */
const SHA256 = /^[a-f0-9]{64}$/u
/** A forma do digest da imagem do construtor. */
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u

/**
 * A atestacao tem a FORMA de uma prova?
 * @param name - o nome da atestacao.
 * @param value - o valor gravado.
 * @returns `true` quando o valor tem a forma que aquele nome exige.
 */
export function attestationWellFormed(name: string, value: string): boolean {
  return name === 'builder_image_digest' ? IMAGE_DIGEST.test(value) : SHA256.test(value)
}

/** As quatro atestacoes mais a imagem e a politica: a lista e fixa de proposito. */
export const REQUIRED_ATTESTATIONS = [
  'acceptance_sha256', 'manifest_sha256', 'sbom_sha256', 'provenance_sha256',
  'builder_image_digest', 'policy_sha256',
] as const

/**
 * Re-deriva o veredito de uma execucao a partir do que ficou gravado.
 *
 * SO EXECUCOES QUE AFIRMARAM APROVACAO sao revisadas. Uma execucao que ja diz
 * `FAILED` nao esta afirmando nada que precise ser contestado — revisa-la
 * gastaria atencao onde nao ha discordancia possivel, e ainda produziria uma
 * lista de problemas que a pessoa leria como um SEGUNDO defeito.
 */
export function reviewRun(run: ReviewedRun, contract: readonly string[] = DEFAULT_STEP_CONTRACT): ReviewResult {
  const problems: ReviewProblem[] = []
  const notAutomated = run.acceptance_checks.filter(check => check.status === 'NOT_AUTOMATED').length
  const passed = run.acceptance_checks.filter(check => check.status === 'PASSED').length

  if (run.state !== 'PASSED') return { verdict: 'NOT_REVIEWED', problems: [], notAutomated, passed, contract }

  // CONTRADICOES: o registro diz o contrario do que a execucao afirmou.
  for (const check of run.acceptance_checks) {
    if (check.status === 'FAILED') problems.push({ code: 'CHECK_FAILED', subject: check.label })
  }
  if (run.template_integrity === 'FAILED') problems.push({ code: 'INTEGRITY_FAILED', subject: 'template' })
  for (const step of run.steps ?? []) {
    if (step.state === 'FAILED') problems.push({ code: 'STEP_NOT_PASSED', subject: step.step })
  }
  // Uma execucao aprovada que carrega motivo de falha esta se contradizendo em
  // dois campos do MESMO registro, e um dos dois esta errado.
  if (run.failure_code != null && run.failure_code.length > 0) {
    problems.push({ code: 'FAILURE_CODE_ON_PASS', subject: run.failure_code })
  }
  const contradicted = problems.length > 0

  // PROVAS AUSENTES: nao contradizem, mas tambem nao sustentam.
  const missing: ReviewProblem[] = []
  if (run.acceptance_checks.length === 0) missing.push({ code: 'NO_CHECKS', subject: 'acceptance' })
  for (const check of run.acceptance_checks) {
    // `PENDING` numa execucao aprovada quer dizer que o criterio nunca foi
    // conferido — e nao que ele passou silenciosamente.
    if (check.status === 'PENDING') missing.push({ code: 'CHECK_STILL_PENDING', subject: check.label })
  }
  if (run.artifact_sha256 == null || run.artifact_sha256.length === 0) {
    missing.push({ code: 'ARTIFACT_MISSING', subject: 'artifact' })
  }
  // AUSENTE nao e `VERIFIED`. O proprio esquema diz que ausente quer dizer
  // "nao registrado", nunca "conferido" — e a revisao existe para nao
  // converter um em outro.
  if (run.template_integrity === undefined) missing.push({ code: 'INTEGRITY_NOT_RECORDED', subject: 'template' })
  for (const name of REQUIRED_ATTESTATIONS) {
    const value = run.attestations?.[name]
    if (value === undefined || value.length === 0) { missing.push({ code: 'ATTESTATION_MISSING', subject: name }); continue }
    if (!attestationWellFormed(name, value)) missing.push({ code: 'ATTESTATION_MALFORMED', subject: name })
  }
  if (run.artifact_sha256 != null && run.artifact_sha256.length > 0 && !SHA256.test(run.artifact_sha256)) {
    missing.push({ code: 'ATTESTATION_MALFORMED', subject: 'artifact_sha256' })
  }
  // AS ETAPAS QUE O PERFIL EXIGE, e nao as que o registro trouxe.
  if (run.steps === undefined) missing.push({ code: 'STEPS_NOT_RECORDED', subject: 'steps' })
  else {
    for (const exigida of contract) {
      const registrada = run.steps.find(step => step.step === exigida)
      if (registrada === undefined) missing.push({ code: 'STEP_MISSING', subject: exigida })
      else if (registrada.state === 'RUNNING') missing.push({ code: 'STEP_NOT_PASSED', subject: exigida })
    }
  }

  if (contradicted) return { verdict: 'CONTRADICTED', problems: [...problems, ...missing], notAutomated, passed, contract }
  if (missing.length > 0) return { verdict: 'INCONCLUSIVE', problems: missing, notAutomated, passed, contract }
  return { verdict: 'CONFIRMED', problems: [], notAutomated, passed, contract }
}

/**
 * A frase que a pessoa le.
 *
 * `CONFIRMED` com criterios NAO AUTOMATIZADOS nao vira silencio: ela precisa
 * saber que parte do que ela pediu ninguem conseguiu conferir por maquina, e
 * saber ANTES de tratar o resultado como pronto.
 */
export function reviewMessage(result: ReviewResult): string | undefined {
  if (result.verdict === 'NOT_REVIEWED') return undefined
  if (result.verdict === 'CONTRADICTED') {
    return t('review.contradicted', { count: String(result.problems.length) })
  }
  if (result.verdict === 'INCONCLUSIVE') {
    return t('review.inconclusive', { count: String(result.problems.length) })
  }
  if (result.notAutomated > 0) return t('review.notAutomated', { count: String(result.notAutomated) })
  return undefined
}

/**
 * A revisao BLOQUEIA a afirmacao de protótipo verificado?
 *
 * Contradicao bloqueia. Prova ausente TAMBEM bloqueia, e e a decisao que da
 * sentido a tudo isto: deixar passar o que nao se consegue sustentar e
 * exatamente transformar ausencia de prova em prova. Criterio nao automatizado
 * NAO bloqueia — ele e uma limitacao conhecida e DITA, e transforma-lo em
 * bloqueio reprovaria toda criacao cujo criterio a pessoa escreveu em prosa.
 */
export function blocksVerification(result: ReviewResult): boolean {
  // `NOT_REVIEWED` nao bloqueia: uma execucao que nao afirmou aprovacao nao tem
  // aprovacao a ser bloqueada, e devolver `true` aqui faria a revisao "reprovar"
  // o que ja estava reprovado.
  return result.verdict === 'CONTRADICTED' || result.verdict === 'INCONCLUSIVE'
}
