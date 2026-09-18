import { assembleContext, DEFAULT_CONTEXT_BUDGET_CHARS, type ContextLedger, type ContextSection } from './context.js'
import { z } from 'zod'
import type { RoutePrivacy } from '@dz23-studio/route-health'
import type { AppSpecV1 } from './appspec.js'
import { assertValidDataModel } from './data-generator.js'
import { planningRules } from './import-policy.js'
import { planSliceSchema, type StudioProjectCategory } from './model.js'
import type { PromptModelPort } from './ports.js'
import { codeIndexSummary, type AppSourcesRead, type CodeIndex } from './code-intelligence.js'
import {
  loadSkills, selectSkills,
  type SkillCard, type SkillRefusal, type SkillSelection,
} from './skill-registry.js'
import { prompt, t } from './i18n.js'
import { decodeModelJson } from './model-json.js'

/**
 * De onde as habilidades vêm, quando vêm.
 *
 * OPCIONAL no planejador inteiro, e a ausência é o padrão: uma instalação sem
 * habilidades instaladas planeja exatamente como planejava antes. Tornar isto
 * obrigatório faria o motor de planejamento exigir o registro de integrações
 * para funcionar — e o planejamento é o caminho central do produto.
 */
export interface PlannerSkills {
  cards(actor: PlannerActor): Promise<readonly SkillCard[]>
  load(actor: PlannerActor, skillId: string): Promise<string>
}

/**
 * Quem está planejando.
 *
 * `orgId` e `tenantId` são o que o modelo precisa. `userId` e `role` são o que
 * o REGISTRO DE INTEGRAÇÕES precisa, e eles são opcionais porque o
 * planejamento existia antes das habilidades e continua existindo sem elas —
 * um chamador que passa só o escopo planeja, e não carrega habilidade nenhuma.
 *
 * Sem ator completo, o registro NÃO é consultado. Inventar um ator para poder
 * ler seria contornar a própria conferência de papel.
 */
export interface PlannerActor {
  readonly orgId: string
  readonly tenantId: string
  readonly userId?: string | undefined
  readonly role?: string | undefined
}

/**
 * Quanto do teto do contexto as habilidades podem ocupar ao todo.
 *
 * Uma fração, e não um número: o resto do contexto — a especificação que a
 * pessoa descreveu, o schema que torna a resposta analisável — cresce com o
 * pedido, e um número fixo de caracteres para habilidades apertaria justamente
 * os pedidos maiores, que são os que mais precisam de espaço.
 *
 * Trinta por cento é uma escolha, e ela é conservadora de propósito: o que
 * sobra tem de caber o pedido INTEIRO, porque instrução de terceiro nunca pode
 * empurrar para fora o que a pessoa pediu.
 */
export const SKILL_ALLOWANCE_FRACTION = 0.3

/**
 * O que JÁ existe no aplicativo, para o planejamento de uma MUDANÇA.
 *
 * Opcional, e só faz sentido quando há mudança: num plano NOVO não existe
 * código ainda, e um resumo dizendo "o aplicativo já tem estes arquivos" seria
 * falso. É por isso que ele não é lido no primeiro planejamento.
 */
export interface PlannerCodeContext {
  readonly index: CodeIndex
  readonly skipped?: AppSourcesRead['skipped'] | undefined
  /** Os arquivos que a mudança deve tocar, quando já se sabe. */
  readonly changed?: readonly string[] | undefined
}

/** O que as habilidades acrescentaram a um planejamento, e o que ficou de fora. */
export interface PlannerSkillReport {
  readonly selection: SkillSelection
  readonly refused: readonly SkillRefusal[]
  readonly loaded: readonly string[]
}

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

/**
 * O plano MAIS a contabilidade de como ele foi pedido.
 *
 * Isto era estado de INSTANCIA — `lastLedger`, `lastSkills`, `lastCode` —, e o
 * motor e criado UMA VEZ por processo e servido a todos os inquilinos. A rota
 * de plano lia esses campos DEPOIS de um `await`, e nessa janela outro pedido,
 * de outra organizacao, ja tinha sobrescrito os tres. A resposta de um
 * inquilino saía com o contexto de outro: quais habilidades de terceiro a outra
 * organizacao tem instaladas, o que foi recusado e por que, se o pedido dela
 * era mudanca ou criacao nova.
 *
 * A revisao adversarial reproduziu a corrida. Nao foi inferida.
 *
 * O comentario que justificava guardar no motor dizia que "misturar o plano com
 * a contabilidade faria o schema do plano carregar coisa que nao e plano" — e
 * isso continua verdade, e e por isso que a contabilidade viaja num campo
 * IRMAO do plano, e nao dentro dele. Um valor devolvido nao tem janela: ele
 * pertence a chamada que o produziu, e a nenhuma outra.
 */
export interface PlanWithContext {
  readonly output: PlanOutput
  readonly ledger: ContextLedger
  readonly skills: PlannerSkillReport | undefined
  readonly code: readonly string[] | undefined
  /**
   * O inventario de codigo ficou INCOMPLETO?
   *
   * Um booleano, e nao uma busca por palavra dentro do resumo. A primeira
   * versao procurava a substring `INCOMPLETA` no texto — e esse texto vem do
   * CATALOGO DE TRADUCAO. Traduzir o produto, ou so reescrever a frase, apagava
   * o aviso em silencio: a pessoa aprovaria um plano montado sobre codigo que
   * ninguem conseguiu ler inteiro, sem nada na tela dizendo isso. Falha do lado
   * errado, e achada pela revisao adversarial.
   */
  readonly codeIncomplete: boolean
}

export class PlannerEngine {
  constructor(
    private readonly model: PromptModelPort,
    private readonly budgetChars?: number,
    private readonly skills?: PlannerSkills,
  ) {}

  /**
   * As partes de contexto vindas das habilidades que servem para este pedido.
   *
   * Devolve vazio — e NÃO lança — quando não há registro montado: uma
   * instalação sem habilidades planeja como sempre planejou.
   * @param request - o texto do pedido, de onde sai o casamento.
   * @param budget - o teto total do contexto.
   * @returns as partes já carregadas e conferidas.
   */
  async #skillSections(actor: PlannerActor, request: string, budget: number): Promise<{
    readonly sections: readonly ContextSection[]
    readonly report: PlannerSkillReport | undefined
  }> {
    const registry = this.skills
    if (registry === undefined) return { sections: [], report: undefined }
    // Sem ator completo não há leitura: o registro confere papel, e montar um
    // ator aqui para conseguir ler seria contornar essa conferência por dentro.
    if (actor.userId === undefined || actor.role === undefined) return { sections: [], report: undefined }
    const selection = selectSkills(await registry.cards(actor), request, Math.floor(budget * SKILL_ALLOWANCE_FRACTION))
    const { sections, refused } = await loadSkills(
      selection.chosen, { load: async skillId => registry.load(actor, skillId) },
    )
    return { sections, report: { selection, refused, loaded: sections.map(section => section.id) } }
  }

  async plan(
    scope: PlannerActor, privacy: RoutePrivacy, spec: AppSpecV1,
    category: StudioProjectCategory = 'landing-page', changeRequest?: string,
    code?: PlannerCodeContext,
  ): Promise<PlanWithContext> {
    assertCategoryCanGenerate(category, spec)
    // As habilidades entram ANTES da montagem, e não depois: elas são
    // `instruction`, e instrução não é cortável — descobrir que não cabem
    // depois de montar seria descobrir com um erro de teto sobre o pedido
    // inteiro, em vez de com uma habilidade a menos.
    // O que a pessoa DESCREVEU é o que decide quais habilidades servem: o
    // problema, para quem é, e os caminhos que ela quer que existam. As
    // entidades e os campos ficam de fora de propósito — nomes de coluna
    // casariam com gatilho por coincidência de vocabulário técnico, e não por
    // o assunto ser aquele.
    const skills = await this.#skillSections(
      scope,
      [spec.problem, spec.audience, ...spec.journeys, ...spec.pages.map(page => page.name), changeRequest ?? ''].join(' '),
      this.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS,
    )
    // O inventário só é montado quando há mudança a planejar: num plano novo
    // não existe código ainda, e um resumo dizendo "o aplicativo já tem estes
    // arquivos" seria falso.
    const codeLines = code === undefined || changeRequest === undefined
      ? []
      : codeIndexSummary(code.index, code.changed ?? [], code.skipped ?? [])
    const assembled = assembleContext([
      instruction('plan.only', prompt('prompts.planOnly')),
      instruction('plan.criteria', prompt('prompts.planCriteria')),
      instruction('plan.files', prompt('prompts.planFiles')),
      instruction('plan.first', prompt('prompts.planFirst')),
      // Os LIMITES do que o aplicativo gerado consegue fazer, vindos da mesma
      // lista que o construtor usa para RECUSAR. Sem eles nada impedia o plano
      // de prometer "busca o endereço pelo CEP": a pessoa aprovava, e só na
      // criação o construtor recusava `fetch` — tentativa atrás de tentativa
      // num plano que ele nunca poderia satisfazer.
      //
      // INSTRUÇÃO e não evidência: uma evidência cortada pelo teto empobrece o
      // plano, uma regra cortada muda o que é permitido prometer.
      ...planningRules().map((text, index) => instruction(`plan.limit${String(index)}`, text)),
      ...categoryInstruction(category),
      ...skills.sections,
      // O que JÁ existe entra como EVIDÊNCIA e não como instrução: é material
      // sobre o qual o modelo raciocina, e ele pode ser cortado pelo teto sem
      // mudar nenhuma regra. Uma instrução cortada muda a regra; um inventário
      // cortado deixa o plano mais pobre, e é por isso que a última linha do
      // resumo já avisa que ele pode estar incompleto.
      //
      // Prioridade ACIMA da especificação: num pedido de mudança, o que já
      // está escrito importa mais do que a descrição original — é justamente a
      // diferença entre os dois que o pedido pede para resolver.
      ...(codeLines.length === 0
        ? []
        : [{ id: 'plan.code', kind: 'evidence' as const, priority: 110, source: 'code-index', text: codeLines.join('\n') }]),
      // A especificação é EVIDÊNCIA: é sobre ela que o modelo raciocina, e é
      // a única parte que cresce com o tamanho do que a pessoa descreveu.
      { id: 'plan.spec', kind: 'evidence' as const, priority: 100, source: 'app-spec', text: prompt('prompts.generateSpec', { spec: JSON.stringify(spec) }) },
      ...(changeRequest === undefined
        ? []
        : [{ id: 'plan.change', kind: 'evidence' as const, priority: 90, source: 'change-request', text: prompt('prompts.changeRequest', { reason: changeRequest }) }]),
      { id: 'plan.schema', kind: 'schema' as const, priority: 0, source: 'planOutputSchema', text: prompt('prompts.schema', { schema: JSON.stringify(planOutputSchema.toJSONSchema()) }) },
    ], { budgetChars: this.budgetChars })
    const result = await this.model.complete(scope, 'plan', privacy, assembled.prompt)
    const decoded = decodeModelJson(result.value)
    const output = planOutputSchema.parse(decoded)
    if (CATEGORY_REQUIRES_DATA_MODEL[category] !== false && !output.slices.some(slice => slice.planned_files.includes('src/GeneratedApp.tsx'))) {
      throw new FormCategoryCapabilityError('FORM_ENTRY_FILE_REQUIRED', t('errors.formEntryFileRequired'))
    }
    return {
      output, ledger: assembled.ledger, skills: skills.report,
      code: codeLines.length === 0 ? undefined : codeLines,
      codeIncomplete: (code?.skipped ?? []).length > 0,
    }
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
  ): Promise<{ readonly slice: PlanSliceOutput; readonly ledger: ContextLedger }> {
    assertCategoryCanGenerate(category, spec)
    const assembled = assembleContext([
      instruction('slice.only', prompt('prompts.sliceOnly')),
      instruction('slice.criteria', prompt('prompts.planCriteria')),
      instruction('slice.files', prompt('prompts.planFiles')),
      instruction('slice.sliceFiles', prompt('prompts.sliceFiles')),
      // A etapa ACRESCENTADA à mão é o caminho mais provável de todos para uma
      // promessa impossível: é onde a pessoa escreve, em texto livre, o que
      // ficou faltando — e "mandar por e-mail" é exatamente o que ela escreve.
      ...planningRules().map((text, index) => instruction(`slice.limit${String(index)}`, text)),
      // O PEDIDO da pessoa e o que esta etapa existe para atender: se algo
      // tiver de sair por falta de espaco, nao pode ser ele.
      { id: 'slice.request', kind: 'evidence' as const, priority: 100, source: 'slice-request', text: prompt('prompts.sliceRequest', { request }) },
      // O plano que ja existe evita que a etapa nova repita o que ja ha. Cair
      // fora piora o plano, mas nao o torna invalido: a colisao de arquivos e
      // conferida em CODIGO depois, e nao confiada a esta instrucao.
      { id: 'slice.existing', kind: 'evidence' as const, priority: 80, source: 'existing-plan', text: prompt('prompts.sliceExisting', { slices: JSON.stringify(existing.map(slice => ({ title: slice.title, planned_files: slice.planned_files }))) }) },
      { id: 'slice.spec', kind: 'evidence' as const, priority: 90, source: 'app-spec', text: prompt('prompts.generateSpec', { spec: JSON.stringify(spec) }) },
      { id: 'slice.schema', kind: 'schema' as const, priority: 0, source: 'slice-output-schema', text: prompt('prompts.schema', { schema: JSON.stringify(sliceOutputSchema.toJSONSchema()) }) },
    ], { budgetChars: this.budgetChars })
    const result = await this.model.complete(scope, 'plan', privacy, assembled.prompt)
    const decoded = decodeModelJson(result.value)
    // O registro sai DEVOLVIDO, pelo mesmo motivo de `plan`: guardado no motor,
    // ele pertenceria ao ultimo pedido que passou por aqui, e nao a este.
    return { slice: sliceOutputSchema.parse(decoded).slice, ledger: assembled.ledger }
  }
}

/** A fatia devolvida pelo planejador. */
export type PlanSliceOutput = z.infer<typeof sliceOutputSchema>['slice']
