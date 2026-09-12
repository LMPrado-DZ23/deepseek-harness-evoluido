import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { policyTierSchema } from '@dz23-studio/policy'
import { z } from 'zod'

const scope = { org_id: z.string().min(1), tenant_id: z.string().min(1) }
const timestamp = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

/** Environment-style credential reference (the Harness credential seam grammar). The value never leaves the vault. */
export const secretRefSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u)

export const integrationKindSchema = z.enum(['smtp', 'mcp', 'skill', 'webhook'])
export type IntegrationKind = z.infer<typeof integrationKindSchema>

export const integrationPermissionSchema = z.enum([
  'read.project', 'write.project', 'network.outbound', 'filesystem.workspace', 'secrets.read', 'email.send',
])
/** Every permission has a declared floor in `manifest.ts`; adding one here without one is a type error. */
export type IntegrationPermission = z.infer<typeof integrationPermissionSchema>

/**
 * De onde a integração veio — o requisito X-02.
 *
 * O manifesto v1 dizia QUEM publicou e o que ela pede fazer, e não dizia DE
 * ONDE ela veio nem SOB QUE LICENÇA. Sem isso, a assinatura provava só que
 * aquele publicador assinou aquele texto: ela não permitia a ninguém ir até a
 * fonte e conferir que o texto descreve o que está lá.
 */
export const integrationProvenanceSchema = z.object({
  /** O endereço público de onde ela vem. Só http(s): um `file:` seria o disco de quem hospeda. */
  source_url: z.string().url().refine(value => /^https?:\/\//u.test(value), 'http(s) only'),
  /** O commit exato. `null` quando a origem não é um repositório versionado, e nunca um valor inventado. */
  commit: z.string().regex(/^[a-f0-9]{40}$/u).nullable(),
  /** O hash do artefato publicado. É ele que liga este manifesto a bytes. */
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  /** Identificador SPDX. Texto livre aqui deixaria "grátis" passar por licença. */
  license: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u),
  /** A faixa de versões do Studio em que ela declara funcionar. */
  compatibility: z.object({ studio: z.string().min(1).max(64) }).strict(),
}).strict()

/**
 * O que a integração declara que PRECISA tocar.
 *
 * Declarar não é receber: isto é a promessa do publicador, escrita antes de
 * alguém ligar a integração, para que a decisão de ligar seja tomada com a
 * lista na frente. Um manifesto que não diz que fala com a rede e depois fala
 * com a rede é um manifesto que mentiu — e mentir por escrito é auditável,
 * enquanto não dizer nada não é.
 */
export const integrationCapabilitiesSchema = z.object({
  network: z.object({
    /**
     * Os endereços com quem ela fala. `*` sozinho é RECUSADO: uma integração
     * que declara falar com a internet inteira não declarou nada, e a lista
     * existe justamente para ser lida por quem decide.
     */
    egress: z.array(z.string().regex(/^(?!\*$)[a-z0-9*][a-z0-9.*-]{0,253}$/u)).max(50),
  }).strict(),
  filesystem: z.object({
    /** Caminhos RELATIVOS. Um caminho absoluto seria o disco de quem hospeda. */
    read: z.array(z.string().regex(/^(?!\/)[^\0]{1,200}$/u)).max(50),
    write: z.array(z.string().regex(/^(?!\/)[^\0]{1,200}$/u)).max(50),
  }).strict(),
  /**
   * Os segredos que ela usa, POR REFERÊNCIA.
   *
   * O formato é o mesmo do cofre, e nunca um valor: um manifesto é um
   * documento público e assinado, e um segredo dentro dele estaria publicado e
   * assinado junto.
   */
  secrets: z.array(secretRefSchema).max(20),
  /** As ferramentas que ela expõe, pelo nome. */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u)).max(100),
}).strict()

/**
 * Integration manifest v1 (D16) e v2 (X-02). `signature` is an Ed25519
 * signature (base64) over the canonical JSON of the manifest without the
 * `signature` field.
 *
 * As duas versões convivem: um manifesto v1 já assinado continua verificando
 * exatamente como antes. Fazer v2 substituir v1 invalidaria toda assinatura já
 * emitida — e uma migração forçada de manifesto é a forma mais rápida de fazer
 * alguém desligar a verificação para voltar a trabalhar.
 */
const integrationManifestV1Schema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
  // NOT `.trim()`: the signature is verified over the manifest as supplied, so a schema that
  // silently trimmed produced a record whose bytes were not the bytes that were signed.
  name: z.string().min(1).max(120).regex(/^\S(.*\S)?$/su, 'no-padding'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  kind: integrationKindSchema,
  publisher: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u), name: z.string().min(1).max(120).regex(/^\S(.*\S)?$/su, 'no-padding') }).strict(),
  tier: z.string().optional(),
  permissions: z.array(integrationPermissionSchema).max(20).default([]),
  endpoint: z.string().url().optional(),
  description: z.string().max(500).regex(/^(\S(.*\S)?)?$/su, 'no-padding').optional(),
  signature: z.string().base64().optional(),
}).strict()

/**
 * O que uma HABILIDADE precisa declarar para poder ser carregada aos poucos.
 *
 * `body_chars` não é contabilidade: sem ele não existe carregamento
 * progressivo, só carregar e torcer. A escolha de quais habilidades entram no
 * contexto é feita ANTES de buscar o texto de qualquer uma, e ela precisa saber
 * quanto cada uma pesa — senão a única forma de descobrir seria carregar todas,
 * que é exatamente o que se quer evitar.
 *
 * `trigger` é a linha que decide a escolha. Ela é separada de `description`
 * porque as duas têm leitores diferentes: a descrição é para a pessoa que
 * decide ligar, e o gatilho é para a máquina que decide usar.
 *
 * OPCIONAL, e um manifesto de habilidade sem ele simplesmente não produz ficha
 * — a habilidade fica registrada e nunca é escolhida, o que é dito em vez de
 * silencioso. Torná-lo obrigatório invalidaria toda assinatura já emitida.
 */
export const integrationSkillSchema = z.object({
  trigger: z.string().min(3).max(300).regex(/^\S(.*\S)?$/su, 'no-padding'),
  body_chars: z.number().int().positive().max(200_000),
}).strict()

const integrationManifestV2Schema = integrationManifestV1Schema.extend({
  schema_version: z.literal(2),
  provenance: integrationProvenanceSchema,
  capabilities: integrationCapabilitiesSchema,
  skill: integrationSkillSchema.optional(),
}).strict()

export const integrationManifestSchema = z.discriminatedUnion('schema_version', [
  integrationManifestV1Schema,
  integrationManifestV2Schema,
])
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>
export type IntegrationManifestV2 = z.infer<typeof integrationManifestV2Schema>
export type IntegrationProvenance = z.infer<typeof integrationProvenanceSchema>
export type IntegrationCapabilities = z.infer<typeof integrationCapabilitiesSchema>

/**
 * Quando o manifesto diz de onde veio e o que toca.
 * @param manifest - o manifesto.
 * @returns se ele é v2.
 */
export function declaresProvenance(manifest: IntegrationManifest | null): manifest is IntegrationManifestV2 {
  return manifest?.schema_version === 2
}

export const verificationSchema = z.enum(['verified', 'unverified', 'invalid'])
export type Verification = z.infer<typeof verificationSchema>

export const studioIntegrationSchema = z.object({
  integration_id: z.string().min(1), ...scope,
  kind: integrationKindSchema,
  name: z.string().min(1).max(120),
  manifest: integrationManifestSchema.nullable(),
  effective_tier: policyTierSchema,
  verification: verificationSchema,
  enabled: z.boolean(),
  /** For `smtp`: the credential reference name. Never a value. */
  secret_ref: secretRefSchema.nullable(),
  created_by: z.string().min(1),
  created_at: timestamp, updated_at: timestamp,
  // --- X-08: o que já foi CHAMADO nesta integração, neste escopo -------------
  //
  // Todo campo abaixo é OPCIONAL e a versão do domínio continua sendo 1: um
  // registro gravado antes destes campos existirem tem de continuar abrindo, e
  // não há migração — `open()` falharia com `version-mismatch` numa instalação
  // que já existe. Ausência NÃO é zero: é "nunca foi chamada", e é por isso que
  // `integrationHealthState` responde `NOT_EXECUTED` em vez de inventar um `OK`
  // para uma integração que ninguém acionou.
  /** Tentativas que saíram daqui, incluindo a repetição única quando houve. */
  calls: z.number().int().nonnegative().optional(),
  /** Tentativas que terminaram em erro ou em estouro de tempo. */
  failures: z.number().int().nonnegative().optional(),
  /** Falhas SEGUIDAS; zera no primeiro sucesso. Uma taxa não distingue "caiu agora" de "caiu no mês passado". */
  consecutive_failures: z.number().int().nonnegative().optional(),
  /** Quantas tentativas o Studio parou de esperar. Separado de `failures` porque a causa é outra. */
  timeouts: z.number().int().nonnegative().optional(),
  /** Repetições únicas gastas. Serve para provar que nunca houve uma segunda. */
  retries: z.number().int().nonnegative().optional(),
  /** Soma das durações medidas; a média sai daqui dividida por `calls`, sem acumular erro de arredondamento. */
  total_latency_ms: z.number().nonnegative().optional(),
  last_call_at: timestamp.nullable().optional(),
  /** A CLASSE do erro, nunca a mensagem do provedor: ela costuma trazer host, banner ou pedaço do segredo. */
  last_failure: z.string().max(200).nullable().optional(),
  /** Custo MEDIDO, somando apenas chamadas com preço conhecido. Nunca somou 0 por não saber o preço. */
  cost_usd: z.number().nonnegative().optional(),
  /** Chamadas cujo preço ninguém informou. É isto que faz o custo ser `PARTIAL`/`UNKNOWN` em vez de `0`. */
  unpriced_calls: z.number().int().nonnegative().optional(),
}).strict()
export type StudioIntegration = z.infer<typeof studioIntegrationSchema>

export const studioExportSchema = z.object({
  export_id: z.string().min(1), ...scope,
  project_id: z.string().min(1), run_id: z.string().min(1),
  file_name: z.string().min(1), path: z.string().min(1), sha256, size_bytes: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  created_by: z.string().min(1), created_at: timestamp,
}).strict()
export type StudioExport = z.infer<typeof studioExportSchema>

export const hubEventSchema = z.object({
  event_id: z.string().min(1), ...scope,
  actor_user_id: z.string().min(1),
  // `integration.called` é a auditoria de CADA chamada de integração (X-08), com
  // os três desfechos que já existem aqui: `success`, `failure` (erro, estouro de
  // tempo) e `not-executed` (recusada antes de sair — desligada, sem assinatura,
  // teto de chamadas). Um valor novo no enum não é um campo novo em registro
  // persistido: linha antiga continua válida, e a versão do domínio não sobe.
  action: z.enum(['smtp.configured', 'smtp.tested', 'integration.registered', 'integration.enabled', 'integration.disabled', 'export.created', 'approval.recorded', 'approval.requested', 'export.downloadRefused', 'integration.called', 'integration.removed', 'integration.tested']),
  subject_id: z.string().min(1),
  outcome: z.enum(['success', 'failure', 'not-executed']),
  detail: z.string().max(500),
  created_at: timestamp,
}).strict()
export type HubEvent = z.infer<typeof hubEventSchema>

const brand = Symbol('hub-key')
export type HubKey = string & { readonly [brand]: true }

export const studioIntegrationsDomainSpec = defineDomain({
  name: 'studio_integrations', version: 1,
  tables: {
    integrations: domainTable<HubKey, StudioIntegration>(studioIntegrationSchema),
    exports: domainTable<HubKey, StudioExport>(studioExportSchema),
    events: domainTable<HubKey, HubEvent>(hubEventSchema),
  },
})

/**
 * O desligamento por ESCOPO — o requisito X-07.
 *
 * O botão por integração já existia, e o botão de emergência já parava a
 * organização inteira junto com o inquilino. O que faltava entre os dois era o
 * meio-termo que uma pessoa real pede: "desliga tudo NESTE projeto" e "desliga
 * tudo NESTA organização", sem parar o Studio inteiro.
 *
 * Estes três alcances são hierárquicos e conferidos JUNTOS: desligar a
 * organização desliga também os projetos dela, e religar um projeto NÃO religa
 * a organização. Um desligamento que pudesse ser contornado por um nível mais
 * fino não seria um desligamento.
 *
 * Domínio novo, e não uma tabela a mais em `studio_integrations`: acrescentar
 * tabela muda o descritor da unidade e faria `open()` recusar toda instalação
 * que já rodou.
 */
export const integrationKillSwitchSchema = z.object({
  /** `org` ou `org:tenant:project`. É a chave da tabela e o alcance inteiro. */
  switch_id: z.string().min(1),
  level: z.enum(['organization', 'project']),
  org_id: z.string().min(1),
  /** Ausente no nível da organização: ela é do inquilino todo, por definição. */
  tenant_id: z.string().min(1).nullable(),
  project_id: z.string().min(1).nullable(),
  /** `true` = integrações DESLIGADAS neste alcance. */
  disabled: z.boolean(),
  disabled_by: z.string().nullable(),
  disabled_at: z.iso.datetime().nullable(),
  reason: z.string().min(1).max(500).nullable(),
  enabled_by: z.string().nullable(),
  enabled_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
}).strict()

export type IntegrationKillSwitch = z.infer<typeof integrationKillSwitchSchema>

declare const killSwitchKeyBrand: unique symbol
export type KillSwitchKey = string & { readonly [killSwitchKeyBrand]: true }

export const STUDIO_INTEGRATION_SWITCHES_PHYSICAL_DOMAIN = 'studio_integration_switches'
export const STUDIO_INTEGRATION_SWITCHES_LOGICAL_DOMAIN = 'studio.integration.switches'

export const studioIntegrationSwitchesDomainSpec = defineDomain({
  name: STUDIO_INTEGRATION_SWITCHES_PHYSICAL_DOMAIN,
  // Nasce em 1 e fica em 1, como todo domínio deste repositório: `open()` falha
  // com `version-mismatch` numa instalação que já rodou, e não há passo de
  // migração nesta API. Campo novo entra OPCIONAL.
  version: 1,
  tables: { switches: domainTable<KillSwitchKey, IntegrationKillSwitch>(integrationKillSwitchSchema) },
})

/**
 * A chave de um alcance. Uma função só, porque duas grafias dela seriam dois
 * botões diferentes para o mesmo desligamento.
 * @param scope - o alcance pedido.
 * @returns a chave.
 */
export function killSwitchId(scope:
  | { readonly level: 'organization', readonly orgId: string }
  | { readonly level: 'project', readonly orgId: string, readonly tenantId: string, readonly projectId: string },
): string {
  return scope.level === 'organization' ? `org:${scope.orgId}` : `project:${scope.orgId}:${scope.tenantId}:${scope.projectId}`
}

/**
 * Os alcances que valem para uma chamada, do mais amplo ao mais fino.
 *
 * Todos são conferidos: um desligamento que pudesse ser contornado por um nível
 * mais fino não seria um desligamento.
 * @param scope - a organização, o inquilino e o projeto da chamada.
 * @returns as chaves a conferir.
 */
export function killSwitchIdsFor(scope: {
  readonly orgId: string
  readonly tenantId: string
  readonly projectId?: string
}): readonly string[] {
  const ids = [killSwitchId({ level: 'organization', orgId: scope.orgId })]
  if (scope.projectId !== undefined) {
    ids.push(killSwitchId({ level: 'project', orgId: scope.orgId, tenantId: scope.tenantId, projectId: scope.projectId }))
  }
  return ids
}
