import { z } from 'zod'
import type { AppSpecV1 } from './appspec.js'
import { assertValidDataModel } from './data-generator.js'
import { planSliceSchema, type StudioProjectCategory } from './model.js'
import type { PromptModelPort } from './ports.js'
import { t } from './i18n.js'

const planOutputSchema = z.object({ slices: z.array(planSliceSchema).min(1).max(6) }).strict()
export type PlanOutput = z.infer<typeof planOutputSchema>

export class FormCategoryCapabilityError extends Error {
  constructor(readonly code: 'FORM_DATABASE_REQUIRED' | 'FORM_REFERENCE_REQUIRES_CRUD' | 'FORM_ENTRY_FILE_REQUIRED' | 'CATEGORY_NOT_IMPLEMENTED', message: string) {
    super(message)
  }
}

export function assertCategoryCanGenerate(category: StudioProjectCategory, spec: AppSpecV1): void {
  if (category !== 'form-database' && category !== 'crud-panel' && category !== 'scheduling' && category !== 'dashboard' && category !== 'saas-authenticated') return
  const entities = spec.entities.filter(entity => entity.kind === 'database')
  if (entities.length === 0) throw new FormCategoryCapabilityError('FORM_DATABASE_REQUIRED', t('errors.formDatabaseRequired'))
  assertValidDataModel(spec)
}

export class PlannerEngine {
  constructor(private readonly model: PromptModelPort) {}

  async plan(scope: { orgId: string; tenantId: string }, privacy: 'local-only' | 'any', spec: AppSpecV1, category: StudioProjectCategory = 'landing-page', changeRequest?: string): Promise<PlanOutput> {
    assertCategoryCanGenerate(category, spec)
    const result = await this.model.complete(scope, 'plan', privacy, [
      t('prompts.planOnly'),
      t('prompts.planCriteria'),
      t('prompts.planFiles'),
      t('prompts.planFirst'),
      ...(category === 'form-database' ? [t('prompts.planFormDatabase')] : []),
      ...(category === 'crud-panel' ? [t('prompts.planCrudPanel')] : []),
      ...(category === 'scheduling' ? [t('prompts.planScheduling')] : []),
      ...(category === 'dashboard' ? [t('prompts.planDashboard')] : []),
      ...(category === 'saas-authenticated' ? [t('prompts.planSaas')] : []),
      t('prompts.generateSpec', { spec: JSON.stringify(spec) }),
      ...(changeRequest === undefined ? [] : [t('prompts.changeRequest', { reason: changeRequest })]),
      t('prompts.schema', { schema: JSON.stringify(planOutputSchema.toJSONSchema()) }),
    ].join('\n'))
    const decoded = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    const output = planOutputSchema.parse(decoded)
    if ((category === 'form-database' || category === 'crud-panel' || category === 'scheduling' || category === 'dashboard' || category === 'saas-authenticated') && !output.slices.some(slice => slice.planned_files.includes('src/GeneratedApp.tsx'))) {
      throw new FormCategoryCapabilityError('FORM_ENTRY_FILE_REQUIRED', t('errors.formEntryFileRequired'))
    }
    return output
  }
}
