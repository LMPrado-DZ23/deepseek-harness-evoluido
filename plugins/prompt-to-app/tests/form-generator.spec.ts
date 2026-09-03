import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { generateFormLayer, writeFormLayer } from '../src/form-generator.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const formSpec: AppSpecV1 = {
  schema_version: 1, problem: 'Cadastrar contatos e consultar a lista.', audience: 'Equipe local',
  journeys: ['Cadastrar e consultar contatos'], pages: [{ name: 'Contatos', sections: ['Cadastro', 'Lista'] }],
  entities: [{ name: 'Contato', kind: 'database', sensitive: false, fields: [
    { name: 'Nome', type: 'text', required: true }, { name: 'E-mail', type: 'email', required: false },
    { name: 'Telefone', type: 'phone', required: false }, { name: 'Data', type: 'date', required: false },
    { name: 'Quantidade', type: 'number', required: false }, { name: 'Ativo', type: 'boolean', required: true },
    { name: 'Situação', type: 'selection', required: true, options: ['Novo', 'Atendido'] },
    { name: 'Indicação', type: 'reference', required: false, reference_entity: 'Contato' },
  ] }], sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A pessoa cadastra um contato e o encontra na lista.'],
}

describe('deterministic form and list layer', () => {
  it('generates protected server actions and an accessible manager over repositories', () => {
    const layer = generateFormLayer(formSpec, 'form-database')
    expect(layer.files.map(file => file.path)).toEqual([
      'src/server/actions/contato.ts', 'src/components/generated/contato-manager.tsx', 'src/components/generated/index.ts',
    ])
    const action = layer.files[0]!.content
    const manager = layer.files[1]!.content
    expect(action).toContain("'use server'")
    expect(action).toContain('new ContatoRepository(database).create')
    expect(action).not.toContain('requireFormSession')
    expect(action).toContain("revalidatePath('/')")
    expect(manager).toContain('data-testid="contato-form"')
    expect(manager).toContain('data-testid="contato-list"')
    expect(manager).toContain('session === null ? <section aria-label="Área de gestão">')
    expect(manager).toContain('<label htmlFor="contato-nome">{"Nome"}</label>')
    expect(manager).toContain('name="situacao"')
    expect(layer.protectedPaths).toEqual(layer.files.map(file => file.path))
  })

  it('writes fixed paths once and produces nothing for another category', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-form-layer-')); roots.push(root)
    const layer = generateFormLayer(formSpec, 'form-database')
    await writeFormLayer(root, layer)
    await expect(readFile(resolve(root, 'src/server/actions/contato.ts'), 'utf8')).resolves.toContain('createContato')
    await expect(writeFormLayer(root, layer)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(generateFormLayer(formSpec, 'catalog')).toEqual({ files: [], protectedPaths: [] })
  })

  it('adds the generated login to sensitive data and rejects required links without CRUD', () => {
    const sensitive: AppSpecV1 = { ...formSpec, sensitive_data: { detected: ['financial'], confirmed_by_user: true } }
    const protectedLayer = generateFormLayer(sensitive, 'form-database')
    expect(protectedLayer.files[0]?.content).toContain('requireFormSession')
    expect(protectedLayer.files[1]?.content).toContain('AccessPanel')
    const linked = { ...formSpec, entities: [
      ...formSpec.entities,
      { name: 'Tarefa', kind: 'database' as const, sensitive: false, fields: [
        { name: 'Descrição', type: 'text' as const, required: true },
        { name: 'Contato', type: 'reference' as const, required: true, reference_entity: 'Contato' },
      ] },
    ] }
    expect(() => generateFormLayer(linked, 'form-database')).toThrow('depende de outro cadastro obrigatório')
  })
})
