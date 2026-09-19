import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { policyTierSchema } from '@dz23-studio/policy'
import { routePrivacySchema } from '@dz23-studio/route-health'
import { z } from 'zod'
import { appSpecV1Schema } from './appspec.js'
import { designSpecV1Schema } from './design.js'

export const projectStateSchema = z.enum([
  'DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'GENERATING',
  'BUILD_OK', 'BUILD_FAILED', 'TESTS_OK', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED', 'VERIFIED_PROTOTYPE',
])
export type ProjectState = z.infer<typeof projectStateSchema>

const scope = {
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
}
const timestamp = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const studioProjectCategorySchema = z.enum(['landing-page', 'catalog', 'form-database', 'crud-panel', 'scheduling', 'saas-authenticated', 'dashboard', 'outro'])
export type StudioProjectCategory = z.infer<typeof studioProjectCategorySchema>

export const studioProjectSchema = z.object({
  project_id: z.string().min(1), ...scope,
  name: z.string().min(1).max(120),
  state: projectStateSchema,
  original_brief: z.string().min(1).max(10_000),
  category: studioProjectCategorySchema,
  created_by: z.string().min(1),
  /**
   * O perfil de rota DESTE projeto.
   *
   * É aqui que mora o "por projeto" do M-05: dois projetos do mesmo espaço de
   * trabalho podem ter perfis diferentes. O esquema aceita também os dois
   * valores do binário anterior porque a versão do domínio não pode subir e o
   * registro antigo tem de continuar validando; `routePrivacyProfile` traduz.
   */
  privacy: routePrivacySchema,
  /**
   * A tentativa para a qual a pessoa está olhando AGORA.
   *
   * Existe por causa do desfazer (E-08): voltar a um ponto seguro não apaga
   * nada, ele muda para onde a pessoa está olhando - e esse "onde" precisava de
   * um lugar para morar. É OPCIONAL e a versão do domínio NÃO sobe: todo
   * registro gravado antes dele continua válido, e ausente significa "a mais
   * recente", que é exatamente o que valia antes.
   */
  current_run_id: z.string().min(1).nullable().optional(),
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: timestamp.nullable(),
}).strict()

export const studioAppSpecRecordSchema = z.object({
  spec_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  version: z.number().int().positive(), app_spec: appSpecV1Schema,
  sha256, origin: z.enum(['intake', 'edit']), created_at: timestamp,
}).strict()

export const studioDesignSpecRecordSchema = z.object({
  design_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  version: z.number().int().positive(), design_spec: designSpecV1Schema,
  sha256, created_by: z.string().min(1), created_at: timestamp,
}).strict()

export const studioIntakeTurnSchema = z.object({
  turn_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  /*
    O `pergunta-da-pessoa` não é uma pergunta do questionário: é a PERGUNTA que
    a pessoa faz sobre a tarefa, guardada na MESMA conversa (ver `pergunta.ts`).
    Acrescentar um valor ao conjunto não invalida registro nenhum já gravado, e
    por isso a versão do domínio NÃO sobe — subir faria `open()` recusar toda
    instalação que já rodou, sem passo de migração neste seam.
  */
  question_id: z.enum(['audience', 'goal', 'content', 'sensitive-confirmation', 'pergunta-da-pessoa']),
  question: z.string().min(1), answer: z.string(), recommended: z.boolean(),
  route: z.string().nullable(), model: z.string().nullable(), created_at: timestamp,
}).strict()

export const planSliceSchema = z.object({
  slice_id: z.string().min(1), title: z.string().min(1),
  description: z.string().min(1), acceptance_criteria: z.array(z.string().min(1)).min(1),
  planned_files: z.array(z.string().min(1).max(240)).min(1).max(40),
}).strict()

export const studioPlanSchema = z.object({
  plan_id: z.string().min(1), spec_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  revision: z.number().int().positive().optional(),
  slices: z.array(planSliceSchema).min(1), status: z.enum(['PROPOSED', 'APPROVED', 'CHANGE_REQUESTED']),
  change_request: z.string().trim().min(3).max(2_000).nullable().optional(),
  /**
   * Se esta revisão saiu da mão da PESSOA e não do planejador (E-03).
   *
   * OPCIONAL de propósito: o descritor da unidade entra na versão do domínio,
   * e um campo obrigatório novo faria `open()` recusar todo plano já gravado.
   * Ele existe porque a atestação e o relatório precisam poder dizer que os
   * critérios foram escritos por quem pediu o aplicativo — atribuir ao
   * planejador o que a pessoa escreveu é mentir sobre a autoria do julgamento.
   */
  edited_by_person: z.boolean().optional(),
  created_at: timestamp, updated_at: timestamp,
}).strict()

export const studioRunSchema = z.object({
  run_id: z.string().min(1), operation_id: z.string().min(1), owner_session_id: z.string().min(1),
  plan_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  stage: z.enum(['generate', 'build', 'test', 'verify']), attempt: z.number().int().min(1).max(3),
  state: z.enum(['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED']),
  started_at: timestamp, finished_at: timestamp.nullable(),
  sandbox: z.enum(['full', 'unavailable']), route: z.string().nullable(), model: z.string().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(), output_tokens: z.number().int().nonnegative().nullable(),
  estimated_cost_usd: z.number().nonnegative().nullable(), run_directory: z.string().min(1),
  artifact_sha256: sha256.nullable().optional(),
  /**
   * O que a conferência de integridade do template disse SOBRE ESTA tentativa.
   *
   * O pipeline já comparava o hash da árvore protegida antes e depois de cada
   * tentativa e jogava o resultado fora quando ele batia. Sem gravá-lo não havia
   * como afirmar depois que uma tentativa era um ponto seguro - só que ela não
   * tinha reprovado, que é coisa diferente. OPCIONAL, e a versão do domínio NÃO
   * sobe: ausente quer dizer "não registrado", nunca "conferido".
   */
  template_integrity: z.enum(['VERIFIED', 'FAILED']).optional(),
  /**
   * Os resumos das quatro atestações desta execução: aceitação, manifesto,
   * SBOM e proveniência, mais a imagem e a política do construtor.
   *
   * OPCIONAL, e a versão do domínio NÃO sobe: subir a versão faria `open()`
   * falhar com `version-mismatch` para sempre numa instalação que já rodou, e
   * não existe passo de migração neste seam. Ausente quer dizer "esta execução
   * é anterior às atestações", nunca "foi atestada e deu certo".
   *
   * Guardar só os RESUMOS aqui é deliberado: os documentos inteiros vivem em
   * `evidence/`, e um registro de execução que carregasse o manifesto completo
   * de um app cresceria sem teto dentro do armazenamento por chave-valor.
   */
  attestations: z.object({
    acceptance_sha256: sha256,
    manifest_sha256: sha256,
    sbom_sha256: sha256,
    provenance_sha256: sha256,
    builder_image_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    policy_sha256: sha256,
  }).strict().optional(),
  /**
   * Os passos do construtor DESTA tentativa, na ordem em que aconteceram.
   *
   * Existe porque a criação era uma caixa preta enquanto acontecia. O registro
   * guardava a ETAPA (`build` ou `test`), e o construtor roda quatro passos
   * dentro dessas duas: `install`, `build`, `test` e `e2e`. Durante os minutos
   * mais longos do produto a pessoa via a mesma frase imóvel enquanto quatro
   * coisas diferentes aconteciam - e "parado" e "trabalhando" ficavam com a
   * mesma aparência.
   *
   * Só entram passos que REALMENTE começaram. Um passo ausente nunca quer dizer
   * "pulado com sucesso": quer dizer que não chegou a acontecer, e a tela sabe
   * distinguir "ainda vai" de "não chegou a ser" pelo estado da execução.
   *
   * OPCIONAL, e a versão do domínio NÃO sobe - mesmo motivo de
   * `template_integrity` e `attestations`: subir a versão faria `open()` falhar
   * com `version-mismatch` para sempre numa instalação que já rodou. Ausente
   * quer dizer "execução anterior a este registro", nunca "não teve passos".
   */
  steps: z.array(z.object({
    step: z.enum(['install', 'build', 'test', 'e2e']),
    // `PASSED`, e nao um estado absoluto de conclusao: o que o sistema sabe e
    // que o passo rodou e saiu com codigo zero. `gate:i18n` recusa
    // READY/DONE/PUBLISHED/DEPLOYED nesta maquina de estados exatamente porque
    // essas palavras afirmam mais do que qualquer registro pode sustentar - e
    // recusou a primeira versao deste campo, que dizia `DONE`.
    state: z.enum(['RUNNING', 'PASSED', 'FAILED']),
    started_at: timestamp, finished_at: timestamp.nullable(),
  }).strict()).optional(),
  /**
   * A execução de onde esta retomou, quando ela retomou de alguma.
   *
   * Uma criação cancelada recomeçava do ZERO: o modelo era chamado outra vez,
   * cobrado outra vez, e — porque geração não é determinística — devolvia um
   * aplicativo DIFERENTE do que estava sendo construído. Agora a tentativa
   * seguinte reaproveita os arquivos já gerados, e este campo diz de onde.
   *
   * Sem ele a retomada seria invisível: a pessoa veria uma criação terminar em
   * segundos sem saber por quê, e ninguém conseguiria auditar depois qual
   * geração produziu o artefato. OPCIONAL, e a versão do domínio NÃO sobe.
   */
  resumed_from_run_id: z.string().min(1).optional(),
  failure_code: z.string().nullable(),
  acceptance_checks: z.array(z.object({
    id: z.string().min(1), label: z.string().min(1),
    // A frase em português que a tela mostra (`acceptance.ts`). Ela entrou lá
    // em 09/09 e faltou aqui: toda execução gravada desde então era recusada na
    // reabertura, e o FRIGG não subia mais. Opcional: execuções antigas não têm.
    title: z.string().min(1).max(2_000).optional(),
    kind: z.enum(['language', 'title', 'page', 'section', 'entity', 'criterion', 'flow', 'auth', 'crud', 'scheduling', 'dashboard', 'saas']),
    expected: z.string().optional(),
    flow: z.object({
      // Vazios de propósito na conferência do painel (`addDashboardCheck`), que
      // não tem formulário nem lista. O `min(1)` que havia aqui recusava na
      // reabertura toda execução de um painel — o mesmo defeito do `title`.
      form_test_id: z.string(), list_test_id: z.string(), marker_field: z.string().min(1),
      // Legacy runs used requires_auth. Keep it readable while every new run
      // writes the two explicit boundaries below.
      requires_auth: z.boolean().optional(),
      submit_requires_auth: z.boolean().optional(), list_requires_auth: z.boolean().optional(),
      fields: z.array(z.object({
        name: z.string().min(1), type: z.enum(['text', 'number', 'date', 'boolean', 'email', 'phone', 'selection', 'reference']),
        required: z.boolean(), options: z.array(z.string()).optional(),
      }).strict()).min(1),
    }).strict().optional(),
    status: z.enum(['PENDING', 'PASSED', 'FAILED', 'NOT_AUTOMATED']),
  }).strict()),
}).strict()

export const studioEvidenceSchema = z.object({
  evidence_id: z.string().min(1), run_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  kind: z.enum(['build-log', 'test-report', 'a11y', 'security-scan', 'diff']),
  sha256, size_bytes: z.number().int().nonnegative(), relative_path: z.string().min(1), created_at: timestamp,
}).strict()

export const studioApprovalSchema = z.object({
  approval_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  subject: z.enum(['plan', 'generation', 'template-setup', 'transition']), subject_id: z.string().min(1),
  approved_by: z.string().min(1), approved_at: timestamp, tier: policyTierSchema,
  strong_identity: z.boolean(), from_state: projectStateSchema.nullable(), to_state: projectStateSchema.nullable(),
}).strict()

/**
 * A RESERVA de uma intencao de criacao, gravada ANTES da tarefa.
 *
 * A ordem importa e e o coracao do requisito: gravar a tarefa primeiro e a
 * reserva depois deixa uma janela em que um reinicio perde a chave e o reenvio
 * cria a segunda tarefa. Gravando a reserva primeiro, com o `project_id` ja
 * escolhido, um reenvio depois da queda encontra a reserva e TERMINA a criacao
 * com o mesmo identificador, em vez de comecar outra.
 */
export const studioCreationKeySchema = z.object({
  request_key: z.string().min(16).max(128),
  org_id: z.string().min(1), tenant_id: z.string().min(1), user_id: z.string().min(1),
  fingerprint: z.string().min(1), project_id: z.string().min(1), created_at: timestamp,
  /*
    QUAL ENVIO esta reserva identifica.

    A reserva nasceu para a CRIAÇÃO de tarefa, e ela continua sendo isso quando
    o campo está ausente — registro antigo não muda de significado. Os outros
    valores são os envios que acontecem DENTRO de uma tarefa já aberta e que
    também não podem duplicar quando a resposta se perde: a pergunta e o pedido
    de alteração.

    Os dois campos são OPCIONAIS e a versão do domínio NÃO sobe, pelo mesmo
    motivo de sempre neste esquema: `open()` falha com `version-mismatch` em
    instalação que já rodou, e não existe passo de migração neste seam.
  */
  kind: z.enum(['criacao', 'pergunta', 'revisao', 'resposta', 'mudanca']).optional(),
  /*
    O que o envio PRODUZIU — o turno da pergunta, a especificação da revisão.

    Na criação o resultado é a própria tarefa, e por isso `project_id` bastava.
    Num envio dentro da tarefa, `project_id` diz ONDE e este campo diz O QUÊ:
    sem ele, reenviar depois de perder a resposta não teria como devolver a
    mesma mensagem, só a mesma tarefa.
  */
  result_id: z.string().min(1).optional(),
}).strict()

export type StudioProject = z.infer<typeof studioProjectSchema>
export type StudioAppSpecRecord = z.infer<typeof studioAppSpecRecordSchema>
export type StudioDesignSpecRecord = z.infer<typeof studioDesignSpecRecordSchema>
export type StudioIntakeTurn = z.infer<typeof studioIntakeTurnSchema>
export type StudioPlan = z.infer<typeof studioPlanSchema>
export type StudioPlanSlice = z.infer<typeof planSliceSchema>
export type StudioRun = z.infer<typeof studioRunSchema>
/** Um passo do construtor dentro de uma tentativa, como o registro o guarda. */
export type StudioRunStep = NonNullable<StudioRun['steps']>[number]
export type StudioEvidence = z.infer<typeof studioEvidenceSchema>
export type StudioApproval = z.infer<typeof studioApprovalSchema>
export type StudioCreationKey = z.infer<typeof studioCreationKeySchema>
declare const promptKeyBrand: unique symbol
export type PromptToAppKey = string & { readonly [promptKeyBrand]: true }

export const studioProjectsDomainSpec = defineDomain({ name: 'studio_projects', version: 2, tables: { projects: domainTable<PromptToAppKey, StudioProject>(studioProjectSchema) } })
export const studioAppSpecsDomainSpec = defineDomain({ name: 'studio_app_specs', version: 1, tables: { specs: domainTable<PromptToAppKey, StudioAppSpecRecord>(studioAppSpecRecordSchema) } })
export const studioDesignSpecsDomainSpec = defineDomain({ name: 'studio_design_specs', version: 1, tables: { designs: domainTable<PromptToAppKey, StudioDesignSpecRecord>(studioDesignSpecRecordSchema) } })
export const studioIntakeTurnsDomainSpec = defineDomain({ name: 'studio_intake_turns', version: 1, tables: { turns: domainTable<PromptToAppKey, StudioIntakeTurn>(studioIntakeTurnSchema) } })
export const studioPlansDomainSpec = defineDomain({ name: 'studio_plans', version: 1, tables: { plans: domainTable<PromptToAppKey, StudioPlan>(studioPlanSchema) } })
export const studioRunsDomainSpec = defineDomain({ name: 'studio_runs', version: 5, tables: { runs: domainTable<PromptToAppKey, StudioRun>(studioRunSchema) } })
export const studioEvidenceDomainSpec = defineDomain({ name: 'studio_evidence', version: 1, tables: { evidence: domainTable<PromptToAppKey, StudioEvidence>(studioEvidenceSchema) } })
export const studioApprovalsDomainSpec = defineDomain({ name: 'studio_approvals', version: 2, tables: { approvals: domainTable<PromptToAppKey, StudioApproval>(studioApprovalSchema) } })
export const studioCreationKeysDomainSpec = defineDomain({ name: 'studio_creation_keys', version: 1, tables: { keys: domainTable<PromptToAppKey, StudioCreationKey>(studioCreationKeySchema) } })

export const PROMPT_TO_APP_DOMAIN_SPECS = [
  studioProjectsDomainSpec, studioAppSpecsDomainSpec, studioDesignSpecsDomainSpec, studioIntakeTurnsDomainSpec,
  studioPlansDomainSpec, studioRunsDomainSpec, studioEvidenceDomainSpec, studioApprovalsDomainSpec, studioCreationKeysDomainSpec,
] as const
