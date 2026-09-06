import type { ToolPolicyRule } from '@dz23-studio/policy'
import { t } from './i18n.js'

export const ASSISTANT_TOOL_NAMES = [
  'studio_agent_start',
  'studio_agent_start_sensitive',
  'studio_agent_list',
  'studio_agent_review',
  'studio_agent_cancel',
  'studio_agent_apply',
  'studio_team_start',
  'studio_team_start_sensitive',
  'studio_team_list',
  'studio_team_status',
  'studio_team_continue',
  'studio_team_continue_sensitive',
  'studio_team_cancel',
] as const

export type AssistantToolName = typeof ASSISTANT_TOOL_NAMES[number]

/**
 * P36 deliberately exposes only the provider whose filesystem boundary is
 * exercised in-process. External CLI providers remain available to the
 * Phase 3 runtime, but are not configurable through this bridge until their
 * Windows and Linux symlink/junction confinement E2E gates pass.
 */
export const ASSISTANT_ALLOWED_PROVIDERS = ['spawn-in-process'] as const
export type AssistantProvider = typeof ASSISTANT_ALLOWED_PROVIDERS[number]

const studioRule = (
  inferredTier: 'T0' | 'T2' | 'T3',
  requiredPermission: 'project.read' | 'project.write',
  sandboxMode: 'read-only' | 'workspace-write',
): ToolPolicyRule => ({
  source: { kind: 'studio', external: false, stableChannel: true },
  inferredTier,
  sandboxMode,
  requiredPermission,
  scope: 'project',
})

/** Authoritative, closed catalog for the tools mounted by dz23-assistant. */
export const ASSISTANT_TOOL_POLICY = {
  studio_agent_start: studioRule('T2', 'project.write', 'workspace-write'),
  studio_agent_start_sensitive: studioRule('T3', 'project.write', 'workspace-write'),
  studio_agent_list: studioRule('T0', 'project.read', 'read-only'),
  studio_agent_review: studioRule('T0', 'project.read', 'read-only'),
  studio_agent_cancel: studioRule('T2', 'project.write', 'workspace-write'),
  studio_agent_apply: studioRule('T2', 'project.write', 'workspace-write'),
  studio_team_start: studioRule('T2', 'project.write', 'workspace-write'),
  studio_team_start_sensitive: studioRule('T3', 'project.write', 'workspace-write'),
  studio_team_list: studioRule('T0', 'project.read', 'read-only'),
  studio_team_status: studioRule('T0', 'project.read', 'read-only'),
  studio_team_continue: studioRule('T2', 'project.write', 'workspace-write'),
  studio_team_continue_sensitive: studioRule('T3', 'project.write', 'workspace-write'),
  studio_team_cancel: studioRule('T2', 'project.write', 'workspace-write'),
} satisfies Record<AssistantToolName, ToolPolicyRule>

export function assertAssistantToolCatalog(exposedTools: readonly string[], classifiedTools: readonly string[]): void {
  const expected = [...ASSISTANT_TOOL_NAMES].sort()
  const exposed = [...new Set(exposedTools)].sort()
  const classified = [...new Set(classifiedTools.filter(name => expected.includes(name as AssistantToolName)))].sort()
  if (JSON.stringify(exposed) !== JSON.stringify(expected)) {
    throw new Error(t('catalog.presetMismatch', { expected: expected.join(','), actual: exposed.join(',') }))
  }
  if (JSON.stringify(classified) !== JSON.stringify(expected)) {
    throw new Error(t('catalog.policyMismatch', { expected: expected.join(','), actual: classified.join(',') }))
  }
}
