import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { policyTierSchema } from '@dz23-studio/policy'
import { z } from 'zod'
import { appSpecV1Schema } from './appspec.js'

export const projectStateSchema = z.enum([
  'DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'GENERATING',
  'BUILD_OK', 'BUILD_FAILED', 'TESTS_OK', 'TESTS_FAILED', 'VERIFIED_PROTOTYPE',
])
export type ProjectState = z.infer<typeof projectStateSchema>

const scope = {
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
}
const timestamp = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const studioProjectSchema = z.object({
  project_id: z.string().min(1), ...scope,
  name: z.string().min(1).max(120),
  state: projectStateSchema,
  original_brief: z.string().min(1).max(10_000),
  category: z.enum(['landing-page', 'catalog']),
  created_by: z.string().min(1),
  privacy: z.enum(['local-only', 'any']),
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: timestamp.nullable(),
}).strict()

export const studioAppSpecRecordSchema = z.object({
  spec_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  version: z.number().int().positive(), app_spec: appSpecV1Schema,
  sha256, origin: z.enum(['intake', 'edit']), created_at: timestamp,
}).strict()

export const studioIntakeTurnSchema = z.object({
  turn_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  question_id: z.enum(['audience', 'goal', 'content', 'sensitive-confirmation']),
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
  created_at: timestamp, updated_at: timestamp,
}).strict()

export const studioRunSchema = z.object({
  run_id: z.string().min(1), plan_id: z.string().min(1), project_id: z.string().min(1), ...scope,
  stage: z.enum(['generate', 'build', 'test', 'verify']), attempt: z.number().int().min(1).max(3),
  state: z.enum(['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED']),
  started_at: timestamp, finished_at: timestamp.nullable(),
  sandbox: z.enum(['full', 'unavailable']), route: z.string().nullable(), model: z.string().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(), output_tokens: z.number().int().nonnegative().nullable(),
  estimated_cost_usd: z.number().nonnegative().nullable(), run_directory: z.string().min(1),
  failure_code: z.string().nullable(),
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

export type StudioProject = z.infer<typeof studioProjectSchema>
export type StudioAppSpecRecord = z.infer<typeof studioAppSpecRecordSchema>
export type StudioIntakeTurn = z.infer<typeof studioIntakeTurnSchema>
export type StudioPlan = z.infer<typeof studioPlanSchema>
export type StudioRun = z.infer<typeof studioRunSchema>
export type StudioEvidence = z.infer<typeof studioEvidenceSchema>
export type StudioApproval = z.infer<typeof studioApprovalSchema>
declare const promptKeyBrand: unique symbol
export type PromptToAppKey = string & { readonly [promptKeyBrand]: true }

export const studioProjectsDomainSpec = defineDomain({ name: 'studio_projects', version: 1, tables: { projects: domainTable<PromptToAppKey, StudioProject>(studioProjectSchema) } })
export const studioAppSpecsDomainSpec = defineDomain({ name: 'studio_app_specs', version: 1, tables: { specs: domainTable<PromptToAppKey, StudioAppSpecRecord>(studioAppSpecRecordSchema) } })
export const studioIntakeTurnsDomainSpec = defineDomain({ name: 'studio_intake_turns', version: 1, tables: { turns: domainTable<PromptToAppKey, StudioIntakeTurn>(studioIntakeTurnSchema) } })
export const studioPlansDomainSpec = defineDomain({ name: 'studio_plans', version: 1, tables: { plans: domainTable<PromptToAppKey, StudioPlan>(studioPlanSchema) } })
export const studioRunsDomainSpec = defineDomain({ name: 'studio_runs', version: 1, tables: { runs: domainTable<PromptToAppKey, StudioRun>(studioRunSchema) } })
export const studioEvidenceDomainSpec = defineDomain({ name: 'studio_evidence', version: 1, tables: { evidence: domainTable<PromptToAppKey, StudioEvidence>(studioEvidenceSchema) } })
export const studioApprovalsDomainSpec = defineDomain({ name: 'studio_approvals', version: 1, tables: { approvals: domainTable<PromptToAppKey, StudioApproval>(studioApprovalSchema) } })

export const PROMPT_TO_APP_DOMAIN_SPECS = [
  studioProjectsDomainSpec, studioAppSpecsDomainSpec, studioIntakeTurnsDomainSpec,
  studioPlansDomainSpec, studioRunsDomainSpec, studioEvidenceDomainSpec, studioApprovalsDomainSpec,
] as const
