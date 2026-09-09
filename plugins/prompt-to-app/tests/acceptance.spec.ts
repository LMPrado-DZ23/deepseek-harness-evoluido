import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceChecks, parseAcceptanceReport, writeAcceptanceArtifacts } from '../src/acceptance.js'
import type { AppSpecV1 } from '../src/appspec.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const spec: AppSpecV1 = {
  schema_version: 1, problem: 'Apresentar serviços para clientes.', audience: 'Clientes', journeys: ['Conhecer serviços'],
  pages: [{ name: 'Início', sections: ['Serviços', 'Contato'] }],
  entities: [{ name: 'Serviço', kind: 'static-content', fields: ['Nome'] }],
  sensitive_data: { detected: [], confirmed_by_user: false }, accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR', acceptance_criteria: ['Mostrar o texto “Fale conosco”.', 'A navegação deve ser simples.'],
}

describe('AppSpec acceptance compiler', () => {
  it('turns structural and literal requirements into tests and labels non-automatable criteria honestly', async () => {
    const checks = acceptanceChecks(spec)
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'page', expected: 'Início', status: 'PENDING' }))
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'section', expected: 'Contato', status: 'PENDING' }))
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'criterion', expected: 'Fale conosco', status: 'PENDING' }))
    expect(checks).toContainEqual(expect.objectContaining({ label: 'A navegação deve ser simples.', status: 'NOT_AUTOMATED' }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-')); roots.push(root)
    await writeAcceptanceArtifacts(root, spec)
    expect(await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')).toContain("getByText(\"Fale conosco\"")
    expect(JSON.parse(await readFile(resolve(root, 'evidence/appspec-report.json'), 'utf8')).checks).toHaveLength(checks.length)
  })

  it('accepts only the exact report contract and immutable check inventory', () => {
    const checks = acceptanceChecks(spec)
    const valid = { schema_version: 1, checks: checks.map(check => ({ ...check, status: check.status === 'PENDING' ? 'PASSED' : check.status })) }
    expect(parseAcceptanceReport(valid, checks)).toHaveLength(checks.length)
    expect(() => parseAcceptanceReport({ checks: valid.checks }, checks)).toThrow()
    expect(() => parseAcceptanceReport({ schema_version: 1, checks: [] }, checks)).toThrow()
    expect(() => parseAcceptanceReport({ ...valid, checks: valid.checks.slice(1) }, checks)).toThrow('APPSPEC_REPORT_MISMATCH')
    expect(() => parseAcceptanceReport({ ...valid, checks: valid.checks.map((check, index) => index === 0 ? { ...check, label: 'alterado' } : check) }, checks)).toThrow('APPSPEC_REPORT_MISMATCH')
    expect(() => parseAcceptanceReport({ ...valid, checks: valid.checks.map((check, index) => index === 0 ? { ...check, status: 'NOT_AUTOMATED' } : check) }, checks)).toThrow('APPSPEC_REPORT_MISMATCH')
    expect(() => parseAcceptanceReport({ ...valid, checks: [valid.checks[0], valid.checks[0], ...valid.checks.slice(2)] }, checks)).toThrow('APPSPEC_REPORT_MISMATCH')
  })

  it('compiles fill, save and list evidence for a database form', async () => {
    const databaseSpec = { ...spec, entities: [{ name: 'Contato', kind: 'database' as const, sensitive: false, fields: [
      { name: 'Nome', type: 'text' as const, required: true },
      { name: 'E-mail', type: 'email' as const, required: false },
    ] }] }
    const checks = acceptanceChecks(databaseSpec, 'form-database')
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'flow', flow: expect.objectContaining({ form_test_id: 'contato-form', list_test_id: 'contato-list', marker_field: 'nome', submit_requires_auth: false, list_requires_auth: true }) }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-flow-')); roots.push(root)
    await writeAcceptanceArtifacts(root, databaseSpec, 'form-database')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).toContain('getByTestId("contato-form")')
    expect(generated).toContain('getByTestId("contato-list")')
    expect(generated).toContain('toHaveCount(0);await loginAsOwner(page)')
    expect(generated).toContain("getByRole('button',{name:\"Salvar\"})")
  })

  it('compiles login and create, edit, delete evidence for a CRUD panel', async () => {
    const databaseSpec = { ...spec, entities: [{ name: 'Cliente', kind: 'database' as const, sensitive: false, fields: [
      { name: 'Nome', type: 'text' as const, required: true },
      { name: 'Ativo', type: 'boolean' as const, required: true },
    ] }] }
    const checks = acceptanceChecks(databaseSpec, 'crud-panel')
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'auth' }))
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'crud', flow: expect.objectContaining({ form_test_id: 'cliente-create-form', submit_requires_auth: true, list_requires_auth: true }) }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-crud-')); roots.push(root)
    await writeAcceptanceArtifacts(root, databaseSpec, 'crud-panel')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).toContain("fetch('/api/auth/session')")
    expect(generated).toContain('name:"Salvar alterações"')
    expect(generated).toContain('name:"Excluir"')
  })

  it('does not emit a broken browser flow when a relation has no seeded target row', async () => {
    const relatedSpec: AppSpecV1 = { ...spec, entities: [
      { name: 'Cliente', kind: 'database', sensitive: false, fields: [{ name: 'Nome', type: 'text', required: true }] },
      { name: 'Pedido', kind: 'database', sensitive: false, fields: [
        { name: 'Descrição', type: 'text', required: true },
        { name: 'Cliente', type: 'reference', required: true, reference_entity: 'Cliente' },
      ] },
    ] }
    const checks = acceptanceChecks(relatedSpec, 'crud-panel')
    expect(checks).toContainEqual(expect.objectContaining({ label: 'crud:Pedido', status: 'NOT_AUTOMATED' }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-reference-')); roots.push(root)
    await writeAcceptanceArtifacts(root, relatedSpec, 'crud-panel')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).not.toContain('selectOption({index:1})')
  })

  it('seeds a known dashboard row and refuses a vacuous empty-dashboard pass', async () => {
    const dashboardSpec: AppSpecV1 = { ...spec, entities: [{
      name: 'Venda', kind: 'database', sensitive: false, fields: [
        { name: 'Categoria', type: 'selection', required: true, options: ['Produtos', 'Serviços'] },
        { name: 'Data', type: 'date', required: true },
        { name: 'Valor', type: 'number', required: true },
      ],
    }] }
    const checks = acceptanceChecks(dashboardSpec, 'dashboard')
    expect(checks).toContainEqual(expect.objectContaining({
      id: 'dashboard-read-only', kind: 'dashboard', expected: 'Venda',
      flow: expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ name: 'valor', type: 'number' })]) }),
    }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-dashboard-')); roots.push(root)
    await writeAcceptanceArtifacts(root, dashboardSpec, 'dashboard')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).toContain("new VendaRepository(database).create({\"categoria\":\"Produtos\",\"data\":\"2099-09-04\",\"valor\":42})")
    expect(generated).toContain('expect(await tables.count()).toBeGreaterThan(0)')
    expect(generated).toContain("getByText('1',{exact:true}).first()")
  })

  it('compiles every supported field kind without inventing product evidence', async () => {
    const cases: Array<{ type: 'text' | 'email' | 'phone' | 'number' | 'date' | 'boolean' | 'selection'; options?: string[]; expected: string }> = [
      { type: 'text', expected: 'DZ23-flow-0' },
      { type: 'email', expected: 'DZ23-flow-0@example.test' },
      { type: 'phone', expected: '11987654321' },
      { type: 'number', expected: '42' },
      { type: 'date', expected: '2026-09-03' },
      { type: 'boolean', expected: 'Sim' },
      { type: 'selection', options: ['Primeira'], expected: 'Primeira' },
    ]
    for (const field of cases) {
      const databaseSpec: AppSpecV1 = { ...spec, entities: [{
        name: `Registro ${field.type}`, kind: 'database', sensitive: false,
        fields: [{ name: 'Valor', type: field.type, required: true, ...(field.options === undefined ? {} : { options: field.options }) }],
      }] }
      const root = await mkdtemp(join(tmpdir(), `dz23-acceptance-${field.type}-`)); roots.push(root)
      await writeAcceptanceArtifacts(root, databaseSpec, 'form-database')
      const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
      expect(generated, field.type).toContain(field.expected)
    }
  })

  it('keeps specialized category checks explicit, including empty-domain fallbacks', async () => {
    const noDatabase: AppSpecV1 = { ...spec, entities: [] }
    expect(acceptanceChecks(noDatabase, 'dashboard').some(check => check.kind === 'dashboard')).toBe(false)
    expect(acceptanceChecks(noDatabase, 'saas-authenticated')).toContainEqual(expect.objectContaining({ kind: 'saas' }))
    expect(acceptanceChecks(noDatabase, 'scheduling')).toContainEqual(expect.objectContaining({ kind: 'scheduling', expected: '09:00' }))

    const scheduling: AppSpecV1 = { ...spec, entities: [{
      name: 'Agenda', kind: 'database', sensitive: false,
      fields: [{ name: 'Horário', type: 'selection', required: true, options: ['14:30'] }],
    }] }
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-specialized-')); roots.push(root)
    await writeAcceptanceArtifacts(root, scheduling, 'scheduling')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).toContain("slot:\"14:30\"")
    expect(generated).toContain("repository.transition(String(created.id),'confirmed'")
    expect(generated).toContain("repository.transition(String(created.id),'cancelled'")
  })
})

describe('C-H3: a lista de conferências é legível por quem não programa', () => {
  // A tela mostrava `page:Início`, `entity:Cliente`, `field:nome`,
  // `language=pt-BR` — com `:`, `=` e palavra em inglês — na única tela que
  // responde "meu aplicativo faz o que eu pedi?".
  it('toda conferência tem frase em português, e nenhuma frase é identificador', () => {
    const clinic: AppSpecV1 = {
      ...spec,
      pages: [{ name: 'Início', sections: ['Serviços'] }],
      entities: [{ kind: 'database', name: 'Cliente', fields: [{ name: 'nome', type: 'text', required: true }] }],
      acceptance_criteria: ['A navegação deve ser simples.'],
    } as AppSpecV1
    for (const category of ['landing-page', 'form-database', 'crud-panel', 'dashboard', 'saas-authenticated', 'scheduling'] as const) {
      for (const check of acceptanceChecks(clinic, category)) {
        expect(check.title, `${category}/${check.id}`).toBeDefined()
        // Nada de `page:`, `field:`, `language=` na frase que a pessoa lê.
        expect(check.title!, `${category}/${check.id}`).not.toMatch(/^(?:page|section|entity|field|crud|fluxo|flow|language|document)[:=]/u)
      }
    }
  })
})
