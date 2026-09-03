import { z } from 'zod'
import type { AppSpecV1 } from './appspec.js'
import { planSliceSchema } from './model.js'
import type { PromptModelPort } from './ports.js'

const planOutputSchema = z.object({ slices: z.array(planSliceSchema).min(1).max(6) }).strict()
export type PlanOutput = z.infer<typeof planOutputSchema>

export class PlannerEngine {
  constructor(private readonly model: PromptModelPort) {}

  async plan(scope: { orgId: string; tenantId: string }, privacy: 'local-only' | 'any', spec: AppSpecV1, changeRequest?: string): Promise<PlanOutput> {
    const result = await this.model.complete(scope, 'plan', privacy, [
      'Produza somente JSON válido com fatias verticais em linguagem comum.',
      'Cada fatia precisa de título, descrição e critérios de aceite testáveis.',
      'Cada fatia precisa listar planned_files. Use somente caminhos sob src/ ou content/.',
      'A primeira fatia deve criar content/app.json e src/GeneratedApp.tsx; estilos adicionais ficam em src/generated.css.',
      `AppSpec: ${JSON.stringify(spec)}`,
      ...(changeRequest === undefined ? [] : [`Pedido de mudança da pessoa: ${changeRequest}`]),
      `Schema: ${JSON.stringify(planOutputSchema.toJSONSchema())}`,
    ].join('\n'))
    const decoded = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    return planOutputSchema.parse(decoded)
  }
}
