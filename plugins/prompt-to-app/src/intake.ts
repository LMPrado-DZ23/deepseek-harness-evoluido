import { z } from 'zod'
import { appSpecV1Schema, detectSensitiveData, parseAppSpecWithSingleRepair, sensitiveDataQuestion, type AppSpecV1 } from './appspec.js'
import type { StudioProject } from './model.js'
import type { ModelResult, PromptModelPort } from './ports.js'

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
  if (conversation.answers.audience === undefined) return { id: 'audience', text: 'Para quem você quer criar este projeto?' }
  if (conversation.answers.goal === undefined) return { id: 'goal', text: 'O que a pessoa deve conseguir fazer ou entender?' }
  if (conversation.answers.content === undefined) return { id: 'content', text: 'Quais informações ou itens precisam aparecer?' }
  return undefined
}

export class IntakeEngine {
  constructor(private readonly model: PromptModelPort) {}

  async recommend(conversation: IntakeConversation, question: IntakeQuestion): Promise<ModelResult> {
    return this.model.complete(
      { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
      'intake', conversation.project.privacy,
      `Recomende uma resposta curta, em português comum, para a pergunta "${question.text}". Ideia: ${conversation.project.original_brief}`,
    )
  }

  async buildSpec(conversation: IntakeConversation): Promise<{ spec: AppSpecV1; model: ModelResult }> {
    const sensitive = detectSensitiveData([conversation.project.original_brief, ...Object.values(conversation.answers)].join('\n'))
    const prompt = [
      'Produza somente JSON válido para AppSpec v1.',
      `Categoria: ${conversation.project.category}.`,
      `Ideia: ${conversation.project.original_brief}`,
      `Respostas: ${JSON.stringify(conversation.answers)}`,
      `Dados sensíveis: ${JSON.stringify(sensitive)}; confirmação: ${String(conversation.sensitiveConfirmed === true)}.`,
      `Schema: ${JSON.stringify(appSpecV1Schema.toJSONSchema())}`,
    ].join('\n')
    const result = await this.model.complete(
      { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
      'intake', conversation.project.privacy, prompt,
    )
    const spec = await parseAppSpecWithSingleRepair(result.value, async (invalid, issues) => {
      const repair = await this.model.complete(
        { orgId: conversation.project.org_id, tenantId: conversation.project.tenant_id },
        'intake', conversation.project.privacy,
        `Corrija uma única vez este AppSpec. Erros: ${issues.join('; ')}. Valor: ${JSON.stringify(invalid)}`,
      )
      return repair.value
    })
    return { spec, model: result }
  }
}
