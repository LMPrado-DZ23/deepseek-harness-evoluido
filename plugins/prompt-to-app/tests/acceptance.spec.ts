import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceChecks, writeAcceptanceArtifacts } from '../src/acceptance.js'
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

  it('compiles fill, save and list evidence for a database form', async () => {
    const databaseSpec = { ...spec, entities: [{ name: 'Contato', kind: 'database' as const, sensitive: false, fields: [
      { name: 'Nome', type: 'text' as const, required: true },
      { name: 'E-mail', type: 'email' as const, required: false },
    ] }] }
    const checks = acceptanceChecks(databaseSpec, 'form-database')
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'flow', flow: expect.objectContaining({ form_test_id: 'contato-form', list_test_id: 'contato-list', marker_field: 'nome' }) }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-flow-')); roots.push(root)
    await writeAcceptanceArtifacts(root, databaseSpec, 'form-database')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).toContain('getByTestId("contato-form")')
    expect(generated).toContain('getByTestId("contato-list")')
    expect(generated).toContain("getByRole('button',{name:'Salvar'})")
  })

  it('compiles login and create, edit, delete evidence for a CRUD panel', async () => {
    const databaseSpec = { ...spec, entities: [{ name: 'Cliente', kind: 'database' as const, sensitive: false, fields: [
      { name: 'Nome', type: 'text' as const, required: true },
      { name: 'Ativo', type: 'boolean' as const, required: true },
    ] }] }
    const checks = acceptanceChecks(databaseSpec, 'crud-panel')
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'auth' }))
    expect(checks).toContainEqual(expect.objectContaining({ kind: 'crud', flow: expect.objectContaining({ form_test_id: 'cliente-create-form', requires_auth: true }) }))
    const root = await mkdtemp(join(tmpdir(), 'dz23-acceptance-crud-')); roots.push(root)
    await writeAcceptanceArtifacts(root, databaseSpec, 'crud-panel')
    const generated = await readFile(resolve(root, 'tests/e2e/appspec.spec.ts'), 'utf8')
    expect(generated).toContain("fetch('/api/auth/session')")
    expect(generated).toContain("name:'Salvar alterações'")
    expect(generated).toContain("name:'Excluir'")
  })
})
