import { z } from 'zod'

const identifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
const timestampSchema = z.iso.datetime()
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

export const APPROVAL_TIERS = ['T2', 'T3'] as const
export const approvalTierSchema = z.enum(APPROVAL_TIERS)
export type ApprovalTier = z.infer<typeof approvalTierSchema>

/**
 * `PENDING`  — o servidor emitiu o pedido; ninguém confirmou nada ainda.
 * `AVAILABLE`— a pessoa confirmou; a confirmação existe e ainda não foi usada.
 * `CONSUMED` — foi usada exatamente uma vez, por uma reivindicação exata.
 * `DENIED`   — a pessoa recusou. Terminal, e recusa não se desfaz.
 * `EXPIRED`  — o prazo acabou antes do uso. Terminal.
 */
export const approvalStateSchema = z.enum(['PENDING', 'AVAILABLE', 'CONSUMED', 'DENIED', 'EXPIRED'])
export type ApprovalState = z.infer<typeof approvalStateSchema>

/**
 * Frase que a PESSOA lê antes de decidir, derivada no servidor. Sem ela o
 * pedido só carrega o nome da categoria da ação, e confirmar vira um carimbo:
 * duas operações sensíveis diferentes ficam indistinguíveis na tela.
 *
 * Limitada e sem caracteres de controle porque parte do conteúdo tem origem no
 * modelo. Ela entra na impressão digital, então o texto exibido é exatamente o
 * texto que a confirmação tranca.
 */
export const APPROVAL_SUMMARY_MAX = 300
export const approvalSummarySchema = z.string().min(1).max(APPROVAL_SUMMARY_MAX)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'summary must not carry control characters')

/**
 * O descritor é derivado NO SERVIDOR por um serviço interno confiável. O cliente
 * nunca envia nível, ação, sujeito, resumo, fingerprint nem `approved: true`.
 */
export const approvalDescriptorSchema = z.object({
  org_id: identifierSchema,
  tenant_id: identifierSchema,
  user_id: identifierSchema,
  session_id: identifierSchema,
  action: identifierSchema,
  subject_id: identifierSchema,
  fingerprint: sha256Schema,
  tier: approvalTierSchema,
  request_id: identifierSchema,
  summary: approvalSummarySchema,
}).strict()
export type ApprovalDescriptor = z.infer<typeof approvalDescriptorSchema>

export const approvalRecordSchema = approvalDescriptorSchema.extend({
  approval_id: z.string().regex(/^apv-[a-f0-9]{64}$/u),
  state: approvalStateSchema,
  /** Quem consumiu. Preenchido apenas no consumo, e só uma vez. */
  claim_id: identifierSchema.nullable(),
  created_at: timestampSchema,
  expires_at: timestampSchema,
  confirmed_at: timestampSchema.nullable(),
  consumed_at: timestampSchema.nullable(),
  denied_at: timestampSchema.nullable(),
}).strict()
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>

export const approvalReceiptSchema = z.object({
  approval_id: z.string().regex(/^apv-[a-f0-9]{64}$/u),
  action: identifierSchema,
  subject_id: identifierSchema,
  fingerprint: sha256Schema,
  tier: approvalTierSchema,
  claim_id: identifierSchema,
  user_id: identifierSchema,
  session_id: identifierSchema,
  org_id: identifierSchema,
  tenant_id: identifierSchema,
  approved_at: timestampSchema,
}).strict()
export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>

export const STUDIO_ACTION_APPROVALS_PHYSICAL_DOMAIN = 'studio_action_approvals'
export const STUDIO_ACTION_APPROVALS_LOGICAL_DOMAIN = 'studio.action.approvals'

export class ApprovalModelError extends Error {}

/**
 * Um registro inválido é recusado na leitura e na escrita. Estado terminal com
 * carimbo de tempo faltando, ou carimbo sem o estado correspondente, é
 * corrupção - e corrupção não pode virar uma aprovação silenciosa.
 */
export function assertValidApproval(record: ApprovalRecord): void {
  const parsed = approvalRecordSchema.safeParse(record)
  if (!parsed.success) throw new ApprovalModelError('approval record does not match its schema')
  const invalid = (reason: string): never => { throw new ApprovalModelError(reason) }

  if (Date.parse(record.expires_at) <= Date.parse(record.created_at)) invalid('expiry must follow creation')
  const confirmed = record.confirmed_at !== null
  const consumed = record.consumed_at !== null
  const denied = record.denied_at !== null
  const claimed = record.claim_id !== null

  if (consumed !== claimed) invalid('consumption and claim identity must be paired')
  if (confirmed && Date.parse(record.confirmed_at!) < Date.parse(record.created_at)) invalid('confirmation precedes creation')
  if (consumed && !confirmed) invalid('a consumed approval must have been confirmed first')
  if (consumed && Date.parse(record.consumed_at!) < Date.parse(record.confirmed_at!)) invalid('consumption precedes confirmation')
  if (denied && consumed) invalid('a denial and a consumption cannot coexist')

  switch (record.state) {
    case 'PENDING':
      if (confirmed || consumed || denied) invalid('pending must not carry any resolution')
      return
    case 'AVAILABLE':
      if (!confirmed || consumed || denied) invalid('available requires confirmation and no outcome')
      return
    case 'CONSUMED':
      if (!confirmed || !consumed || denied) invalid('consumed requires confirmation and consumption only')
      return
    case 'DENIED':
      if (!denied || consumed) invalid('denied requires a denial and no consumption')
      return
    default:
      if (consumed || denied) invalid('expired must not claim consumption or denial')
  }
}
