import { assembleContext, type ContextLedger, type ContextSection } from './context.js'
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
  // `CATEGORY_NOT_IMPLEMENTED` saiu deste union em 11/09/2026: ele estava
  // declarado e NUNCA era lancado. Quem tratasse esse codigo na tela estaria
  // tratando um caso impossivel, e a promessa de diagnostico que ele fazia era
  // vazia. A guarda real contra categoria nao coberta agora e a tabela
  // exaustiva abaixo, que falha em tempo de COMPILACAO em vez de prometer um
  // erro de execucao que ninguem emite.
  constructor(readonly code: 'FORM_DATABASE_REQUIRED' | 'FORM_REFERENCE_REQUIRES_CRUD' | 'FORM_ENTRY_FILE_REQUIRED', message: string) {
    super(message)
  }
}

/**
 * Quais categorias exigem um modelo de dados para poder ser geradas.
 *
 * Era uma lista NEGADA (`category !== 'form-database' && category !== ...`) em
 * dois lugares diferentes, e as duas listas precisavam concordar. O problema
 * nao era o estilo: uma categoria NOVA caia no `return` silencioso e passava
 * sem conferencia nenhuma — geraria um aplicativo com formulario e sem banco,
 * e o defeito so apareceria para quem usasse o aplicativo.
 *
 * `Record` EXAUSTIVO: categoria nova nao compila sem uma resposta aqui.
 */
export const CATEGORY_REQUIRES_DATA_MODEL: Readonly<Record<StudioProjectCategory, boolean>> = {
  // Paginas de apresentacao e catalogos mostram conteudo; nao guardam registro
  // de ninguem.
  'landing-page': false,
  catalog: false,
  // Estas cinco recebem, listam ou editam dados de pessoas. Sem modelo de
  // dados, o formulario existiria e nao guardaria nada.
  'form-database': true,
  'crud-panel': true,
  scheduling: true,
  dashboard: true,
  'saas-authenticated': true,
}

export function assertCategoryCanGenerate(category: StudioProjectCategory, spec: AppSpecV1): void {
  // `=== false` e nao `!`: um `Record<Union, boolean>` indexado com uma
  // categoria vinda de FORA do union devolve `undefined`, e `!undefined` seria
  // `true` - a conferencia seria PULADA justamente no caso desconhecido, que e
  // o defeito que esta tabela existe para fechar. Assim, so quem esta na
  // tabela dizendo `false` sai sem conferencia.
  if (CATEGORY_REQUIRES_DATA_MODEL[category] === false) return
  const entities = spec.entities.filter(entity => entity.kind === 'database')
  if (entities.length === 0) throw new FormCategoryCapabilityError('FORM_DATABASE_REQUIRED', t('errors.formDatabaseRequired'))
  assertValidDataModel(spec)
}

/**
 * Uma instrução: o que o modelo tem de fazer. Nunca é cortada.
 * @param id - identificador estável da parte.
 * @param text - o texto já traduzido.
 * @returns a parte pronta para a montagem.
 */
function instruction(id: string, text: string): ContextSection {
  // A procedencia e IDENTIFICADOR e nao frase: ela e comparada, agrupada e
  // guardada em registro, nao lida em tela. Prosa aqui seria texto de interface
  // escondido no meio de metadado - e `gate:i18n` reprova, com razao.
  return { id, kind: 'instruction', priority: 0, text, source: 'studio-instruction' }
}

/**
 * A instrução específica da categoria, quando existir.
 *
 * Tabela EXAUSTIVA em vez de cinco ternários: categoria nova não compila sem
 * uma resposta aqui, e `null` é uma resposta legítima — landing page e
 * catálogo não têm instrução própria.
 * @param category - a categoria do projeto.
 * @returns zero ou uma parte.
 */
function categoryInstruction(category: StudioProjectCategory): readonly ContextSection[] {
  const key: Readonly<Record<StudioProjectCategory, string | null>> = {
    'landing-page': null,
    catalog: null,
    'form-database': 'prompts.planFormDatabase',
    'crud-panel': 'prompts.planCrudPanel',
    scheduling: 'prompts.planScheduling',
    dashboard: 'prompts.planDashboard',
    'saas-authenticated': 'prompts.planSaas',
  }
  const chosen = key[category]
  return chosen === null ? [] : [instruction(`plan.category.${category}`, t(chosen))]
}

export class PlannerEngine {
  /**
   * O registro do ÚLTIMO contexto montado.
   *
   * Existe para que a pergunta "o que exatamente o modelo viu?" tenha resposta
   * sem precisar reproduzir a execução. Fica no motor e não no retorno porque
   * o retorno é o plano, e misturar o plano com a contabilidade de como ele
   * foi pedido faria o schema do plano carregar coisa que não é plano.
   */
  lastLedger: ContextLedger | undefined

  constructor(private readonly model: PromptModelPort, private readonly budgetChars?: number) {}

  async plan(scope: { orgId: string; tenantId: string }, privacy: RoutePrivacy, spec: AppSpecV1, category: StudioProjectCategory = 'landing-page', changeRequest?: string): Promise<PlanOutput> {
    assertCategoryCanGenerate(category, spec)
    const assembled = assembleContext([
      instruction('plan.only', t('prompts.planOnly')),
      instruction('plan.criteria', t('prompts.planCriteria')),
      instruction('plan.files', t('prompts.planFiles')),
      instruction('plan.first', t('prompts.planFirst')),
      ...categoryInstruction(category),
      // A especificação é EVIDÊNCIA: é sobre ela que o modelo raciocina, e é
      // a única parte que cresce com o tamanho do que a pessoa descreveu.
      { id: 'plan.spec', kind: 'evidence' as const, priority: 100, source: 'app-spec', text: t('prompts.generateSpec', { spec: JSON.stringify(spec) }) },
      ...(changeRequest === undefined
        ? []
        : [{ id: 'plan.change', kind: 'evidence' as const, priority: 90, source: 'change-request', text: t('prompts.changeRequest', { reason: changeRequest }) }]),
      { id: 'plan.schema', kind: 'schema' as const, priority: 0, source: 'planOutputSchema', text: t('prompts.schema', { schema: JSON.stringify(planOutputSchema.toJSONSchema()) }) },
    ], { budgetChars: this.budgetChars })
    this.lastLedger = assembled.ledger
    const result = await this.model.complete(scope, 'plan', privacy, assembled.prompt)
    const decoded = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    const output = planOutputSchema.parse(decoded)
    if (CATEGORY_REQUIRES_DATA_MODEL[category] !== false && !output.slices.some(slice => slice.planned_files.includes('src/GeneratedApp.tsx'))) {
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
