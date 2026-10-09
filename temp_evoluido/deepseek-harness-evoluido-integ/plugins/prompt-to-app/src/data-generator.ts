import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1, EntityFieldType } from './appspec.js'
import type { GeneratedFile } from './generator.js'
import { tGeneratedApp } from './generated-i18n.js'

type DatabaseEntity = Extract<AppSpecV1['entities'][number], { kind: 'database' }>
type DatabaseField = DatabaseEntity['fields'][number]

export class InvalidDataModelError extends Error {
  readonly code = 'INVALID_DATA_MODEL'
}

export interface GeneratedDataLayer {
  readonly files: readonly GeneratedFile[]
  readonly protectedPaths: readonly string[]
}

interface PreparedField extends DatabaseField {
  readonly column: string
}

interface PreparedEntity extends Omit<DatabaseEntity, 'fields'> {
  readonly slug: string
  readonly symbol: string
  readonly table: string
  readonly fields: readonly PreparedField[]
}

export function generateDataLayer(spec: AppSpecV1): GeneratedDataLayer {
  const entities = prepareEntities(spec)
  if (entities.length === 0) return { files: [], protectedPaths: [] }

  const files: GeneratedFile[] = [
    { path: 'src/db/schema.ts', content: renderSchema(entities) },
    { path: 'src/db/migrations.ts', content: renderMigrations(entities) },
    { path: 'src/db/client.ts', content: renderClient() },
    ...entities.map(entity => ({ path: `src/server/repositories/${entity.slug}.ts`, content: renderNodeCompatibleRepository(entity) })),
    { path: 'src/server/repositories/index.ts', content: renderRepositoryIndex(entities) },
    { path: 'tests/generated-data.spec.ts', content: renderGeneratedTest(entities) },
  ]
  return { files, protectedPaths: files.map(file => file.path) }
}

/** Validate the persistent graph before a plan is accepted or files are written. */
export function assertValidDataModel(spec: AppSpecV1): void {
  prepareEntities(spec)
}

export async function writeDataLayer(root: string, layer: GeneratedDataLayer): Promise<void> {
  for (const file of layer.files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
}

function prepareEntities(spec: AppSpecV1): readonly PreparedEntity[] {
  const databaseEntities = spec.entities.filter((entity): entity is DatabaseEntity => entity.kind === 'database')
  const entityNames = new Map<string, DatabaseEntity>()
  const slugs = new Set<string>()
  for (const entity of databaseEntities) {
    const key = comparable(entity.name)
    if (entityNames.has(key)) throw new InvalidDataModelError(`DUPLICATE_ENTITY:${entity.name}`)
    entityNames.set(key, entity)
    const slug = identifier(entity.name)
    if (slugs.has(slug)) throw new InvalidDataModelError(`DUPLICATE_ENTITY_IDENTIFIER:${slug}`)
    slugs.add(slug)
    const sensitive = entity.sensitive || spec.sensitive_data.detected.length > 0
    if (sensitive && (!spec.sensitive_data.confirmed_by_user || (entity.sensitive && spec.sensitive_data.detected.length === 0))) {
      throw new InvalidDataModelError(`UNCONFIRMED_SENSITIVE_ENTITY:${entity.name}`)
    }
  }

  const prepared = databaseEntities.map(entity => {
    const fieldNames = new Set<string>()
    const fields = entity.fields.map(field => {
      const column = identifier(field.name)
      if (fieldNames.has(column) || ['id', 'created_at', 'updated_at'].includes(column)) {
        throw new InvalidDataModelError(`DUPLICATE_FIELD_IDENTIFIER:${entity.name}.${column}`)
      }
      fieldNames.add(column)
      if (field.type === 'reference' && !entityNames.has(comparable(field.reference_entity ?? ''))) {
        throw new InvalidDataModelError(`UNKNOWN_REFERENCE:${entity.name}.${field.name}`)
      }
      return { ...field, column }
    })
    if (!fields.some(field => field.type !== 'reference')) throw new InvalidDataModelError(`ENTITY_NEEDS_OWN_FIELD:${entity.name}`)
    const slug = identifier(entity.name)
    const sensitive = entity.sensitive || spec.sensitive_data.detected.length > 0
    return { ...entity, sensitive, slug, symbol: pascal(slug), table: `entity_${slug}`, fields }
  })
  assertNoRequiredReferenceCycle(prepared)
  return prepared
}

function renderSchema(entities: readonly PreparedEntity[]): string {
  const declarations = entities.map(entity => {
    const fields = entity.fields.map(field => `  ${JSON.stringify(field.column)}: ${zodForField(field)}${field.required ? '' : '.optional()'},`).join('\n')
    const recordFields = entity.fields.map(field => `  ${JSON.stringify(field.column)}: ${zodForField(field)}${field.required ? '' : '.nullable()'},`).join('\n')
    return `export const ${entity.symbol}InputSchema = z.object({\n${fields}\n}).strict()\nexport const ${entity.symbol}UpdateSchema = ${entity.symbol}InputSchema.partial().refine(value => Object.keys(value).length > 0, ${JSON.stringify(tGeneratedApp('validation.requireOneField'))})\nexport const ${entity.symbol}RecordSchema = z.object({\n  id: z.string().uuid(),\n${recordFields}\n  created_at: z.string().datetime(),\n  updated_at: z.string().datetime(),\n}).strict()\nexport type ${entity.symbol}Input = z.infer<typeof ${entity.symbol}InputSchema>\nexport type ${entity.symbol}Update = z.infer<typeof ${entity.symbol}UpdateSchema>\nexport type ${entity.symbol}Record = z.infer<typeof ${entity.symbol}RecordSchema>`
  }).join('\n\n')
  const metadata = entities.map(entity => `  ${JSON.stringify(entity.slug)}: { table: ${JSON.stringify(entity.table)}, sensitive: ${entity.sensitive}, requires_login: true, public_list: false },`).join('\n')
  return `import { z } from 'zod'\n\n${declarations}\n\nexport const entitySecurity = {\n${metadata}\n} as const\n`
}

function renderMigrations(entities: readonly PreparedEntity[]): string {
  const sql = entities.map(entity => {
    const columns = entity.fields.map(field => renderColumn(field, entities)).join(',\n  ')
    return `CREATE TABLE IF NOT EXISTS ${quoteId(entity.table)} (\n  "id" TEXT PRIMARY KEY,\n  ${columns},\n  "created_at" TEXT NOT NULL,\n  "updated_at" TEXT NOT NULL\n) STRICT;`
  }).join('\n\n')
  return `import type { DatabaseSync } from 'node:sqlite'\n\nexport const migrations = [\n  { version: 1, sql: ${JSON.stringify(sql)} },\n] as const\n\nexport function migrate(database: DatabaseSync): void {\n  database.exec('PRAGMA foreign_keys = ON')\n  database.exec('PRAGMA journal_mode = WAL')\n  const current = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)\n  for (const migration of migrations) {\n    if (migration.version <= current) continue\n    database.exec('BEGIN IMMEDIATE')\n    try {\n      database.exec(migration.sql)\n      database.exec(\`PRAGMA user_version = \${migration.version}\`)\n      database.exec('COMMIT')\n    } catch (error) {\n      database.exec('ROLLBACK')\n      throw error\n    }\n  }\n}\n`
}

function renderClient(): string {
  return `import { chmodSync, mkdirSync } from 'node:fs'\nimport { resolve } from 'node:path'\nimport { DatabaseSync } from 'node:sqlite'\nimport { migrate } from './migrations'\n\nexport function openDatabase(dataDirectory = process.env.DATA_DIR ?? './data'): DatabaseSync {\n  const directory = resolve(dataDirectory)\n  const directoryMode = process.env.APP_EMAIL_MODE === 'studio-preview' ? 0o710 : 0o700\n  mkdirSync(directory, { recursive: true, mode: directoryMode })\n  chmodSync(directory, directoryMode)\n  const databasePath = resolve(directory, 'app.sqlite')\n  const database = new DatabaseSync(databasePath)\n  chmodSync(databasePath, 0o600)\n  migrate(database)\n  return database\n}\n`
}

function renderRepository(entity: PreparedEntity): string {
  const names = entity.fields.map(field => field.column)
  const insertColumns = ['id', ...names, 'created_at', 'updated_at'].map(quoteId).join(', ')
  const insertParams = ['@id', ...names.map(name => `@${name}`), '@created_at', '@updated_at'].join(', ')
  const createValues = entity.fields.map(field => `      ${field.column}: ${encodeExpression(field, `value.${field.column}`)},`).join('\n')
  const updateAssignments = entity.fields.map(field => `${quoteId(field.column)} = @${field.column}`).join(', ')
  const updateValues = entity.fields.map(field => `      ${field.column}: ${updateExpression(field)},`).join('\n')
  const decodeFields = entity.fields.map(field => `      ${field.column}: ${decodeExpression(field, `row.${field.column}`)},`).join('\n')
  return `import { randomUUID } from 'node:crypto'\nimport type { DatabaseSync } from 'node:sqlite'\nimport { ${entity.symbol}InputSchema, ${entity.symbol}RecordSchema, ${entity.symbol}UpdateSchema, type ${entity.symbol}Record } from '../../db/schema'\n\ntype SqlRow = Record<string, unknown>\n\nexport class ${entity.symbol}Repository {\n  constructor(private readonly database: DatabaseSync) {}\n\n  create(input: unknown): ${entity.symbol}Record {\n    const value = ${entity.symbol}InputSchema.parse(input)\n    const now = new Date().toISOString()\n    const parameters = {\n      id: randomUUID(),\n${createValues}\n      created_at: now,\n      updated_at: now,\n    }\n    this.database.prepare(${JSON.stringify(`INSERT INTO ${quoteId(entity.table)} (${insertColumns}) VALUES (${insertParams})`)}).run(parameters)\n    return this.get(parameters.id)!\n  }\n\n  get(id: string): ${entity.symbol}Record | undefined {\n    const row = this.database.prepare(${JSON.stringify(`SELECT * FROM ${quoteId(entity.table)} WHERE "id" = ?`)}).get(id) as SqlRow | undefined\n    return row === undefined ? undefined : this.decode(row)\n  }\n\n  list(): readonly ${entity.symbol}Record[] {\n    const rows = this.database.prepare(${JSON.stringify(`SELECT * FROM ${quoteId(entity.table)} ORDER BY "created_at", "id"`)}).all() as SqlRow[]\n    return rows.map(row => this.decode(row))\n  }\n\n  update(id: string, input: unknown): ${entity.symbol}Record | undefined {\n    const current = this.get(id)\n    if (current === undefined) return undefined\n    const value = ${entity.symbol}UpdateSchema.parse(input)\n    this.database.prepare(${JSON.stringify(`UPDATE ${quoteId(entity.table)} SET ${updateAssignments}, "updated_at" = @updated_at WHERE "id" = @id`)}).run({\n      id,\n${updateValues}\n      updated_at: new Date().toISOString(),\n    })\n    return this.get(id)\n  }\n\n  delete(id: string): boolean {\n    return Number(this.database.prepare(${JSON.stringify(`DELETE FROM ${quoteId(entity.table)} WHERE "id" = ?`)}).run(id).changes) === 1\n  }\n\n  private decode(row: SqlRow): ${entity.symbol}Record {\n    return ${entity.symbol}RecordSchema.parse({\n      id: row.id,\n${decodeFields}\n      created_at: row.created_at,\n      updated_at: row.updated_at,\n    })\n  }\n}\n`
}

function renderNodeCompatibleRepository(entity: PreparedEntity): string {
  return renderRepository(entity).replace(
    '  constructor(private readonly database: DatabaseSync) {}',
    '  private readonly database: DatabaseSync\n\n  constructor(database: DatabaseSync) { this.database = database }',
  )
}

function renderRepositoryIndex(entities: readonly PreparedEntity[]): string {
  return `${entities.map(entity => `export { ${entity.symbol}Repository } from './${entity.slug}'`).join('\n')}\n`
}

function renderGeneratedTest(entities: readonly PreparedEntity[]): string {
  const entity = entities.find(candidate => candidate.fields.every(field => field.type !== 'reference' || !field.required))!
  const input = Object.fromEntries(entity.fields.map(field => [field.column, fixtureValue(field, false)]).filter(([, value]) => value !== undefined))
  const updateField = entity.fields.find(field => field.type !== 'reference')!
  const update = { [updateField.column]: fixtureValue(updateField, true) }
  return `// @vitest-environment node\nimport { mkdtempSync, rmSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { describe, expect, it } from 'vitest'\nimport { openDatabase } from '../src/db/client'\nimport { migrate } from '../src/db/migrations'\nimport { ${entity.symbol}Repository } from '../src/server/repositories/${entity.slug}'\n\ndescribe('camada de dados gerada pelo Studio', () => {\n  it('migra e executa criar, listar, atualizar e excluir', () => {\n    const dataDirectory = mkdtempSync(join(tmpdir(), 'dz23-generated-data-'))\n    const database = openDatabase(dataDirectory)\n    try {\n      migrate(database)\n      expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })\n      expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })\n      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })\n      const repository = new ${entity.symbol}Repository(database)\n      const created = repository.create(${JSON.stringify(input, null, 2)})\n      expect(repository.list()).toEqual([created])\n      const updated = repository.update(created.id, ${JSON.stringify(update, null, 2)})\n      expect(updated).toMatchObject(${JSON.stringify(update, null, 2)})\n      expect(repository.delete(created.id)).toBe(true)\n      expect(repository.get(created.id)).toBeUndefined()\n    } finally {\n      database.close()\n      rmSync(dataDirectory, { recursive: true, force: true })\n    }\n  })\n})\n`
}

function renderColumn(field: PreparedField, entities: readonly PreparedEntity[]): string {
  const constraints = [sqlType(field.type)]
  if (field.required) constraints.push('NOT NULL')
  if (field.type === 'boolean') constraints.push(`CHECK (${quoteId(field.column)} IN (0, 1))`)
  if (field.type === 'selection') constraints.push(`CHECK (${quoteId(field.column)} IN (${field.options!.map(sqlString).join(', ')}))`)
  if (field.type === 'reference') {
    const target = entities.find(entity => comparable(entity.name) === comparable(field.reference_entity!))!
    constraints.push(`REFERENCES ${quoteId(target.table)} ("id") ON UPDATE CASCADE ON DELETE RESTRICT`)
  }
  return `${quoteId(field.column)} ${constraints.join(' ')}`
}

function zodForField(field: PreparedField): string {
  if (field.type === 'number') return 'z.number().finite()'
  if (field.type === 'boolean') return 'z.boolean()'
  if (field.type === 'email') return 'z.string().email().max(254)'
  if (field.type === 'date') return 'z.iso.date()'
  if (field.type === 'selection') return `z.enum(${JSON.stringify(field.options)})`
  return 'z.string().min(1).max(2_000)'
}

function sqlType(type: EntityFieldType): string { return type === 'number' ? 'REAL' : type === 'boolean' ? 'INTEGER' : 'TEXT' }
function encodeExpression(field: PreparedField, expression: string): string { return field.type === 'boolean' ? `${expression} === undefined ? null : (${expression} ? 1 : 0)` : `${expression} ?? null` }
function updateExpression(field: PreparedField): string {
  const next = `value.${field.column}`; const current = `current.${field.column}`
  if (field.type === 'boolean') return `${next} === undefined ? (${current} === null ? null : (${current} ? 1 : 0)) : (${next} ? 1 : 0)`
  return `${next} === undefined ? ${current} : ${next}`
}
function decodeExpression(field: PreparedField, expression: string): string { return field.type === 'boolean' ? `${expression} === null ? null : ${expression} === 1` : expression }
/**
 * Um identificador SQL entre aspas, com aspa interna duplicada.
 *
 * Exportado porque o gerador de formulário precisa contar linhas na tabela da
 * entidade para o teto do formulário público, e redigitar a regra de aspas ali
 * criaria uma segunda verdade — livre para divergir desta no primeiro conserto.
 * @param value - o identificador já normalizado por `dataIdentifier`.
 * @returns o identificador citado.
 */
export function quoteId(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function sqlString(value: string): string { return `'${value.replaceAll("'", "''")}'` }
function comparable(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR') }
export function dataIdentifier(value: string): string {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
  const safe = normalized || 'item'
  return /^\d/u.test(safe) ? `item_${safe}` : safe
}
const identifier = dataIdentifier
function pascal(value: string): string { return value.split('_').map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('') }
function fixtureValue(field: PreparedField, alternate: boolean): unknown {
  if (!field.required && !alternate) return undefined
  if (field.type === 'number') return alternate ? 2 : 1
  if (field.type === 'boolean') return !alternate
  if (field.type === 'email') return alternate ? 'novo@example.test' : 'pessoa@example.test'
  if (field.type === 'date') return alternate ? '2026-09-04' : '2026-09-03'
  if (field.type === 'selection') return alternate ? field.options!.at(-1) : field.options![0]
  // Os valores de exemplo que o TESTE GERADO grava. Estão em português porque
  // o aplicativo gerado está, e por isso saem do catálogo do aplicativo gerado.
  return alternate ? tGeneratedApp('fixture.updatedValue') : tGeneratedApp('fixture.initialValue')
}

function assertNoRequiredReferenceCycle(entities: readonly PreparedEntity[]): void {
  const pending = new Map(entities.map(entity => [
    comparable(entity.name),
    new Set(entity.fields.filter(field => field.type === 'reference' && field.required).map(field => comparable(field.reference_entity!))),
  ]))
  while (pending.size > 0) {
    const ready = [...pending].find(([, dependencies]) => [...dependencies].every(dependency => !pending.has(dependency)))
    if (ready === undefined) throw new InvalidDataModelError('REQUIRED_REFERENCE_CYCLE')
    pending.delete(ready[0])
  }
}
