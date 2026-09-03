import { describe, expect, it, vi } from 'vitest'
import { appSpecHash, appSpecV1Schema, AppSpecClarificationRequired, detectSensitiveData, parseAppSpecWithSingleRepair, sensitiveDataQuestion } from '../src/appspec.js'
import { PROMPT_TO_APP_DOMAIN_SPECS, projectStateSchema } from '../src/model.js'
import { assertProjectTransition, InvalidTransitionError, PROJECT_TRANSITIONS } from '../src/state.js'

const validSpec = {
  schema_version: 1 as const,
  problem: 'Apresentar o trabalho de uma fotógrafa para novos clientes.',
  audience: 'Pessoas procurando fotografia profissional',
  journeys: ['Conhecer o trabalho', 'Encontrar formas de contato'],
  pages: [{ name: 'Início', sections: ['Apresentação', 'Portfólio', 'Contato'] }],
  entities: [{ name: 'Projeto', kind: 'static-content' as const, fields: ['título', 'imagem'] }],
  sensitive_data: { detected: [] as const, confirmed_by_user: false },
  accessibility: { wcag_level: 'AA' as const, keyboard_required: true as const, reduced_motion: true as const },
  language: 'pt-BR' as const,
  acceptance_criteria: ['A página explica o serviço e mostra um contato.'],
}

describe('Prompt-to-App domains, state and AppSpec', () => {
  it('declares the seven physical domains with tenant fields in every record', () => {
    expect(PROMPT_TO_APP_DOMAIN_SPECS.map(spec => spec.name)).toEqual([
      'studio_projects', 'studio_app_specs', 'studio_intake_turns', 'studio_plans',
      'studio_runs', 'studio_evidence', 'studio_approvals',
    ])
    const records = [
      { ...validSpec },
      { project_id: 'p', org_id: 'o', tenant_id: 't' },
    ]
    expect(records[1]).toMatchObject({ org_id: 'o', tenant_id: 't' })
  })

  it('covers every valid transition and rejects every other state pair', () => {
    expect(projectStateSchema.options).toEqual([
      'DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'GENERATING',
      'BUILD_OK', 'BUILD_FAILED', 'TESTS_OK', 'TESTS_FAILED', 'CANCELLED', 'VERIFIED_PROTOTYPE',
    ])
    expect(projectStateSchema.options).not.toEqual(expect.arrayContaining(['READY', 'DONE', 'PUBLISHED', 'DEPLOYED']))
    for (const from of projectStateSchema.options) {
      for (const to of projectStateSchema.options) {
        if (PROJECT_TRANSITIONS[from].includes(to)) expect(() => assertProjectTransition(from, to)).not.toThrow()
        else expect(() => assertProjectTransition(from, to)).toThrow(InvalidTransitionError)
      }
    }
  })

  it('detects sensitive data and requires the confirmation question', () => {
    expect(detectSensitiveData('Cadastro com CPF, prontuário de criança e conta bancária')).toEqual(['cpf', 'health', 'financial', 'minors'])
    expect(sensitiveDataQuestion(['cpf', 'health'])).toContain('cpf, health')
    expect(sensitiveDataQuestion([])).toBeUndefined()
    expect(() => appSpecV1Schema.parse({ ...validSpec, sensitive_data: { detected: ['cpf'], confirmed_by_user: false } })).toThrow()
  })

  it('accepts a valid spec without repair and hashes deterministically', async () => {
    const repair = vi.fn()
    const result = await parseAppSpecWithSingleRepair(JSON.stringify(validSpec), repair)
    expect(result).toEqual(validSpec)
    expect(repair).not.toHaveBeenCalled()
    expect(appSpecHash(result)).toMatch(/^[a-f0-9]{64}$/u)
    expect(appSpecHash(result)).toBe(appSpecHash(result))
  })

  it('repairs exactly once and asks for clarification when repair remains invalid', async () => {
    const repair = vi.fn().mockResolvedValue(validSpec)
    await expect(parseAppSpecWithSingleRepair('{', repair)).resolves.toEqual(validSpec)
    expect(repair).toHaveBeenCalledTimes(1)
    await expect(parseAppSpecWithSingleRepair({}, async () => ({}))).rejects.toBeInstanceOf(AppSpecClarificationRequired)
  })
})
