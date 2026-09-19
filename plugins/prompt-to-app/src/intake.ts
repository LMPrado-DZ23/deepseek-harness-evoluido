import { assembleContext, type ContextLedger } from './context.js'
import { z } from 'zod'
import { appSpecV1Schema, detectSensitiveData, parseAppSpecWithSingleRepair, sensitiveDataQuestion, type AppSpecV1 } from './appspec.js'
import type { StudioProject } from './model.js'
import type { ModelResult, PromptModelPort } from './ports.js'
import { prompt, t } from './i18n.js'
import type { PerguntaDaLeitura } from './leitura.js'

export const intakeAnswerSchema = z.object({ answer: z.string().max(2_000), recommend: z.boolean().default(false) }).strict()

export interface IntakeQuestion {
  readonly id: 'audience' | 'goal' | 'content' | 'sensitive-confirmation'
  readonly text: string
  readonly sensitiveKinds?: readonly string[]
}

export interface IntakeConversation {
  readonly project: StudioProject
  readonly answers: Readonly<Record<string, string>>
  readonly sensitiveConfirmed?: boolean
}

export function nextIntakeQuestion(conversation: IntakeConversation): IntakeQuestion | undefined {
  const sensitive = detectSensitiveData([conversation.project.original_brief, ...Object.values(conversation.answers)].join('\n'))
  if (sensitive.length > 0 && conversation.sensitiveConfirmed === undefined) {
    return { id: 'sensitive-confirmation', text: sensitiveDataQuestion(sensitive)!, sensitiveKinds: sensitive }
  }
  if (conversation.answers.audience === undefined) return { id: 'audience', text: t('questions.audience') }
  if (conversation.answers.goal === undefined) return { id: 'goal', text: t('questions.goal') }
  if (conversation.answers.content === undefined) return { id: 'content', text: t('questions.content') }
  return undefined
}

export class IntakeEngine {
  /** O registro do ULTIMO contexto montado. Ver `PlannerEngine.lastLedger`. */
  lastLedger: ContextLedger | undefined

  constructor(private readonly model: PromptModelPort, private readonly budgetChars?: number) {}

  async recommend(conversation: IntakeConversation, question: IntakeQuestion): Promise<ModelResult> {
    return this.model.complete(
      { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
      'intake', conversation.project.privacy,
      prompt('prompts.recommend', { question: question.text, brief: conversation.project.original_brief }),
    )
  }

  /**
   * LÊ o pedido e as respostas já dadas, procurando o que ainda falta.
   *
   * Só as perguntas de `faltando` entram no prompt: pedir ao modelo o que já
   * foi respondido seria pagar para ouvir de novo o que a pessoa disse.
   * @param conversation - o pedido e as respostas até aqui.
   * @param faltando - as perguntas ainda sem resposta.
   * @param ultimaResposta - o texto que a pessoa acabou de escrever, quando ainda não está gravado.
   * @returns o que o modelo devolveu, sem interpretar.
   */
  async ler(conversation: IntakeConversation, faltando: readonly PerguntaDaLeitura[], ultimaResposta?: string): Promise<ModelResult> {
    const perguntas = Object.fromEntries(faltando.map(id => [id, t(`questions.${id}`)]))
    const respostas = ultimaResposta === undefined ? conversation.answers : { ...conversation.answers, ultima: ultimaResposta }
    return this.model.complete(
      { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
      'leitura', conversation.project.privacy,
      prompt('prompts.leitura', {
        brief: conversation.project.original_brief,
        answers: JSON.stringify(respostas),
        questions: JSON.stringify(perguntas),
      }),
    )
  }

  async buildSpec(conversation: IntakeConversation): Promise<{ spec: AppSpecV1; model: ModelResult }> {
    const sensitive = detectSensitiveData([conversation.project.original_brief, ...Object.values(conversation.answers)].join('\n'))
    const assembled = assembleContext([
      { id: 'spec.only', kind: 'instruction', priority: 0, source: 'studio-instruction', text: prompt('prompts.specOnly') },
      { id: 'spec.category', kind: 'instruction', priority: 0, source: 'studio-instruction', text: prompt('prompts.category', { category: conversation.project.category }) },
      // A deteccao de dado sensivel e INSTRUCAO, e nao evidencia, embora
      // pareca material: ela diz ao modelo o que NAO pode tratar como campo
      // comum. Corta-la por falta de espaco produziria um aplicativo que pede
      // CPF num formulario sem nenhum cuidado - e a pessoa nao teria como
      // saber que a instrucao existiu e sumiu.
      { id: 'spec.sensitive', kind: 'instruction', priority: 0, source: 'studio-instruction', text: prompt('prompts.sensitive', { sensitive: JSON.stringify(sensitive), confirmed: String(conversation.sensitiveConfirmed === true) }) },
      // O pedido original e a coisa mais importante que a pessoa escreveu.
      { id: 'spec.idea', kind: 'evidence', priority: 100, source: 'original-brief', text: prompt('prompts.idea', { brief: conversation.project.original_brief }) },
      { id: 'spec.answers', kind: 'evidence', priority: 90, source: 'intake-answers', text: prompt('prompts.answers', { answers: JSON.stringify(conversation.answers) }) },
      { id: 'spec.schema', kind: 'schema', priority: 0, source: 'app-spec-schema', text: prompt('prompts.schema', { schema: JSON.stringify(appSpecV1Schema.toJSONSchema()) }) },
    ], { budgetChars: this.budgetChars })
    this.lastLedger = assembled.ledger
    const textoMontado = assembled.prompt
    const result = await this.model.complete(
      { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
      'intake', conversation.project.privacy, textoMontado,
    )
    const spec = await parseAppSpecWithSingleRepair(result.value, async (invalid, issues) => {
      const repair = await this.model.complete(
        { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
        'intake', conversation.project.privacy,
        /*
          O REPARO leva o schema junto, e não só os erros.

          Medido em 18/09/2026 contra o Ollama do titular: sem o schema, o
          modelo recebe "entities.0.fields.0: expected string, received object"
          e repete o mesmo erro — ele não tem como saber que o conserto era
          trocar o `kind` da entidade, porque a forma que ele precisa acertar
          ficou no prompt anterior. A rodada de reparo era uma cópia degradada
          do primeiro prompt: perdia o contrato de formato E a definição.
        */
        prompt('prompts.repair', {
          schema: JSON.stringify(appSpecV1Schema.toJSONSchema()),
          issues: issues.join('; '),
          value: JSON.stringify(invalid),
        }),
      )
      return repair.value
    })
    return { spec, model: result }
  }
}
