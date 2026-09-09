import { z } from 'zod'
import type { RoutePrivacy } from '@dz23-studio/route-health'
import type { AppSpecV1 } from './appspec.js'
import { assertValidDataModel } from './data-generator.js'
import { planSliceSchema, type StudioProjectCategory } from './model.js'
import type { PromptModelPort } from './ports.js'
import { t } from './i18n.js'

const planOutputSchema = z.object({ slices: z.array(planSliceSchema).min(1).max(6) }).strict()
export type PlanOutput = z.infer<typeof planOutputSchema>

/** Uma fatia só, para acrescentar a um plano que a pessoa já editou. */
const sliceOutputSchema = z.object({ slice: planSliceSchema }).strict()

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

  async plan(scope: { orgId: string; tenantId: string }, privacy: RoutePrivacy, spec: AppSpecV1, category: StudioProjectCategory = 'landing-page', changeRequest?: string): Promise<PlanOutput> {
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

  /**
   * UMA fatia nova, para acrescentar ao plano que já existe.
   *
   * Existe porque a edição do plano não conseguia acrescentar nada. Quem
   * quisesse algo fora do plano tinha de pedir uma mudança em texto livre e
   * recebia **uma revisão inteira** — perdendo, junto, todos os títulos e
   * critérios que já tinha ajustado à mão.
   *
   * ## Por que o PLANEJADOR, e não a pessoa
   *
   * Porque `planned_files` não é descrição: é a **autorização de escrita** do
   * gerador. Deixar a pessoa digitar caminhos seria entregar a ela a caneta que
   * decide onde o modelo pode mexer — e ela não tem como saber que
   * `src/GeneratedApp.tsx` é o arquivo de entrada e que um caminho fora de
   * `src/` ou `content/` não existe. Ela descreve o que falta em português; o
   * planejador devolve a fatia com os arquivos.
   *
   * O plano atual vai no pedido para o planejador NÃO repetir o que já está
   * lá, e a conferência de colisão logo abaixo é o que garante isso de fato —
   * instrução em texto é pedido, não garantia.
   *
   * @param scope - organização e inquilino.
   * @param privacy - o perfil de rota do projeto.
   * @param spec - a especificação aprovada.
   * @param existing - as fatias que já estão no plano.
   * @param request - o que a pessoa escreveu que falta.
   * @param category - a categoria do projeto.
   * @returns a fatia nova, com os arquivos que ela pode tocar.
   */
  async slice(
    scope: { orgId: string; tenantId: string },
    privacy: RoutePrivacy,
    spec: AppSpecV1,
    existing: readonly { readonly title: string; readonly planned_files: readonly string[] }[],
    request: string,
    category: StudioProjectCategory = 'landing-page',
  ): Promise<PlanSliceOutput> {
    assertCategoryCanGenerate(category, spec)
    const result = await this.model.complete(scope, 'plan', privacy, [
      t('prompts.sliceOnly'),
      t('prompts.planCriteria'),
      t('prompts.planFiles'),
      t('prompts.sliceFiles'),
      t('prompts.sliceExisting', { slices: JSON.stringify(existing.map(slice => ({ title: slice.title, planned_files: slice.planned_files }))) }),
      t('prompts.generateSpec', { spec: JSON.stringify(spec) }),
      t('prompts.sliceRequest', { request }),
      t('prompts.schema', { schema: JSON.stringify(sliceOutputSchema.toJSONSchema()) }),
    ].join('\n'))
    const decoded = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    return sliceOutputSchema.parse(decoded).slice
  }
}

/** A fatia devolvida pelo planejador. */
export type PlanSliceOutput = z.infer<typeof sliceOutputSchema>['slice']
