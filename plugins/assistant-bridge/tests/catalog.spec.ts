import { describe, expect, it } from 'vitest'
import { StudioPolicyEngine } from '@dz23-studio/policy'
import { ASSISTANT_ALLOWED_PROVIDERS, ASSISTANT_TOOL_NAMES, ASSISTANT_TOOL_POLICY, assertAssistantToolCatalog } from '../src/catalog.ts'
import { t } from '../src/i18n.ts'

describe('dz23-assistant tool catalog', () => {
  it('classifies every exposed tool and keeps T2 and T3 starts static', () => {
    expect(ASSISTANT_ALLOWED_PROVIDERS).toEqual(['spawn-in-process'])
    expect(Object.keys(ASSISTANT_TOOL_POLICY).sort()).toEqual([...ASSISTANT_TOOL_NAMES].sort())
    expect(ASSISTANT_TOOL_POLICY.studio_agent_start.inferredTier).toBe('T2')
    expect(ASSISTANT_TOOL_POLICY.studio_agent_start_sensitive.inferredTier).toBe('T3')
    const engine = new StudioPolicyEngine({ requireAuthorizationDeclarations: true, rules: ASSISTANT_TOOL_POLICY })
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(engine.evaluate(name, {
        strongIdentityVerified: true,
        authorization: { userId: 'u', orgId: 'o', tenantId: 't', role: 'builder' },
      }).kind).not.toBe('deny')
    }
    expect(engine.evaluate('unknown_assistant_tool', {
      strongIdentityVerified: true,
      authorization: { userId: 'u', orgId: 'o', tenantId: 't', role: 'owner' },
    }).kind).toBe('deny')
  })

  it('fails closed when an exposed or classified name is missing', () => {
    expect(() => assertAssistantToolCatalog(ASSISTANT_TOOL_NAMES.slice(1), ASSISTANT_TOOL_NAMES)).toThrow(/expõe ferramentas diferentes/)
    expect(() => assertAssistantToolCatalog(ASSISTANT_TOOL_NAMES, ASSISTANT_TOOL_NAMES.slice(0, -1))).toThrow(/política está incompleta/i)
  })

  it('renders catalog parameters and fails closed for absent keys', () => {
    expect(t('errors.pathCount', { max: 7 })).toContain('7')
    expect(t('errors.pathCount')).toContain('{max}')
    expect(() => t('errors.not-present')).toThrow('I18N_KEY_MISSING')
  })
})
