import { z } from 'zod'
import type { AppSpecV1 } from './appspec.js'
import { planSliceSchema } from './model.js'
import type { PromptModelPort } from './ports.js'
import { t } from './i18n.js'

const planOutputSchema = z.object({ slices: z.array(planSliceSchema).min(1).max(6) }).strict()
export type PlanOutput = z.infer<typeof planOutputSchema>

export class PlannerEngine {
  constructor(private readonly model: PromptModelPort) {}

  async plan(scope: { orgId: string; tenantId: string }, privacy: 'local-only' | 'any', spec: AppSpecV1, changeRequest?: string): Promise<PlanOutput> {
    const result = await this.model.complete(scope, 'plan', privacy, [
      t('prompts.planOnly'),
      t('prompts.planCriteria'),
      t('prompts.planFiles'),
      t('prompts.planFirst'),
      t('prompts.generateSpec', { spec: JSON.stringify(spec) }),
      ...(changeRequest === undefined ? [] : [t('prompts.changeRequest', { reason: changeRequest })]),
      t('prompts.schema', { schema: JSON.stringify(planOutputSchema.toJSONSchema()) }),
    ].join('\n'))
    const decoded = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    return planOutputSchema.parse(decoded)
  }
}
