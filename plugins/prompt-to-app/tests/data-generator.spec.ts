import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { assertValidDataModel, generateDataLayer, InvalidDataModelError, writeDataLayer } from '../src/data-generator.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const databaseSpec: AppSpecV1 = {
  schema_version: 1,
  problem: 'Organizar clientes e pedidos de uma pequena empresa.',
  audience: 'Equipe da empresa',
  journeys: ['Cadastrar clientes e pedidos'],
  pages: [{ name: 'Clientes', sections: ['Cadastro', 'Lista'] }],
  entities: [
    {
      name: 'Cliente', kind: 'database', sensitive: true,
      fields: [
        { name: 'Nome completo', type: 'text', required: true },
        { name: 'Apelido', type: 'text', required: false },
        { name: 'E-mail', type: 'email', required: true },
        { name: 'Telefone', type: 'phone', required: true },
        { name: 'Nascimento', type: 'date', required: true },
        { name: 'Ativo', type: 'boolean', required: true },
        { name: 'Limite', type: 'number', required: true },
        { name: 'Situação', type: 'selection', required: true, options: ['novo', "cliente d'ouro"] },
      ],
    },
    {
      name: 'Pedido', kind: 'database', sensitive: false,
      fields: [
        { name: 'Descrição', type: 'text', required: true },
        { name: 'Cliente', type: 'reference', required: true, reference_entity: 'Cliente' },
      ],
    },
  ],
  sensitive_data: { detected: ['financial'], confirmed_by_user: true },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['A pessoa consegue cadastrar um cliente.'],
}

describe('deterministic generated data layer', () => {
  it('validates a data model without generating or writing files', () => {
    expect(() => assertValidDataModel(databaseSpec)).not.toThrow()
    expect(() => assertValidDataModel({
      ...databaseSpec,
      entities: [databaseSpec.entities[0]!, { ...databaseSpec.entities[0]!, name: 'CLIENTE' }],
    } as AppSpecV1)).toThrow('DUPLICATE_ENTITY:CLIENTE')
  })

  it('renders reviewable SQL, Zod schemas, repositories and a real CRUD test', () => {
    const layer = generateDataLayer(databaseSpec)
    expect(layer.files.map(file => file.path)).toEqual([
      'src/db/schema.ts', 'src/db/migrations.ts', 'src/db/client.ts',
      'src/server/repositories/cliente.ts', 'src/server/repositories/pedido.ts',
      'src/server/repositories/index.ts', 'tests/generated-data.spec.ts',
    ])
    const selected = Object.fromEntries(layer.files.filter(file => ['src/db/schema.ts', 'src/db/migrations.ts'].includes(file.path)).map(file => [file.path, file.content]))
    expect(selected).toMatchSnapshot()
    expect(selected['src/db/schema.ts']).toContain('sensitive: true, requires_login: true, public_list: false')
    const nonSensitiveSchema = generateDataLayer({
      ...databaseSpec,
      entities: [{
        name: 'Pedido', kind: 'database', sensitive: false,
        fields: [{ name: 'Descrição', type: 'text', required: true }],
      }],
      sensitive_data: { detected: [], confirmed_by_user: false },
    }).files.find(file => file.path === 'src/db/schema.ts')?.content
    expect(nonSensitiveSchema).toContain('sensitive: false, requires_login: true, public_list: false')
    expect(selected['src/db/migrations.ts']).toContain('PRAGMA user_version')
    expect(selected['src/db/migrations.ts']).toContain('ON DELETE RESTRICT')
    const client = layer.files.find(file => file.path === 'src/db/client.ts')?.content
    expect(client).toContain("process.env.APP_EMAIL_MODE === 'studio-preview' ? 0o710 : 0o700")
    expect(client).toContain('chmodSync(databasePath, 0o600)')
    const clienteRepository = layer.files.find(file => file.path.endsWith('cliente.ts'))?.content
    expect(clienteRepository).toContain('class ClienteRepository')
    expect(clienteRepository).toContain('constructor(database: DatabaseSync) { this.database = database }')
    expect(clienteRepository).not.toContain('constructor(private readonly database')
    expect(layer.files.find(file => file.path.startsWith('tests/'))?.content).toContain("mkdtempSync(join(tmpdir(), 'dz23-generated-data-'))")
  })

  it('writes only its fixed generated paths and never overwrites them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-data-layer-')); roots.push(root)
    const layer = generateDataLayer(databaseSpec)
    await writeDataLayer(root, layer)
    await expect(readFile(resolve(root, 'src/db/client.ts'), 'utf8')).resolves.toContain('DATA_DIR')
    await expect(writeDataLayer(root, layer)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('rejects ambiguous identifiers, unknown references and unconfirmed sensitive entities', () => {
    const duplicateEntity = { ...databaseSpec, entities: [databaseSpec.entities[0]!, { ...databaseSpec.entities[0]!, name: 'CLIENTE' }] } as AppSpecV1
    expect(() => generateDataLayer(duplicateEntity)).toThrow(InvalidDataModelError)
    const duplicateField = { ...databaseSpec, entities: [{ ...databaseSpec.entities[0]!, fields: [{ name: 'ID', type: 'text', required: true }] }] } as AppSpecV1
    expect(() => generateDataLayer(duplicateField)).toThrow('DUPLICATE_FIELD_IDENTIFIER')
    const repeatedField = { ...databaseSpec, entities: [{ ...databaseSpec.entities[0]!, fields: [{ name: 'Nome', type: 'text', required: true }, { name: 'NOME', type: 'text', required: true }] }] } as AppSpecV1
    expect(() => generateDataLayer(repeatedField)).toThrow('DUPLICATE_FIELD_IDENTIFIER')
    const duplicateSlug = { ...databaseSpec, entities: [{ ...databaseSpec.entities[0]!, name: 'A-B' }, { ...databaseSpec.entities[1]!, name: 'A B', fields: [{ name: 'valor', type: 'text', required: true }] }] } as AppSpecV1
    expect(() => generateDataLayer(duplicateSlug)).toThrow('DUPLICATE_ENTITY_IDENTIFIER')
    const unknownReference = { ...databaseSpec, entities: [{ ...databaseSpec.entities[1]!, fields: [{ name: 'dono', type: 'reference', required: true, reference_entity: 'Ausente' }] }] } as AppSpecV1
    expect(() => generateDataLayer(unknownReference)).toThrow('UNKNOWN_REFERENCE')
    const missingReference = { ...databaseSpec, entities: [{ ...databaseSpec.entities[1]!, fields: [{ name: 'dono', type: 'reference', required: true }] }] } as unknown as AppSpecV1
    expect(() => generateDataLayer(missingReference)).toThrow('UNKNOWN_REFERENCE')
    const referenceOnly = { ...databaseSpec, entities: [{ name: 'Única', kind: 'database', sensitive: false, fields: [{ name: 'ela', type: 'reference', required: false, reference_entity: 'Única' }] }] } as unknown as AppSpecV1
    expect(() => generateDataLayer(referenceOnly)).toThrow('ENTITY_NEEDS_OWN_FIELD')
    const unconfirmed = { ...databaseSpec, sensitive_data: { detected: [], confirmed_by_user: false } } as AppSpecV1
    expect(() => generateDataLayer(unconfirmed)).toThrow('UNCONFIRMED_SENSITIVE_ENTITY')
    const notConfirmed = { ...databaseSpec, sensitive_data: { detected: ['financial'], confirmed_by_user: false } } as AppSpecV1
    expect(() => generateDataLayer(notConfirmed)).toThrow('UNCONFIRMED_SENSITIVE_ENTITY')
    expect(generateDataLayer({ ...databaseSpec, entities: [] })).toEqual({ files: [], protectedPaths: [] })
  })

  it('renders deterministic test values for every supported field type and defensive identifier', () => {
    for (const [type, extra] of [
      ['text', {}], ['number', {}], ['date', {}], ['boolean', {}], ['email', {}], ['phone', {}],
      ['selection', { options: ['primeiro', 'segundo'] }],
    ] as const) {
      const variant = {
        ...databaseSpec, sensitive_data: { detected: [] as const, confirmed_by_user: false },
        entities: [{ name: '123 Entidade', kind: 'database' as const, sensitive: false, fields: [{ name: '---', type, required: true, ...extra }] }],
      }
      const output = generateDataLayer(variant as unknown as AppSpecV1).files.find(file => file.path === 'tests/generated-data.spec.ts')?.content
      expect(output).toContain('item_123_entidade')
      expect(output).toContain('"item"')
    }
    expect(generateDataLayer({ ...databaseSpec, entities: [databaseSpec.entities[1]!, databaseSpec.entities[0]!] }).files).toHaveLength(7)
    const optionalReference = {
      ...databaseSpec, sensitive_data: { detected: [] as const, confirmed_by_user: false },
      entities: [{ name: 'Item', kind: 'database' as const, sensitive: false, fields: [
        { name: 'Nome', type: 'text' as const, required: true },
        { name: 'Pai', type: 'reference' as const, required: false, reference_entity: 'Item' },
      ] }],
    }
    expect(generateDataLayer(optionalReference as unknown as AppSpecV1).files).toHaveLength(6)
    const cyclic = {
      ...databaseSpec, sensitive_data: { detected: [] as const, confirmed_by_user: false },
      entities: [
        { name: 'A', kind: 'database' as const, sensitive: false, fields: [{ name: 'Nome', type: 'text' as const, required: true }, { name: 'B', type: 'reference' as const, required: true, reference_entity: 'B' }] },
        { name: 'B', kind: 'database' as const, sensitive: false, fields: [{ name: 'Nome', type: 'text' as const, required: true }, { name: 'A', type: 'reference' as const, required: true, reference_entity: 'A' }] },
      ],
    }
    expect(() => generateDataLayer(cyclic as unknown as AppSpecV1)).toThrow('REQUIRED_REFERENCE_CYCLE')
  })
})
