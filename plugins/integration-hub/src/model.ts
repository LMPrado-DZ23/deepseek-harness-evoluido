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
 * Integration manifest v1 (D16). `signature` is an Ed25519 signature (base64)
 * over the canonical JSON of the manifest without the `signature` field.
 */
export const integrationManifestSchema = z.object({
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
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>

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
  action: z.enum(['smtp.configured', 'smtp.tested', 'integration.registered', 'integration.enabled', 'integration.disabled', 'export.created', 'approval.recorded', 'approval.requested', 'export.downloadRefused', 'integration.called']),
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
