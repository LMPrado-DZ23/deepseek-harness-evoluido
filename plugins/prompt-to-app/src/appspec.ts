import { createHash } from 'node:crypto'
import { z } from 'zod'
import { t } from './i18n.js'

export const sensitiveDataKindSchema = z.enum(['cpf', 'health', 'financial', 'minors'])
export type SensitiveDataKind = z.infer<typeof sensitiveDataKindSchema>

export const appSpecV1Schema = z.object({
  schema_version: z.literal(1),
  problem: z.string().min(10).max(2_000),
  audience: z.string().min(2).max(500),
  journeys: z.array(z.string().min(3).max(300)).min(1).max(5),
  pages: z.array(z.object({
    name: z.string().min(1).max(80),
    sections: z.array(z.string().min(1).max(120)).min(1).max(12),
  }).strict()).min(1).max(12),
  entities: z.array(z.object({
    name: z.string().min(1).max(80),
    kind: z.literal('static-content'),
    fields: z.array(z.string().min(1).max(80)).max(20),
  }).strict()).max(12),
  sensitive_data: z.object({
    detected: z.array(sensitiveDataKindSchema),
    confirmed_by_user: z.boolean(),
  }).strict().superRefine((value, context) => {
    if (value.detected.length > 0 && !value.confirmed_by_user) {
      context.addIssue({ code: 'custom', message: t('errors.sensitiveSpec') })
    }
  }),
  accessibility: z.object({
    wcag_level: z.literal('AA'),
    keyboard_required: z.literal(true),
    reduced_motion: z.literal(true),
  }).strict(),
  language: z.literal('pt-BR'),
  acceptance_criteria: z.array(z.string().min(5).max(300)).min(1).max(30),
}).strict()

export type AppSpecV1 = z.infer<typeof appSpecV1Schema>

const SENSITIVE_PATTERNS: Readonly<Record<SensitiveDataKind, readonly RegExp[]>> = {
  cpf: [/\bcpf\b/iu, /cadastro\s+de\s+pessoa\s+f[ií]sica/iu],
  health: [/\bsa[uú]de\b/iu, /\bdiagn[oó]stic/iu, /\bprontu[aá]rio/iu, /\bpaciente/iu],
  financial: [/\bfinanceir/iu, /\bconta\s+banc[aá]ria/iu, /\bcart[aã]o\b/iu, /\brenda\b/iu],
  minors: [/\bmenor(?:es)?\b/iu, /\bcrian[cç]a/iu, /\badolescente/iu, /\baluno\b/iu],
}

export function detectSensitiveData(text: string): SensitiveDataKind[] {
  return sensitiveDataKindSchema.options.filter(kind => SENSITIVE_PATTERNS[kind].some(pattern => pattern.test(text)))
}

export function sensitiveDataQuestion(kinds: readonly SensitiveDataKind[]): string | undefined {
  if (kinds.length === 0) return undefined
  return t('questions.sensitive', { kinds: kinds.join(', ') })
}

export class AppSpecClarificationRequired extends Error {
  readonly code = 'APPSPEC_CLARIFICATION_REQUIRED'
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return JSON.parse(value)
}

export async function parseAppSpecWithSingleRepair(
  value: unknown,
  repair: (invalid: unknown, issues: readonly string[]) => Promise<unknown>,
): Promise<AppSpecV1> {
  const first = await safeParse(value)
  if (first.success) return first.data
  const repaired = await repair(value, first.issues)
  const second = await safeParse(repaired)
  if (second.success) return second.data
  throw new AppSpecClarificationRequired(t('errors.specClarification'))
}

async function safeParse(value: unknown): Promise<{ success: true; data: AppSpecV1 } | { success: false; issues: string[] }> {
  try {
    const result = appSpecV1Schema.safeParse(decode(value))
    return result.success
      ? { success: true, data: result.data }
      : { success: false, issues: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) }
  } catch (error) {
    return { success: false, issues: [error instanceof Error ? error.message : t('errors.invalidJson')] }
  }
}

export function appSpecHash(spec: AppSpecV1): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex')
}
