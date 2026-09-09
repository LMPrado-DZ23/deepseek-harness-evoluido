import { describe, expect, it, vi } from 'vitest'
import { appSpecHash, appSpecV1Schema, AppSpecClarificationRequired, detectSensitiveData, parseAppSpecWithSingleRepair, sensitiveDataQuestion } from '../src/appspec.js'
import { PROMPT_TO_APP_DOMAIN_SPECS, projectStateSchema } from '../src/model.js'
import { assertProjectTransition, canStartGeneration, InvalidTransitionError, PROJECT_TRANSITIONS } from '../src/state.js'

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
  it('declares the eight physical domains with tenant fields in every record', () => {
    expect(PROMPT_TO_APP_DOMAIN_SPECS.map(spec => spec.name)).toEqual([
      'studio_projects', 'studio_app_specs', 'studio_design_specs', 'studio_intake_turns', 'studio_plans',
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
      'BUILD_OK', 'BUILD_FAILED', 'TESTS_OK', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED', 'VERIFIED_PROTOTYPE',
    ])
    expect(projectStateSchema.options).not.toEqual(expect.arrayContaining(['READY', 'DONE', 'PUBLISHED', 'DEPLOYED']))
    for (const from of projectStateSchema.options) {
      for (const to of projectStateSchema.options) {
        if (PROJECT_TRANSITIONS[from].includes(to)) expect(() => assertProjectTransition(from, to)).not.toThrow()
        else expect(() => assertProjectTransition(from, to)).toThrow(InvalidTransitionError)
      }
    }
    expect(projectStateSchema.options.filter(canStartGeneration)).toEqual(['PLAN_APPROVED', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED'])
  })

  it('detects sensitive data and requires the confirmation question', () => {
    expect(detectSensitiveData('Cadastro com CPF, prontuário de criança e conta bancária')).toEqual(['cpf', 'health', 'financial', 'minors'])
    // O enum CRU aparecia na primeira pergunta do produto: "dados sensíveis
    // (health)". Agora cada tipo tem nome em português, e a lista é escrita
    // como se escreve para gente.
    expect(sensitiveDataQuestion(['cpf', 'health'])).toContain('CPF e informações de saúde')
    expect(sensitiveDataQuestion(['cpf', 'health'])).not.toMatch(/\bhealth\b|\bfinancial\b|\bminors\b/u)
    expect(sensitiveDataQuestion(['cpf', 'health', 'minors'])).toContain('CPF, informações de saúde e dados de crianças ou adolescentes')
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

  it('validates database field contracts and sensitive entity confirmation', () => {
    const databaseSpec = {
      ...validSpec,
      entities: [
        {
          name: 'Cliente', kind: 'database' as const, sensitive: false,
          fields: [
            { name: 'nome', type: 'text' as const, required: true },
            { name: 'situação', type: 'selection' as const, required: true, options: ['ativo', 'inativo'] },
            { name: 'empresa', type: 'reference' as const, required: false, reference_entity: 'Empresa' },
          ],
        },
        { name: 'Empresa', kind: 'database' as const, sensitive: false, fields: [{ name: 'nome', type: 'text' as const, required: true }] },
      ],
    }
    expect(appSpecV1Schema.parse(databaseSpec).entities[0]).toMatchObject({ kind: 'database', sensitive: false })
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ ...databaseSpec.entities[0], fields: [{ name: 'x', type: 'selection', required: true }] }] })).toThrow()
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ ...databaseSpec.entities[0], fields: [{ name: 'x', type: 'text', required: true, options: ['não permitido'] }] }] })).toThrow()
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ ...databaseSpec.entities[0], fields: [{ name: 'x', type: 'reference', required: true }] }] })).toThrow()
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ ...databaseSpec.entities[0], fields: [{ name: 'x', type: 'text', required: true, reference_entity: 'Cliente' }] }] })).toThrow()
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ ...databaseSpec.entities[0], fields: [{ name: 'x', type: 'reference', required: true, reference_entity: 'Ausente' }] }] })).toThrow()
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ ...databaseSpec.entities[0], sensitive: true }] })).toThrow()
    expect(() => appSpecV1Schema.parse({ ...databaseSpec, entities: [{ name: 'Única', kind: 'database', sensitive: false, fields: [{ name: 'ela', type: 'reference', required: false, reference_entity: 'Única' }] }] })).toThrow()
  })

  it('repairs exactly once and asks for clarification when repair remains invalid', async () => {
    const repair = vi.fn().mockResolvedValue(validSpec)
    await expect(parseAppSpecWithSingleRepair('{', repair)).resolves.toEqual(validSpec)
    expect(repair).toHaveBeenCalledTimes(1)
    await expect(parseAppSpecWithSingleRepair({}, async () => ({}))).rejects.toBeInstanceOf(AppSpecClarificationRequired)
  })
})
