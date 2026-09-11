import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { requiresFormSubmissionAuth } from './auth-generator.js'
import { dataIdentifier } from './data-generator.js'
import { tGeneratedApp } from './generated-i18n.js'
import type { GeneratedFile } from './generator.js'
import type { StudioProjectCategory } from './model.js'
import { assertCategoryCanGenerate } from './planner.js'

type DatabaseEntity = Extract<AppSpecV1['entities'][number], { kind: 'database' }>
type DatabaseField = DatabaseEntity['fields'][number]

export interface GeneratedFormLayer {
  readonly files: readonly GeneratedFile[]
  readonly protectedPaths: readonly string[]
}

export function generateFormLayer(spec: AppSpecV1, category: StudioProjectCategory): GeneratedFormLayer {
  if (category !== 'form-database') return { files: [], protectedPaths: [] }
  assertCategoryCanGenerate(category, spec)
  const submissionAuthRequired = requiresFormSubmissionAuth(spec)
  const entities = spec.entities.filter((entity): entity is DatabaseEntity => entity.kind === 'database')
  const files: GeneratedFile[] = entities.flatMap(entity => {
    const slug = dataIdentifier(entity.name)
    const symbol = pascal(slug)
    return [
      { path: `src/server/actions/${slug}.ts`, content: renderAction(entity, entities, slug, symbol, submissionAuthRequired) },
      { path: `src/components/generated/${slug}-manager.tsx`, content: renderManager(entity, entities, slug, symbol, submissionAuthRequired) },
    ]
  })
  files.push({ path: 'src/components/generated/index.ts', content: renderIndex(entities) })
  return { files, protectedPaths: files.map(file => file.path) }
}

export async function writeFormLayer(root: string, layer: GeneratedFormLayer): Promise<void> {
  for (const file of layer.files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
}

function renderAction(entity: DatabaseEntity, entities: readonly DatabaseEntity[], slug: string, symbol: string, authRequired: boolean): string {
  const values = entity.fields.map(field => `    ${JSON.stringify(dataIdentifier(field.name))}: ${formValue(field)},`).join('\n')
  const authImport = authRequired ? "import { requireFormSession } from '../../auth/runtime'\n" : ''
  const guard = authRequired ? '  await requireFormSession(formData)\n' : ''
  const referenceSetup = entity.fields.filter(isReference).map(field => {
    const name = dataIdentifier(field.name)
    const target = findEntity(entities, field.reference_entity!)
    const required = field.required ? `  if (${referenceVariable(field)} === '') throw new Error(${JSON.stringify(tGeneratedApp('reference.required'))})\n` : ''
    return `  const ${referenceVariable(field)} = text(formData, ${JSON.stringify(name)})\n${required}  if (${referenceVariable(field)} !== '' && new ${pascal(dataIdentifier(target.name))}Repository(database).get(${referenceVariable(field)}) === undefined) throw new Error(${JSON.stringify(tGeneratedApp('reference.invalid'))})`
  }).join('\n')
  return `'use server'\n\nimport { revalidatePath } from 'next/cache'\n${authImport}import { openDatabase } from '../../db/client'\n${repositoryImports(entity, entities)}\n\nfunction text(formData: FormData, name: string): string {\n  const value = formData.get(name)\n  return typeof value === 'string' ? value.trim() : ''\n}\n\nexport async function create${symbol}(formData: FormData): Promise<void> {\n${guard}  const database = openDatabase()\n  try {\n${referenceSetup === '' ? '' : `${referenceSetup}\n`}    new ${symbol}Repository(database).create({\n${values}\n    })\n  } finally {\n    database.close()\n  }\n  revalidatePath('/')\n}\n`
}

function formValue(field: DatabaseField): string {
  const name = JSON.stringify(dataIdentifier(field.name))
  if (field.type === 'reference') return `(${referenceVariable(field)} === '' ? undefined : ${referenceVariable(field)})`
  if (field.type === 'boolean') return `formData.get(${name}) === 'on'`
  if (field.type === 'number') return `(text(formData, ${name}) === '' ? undefined : Number(text(formData, ${name})))`
  return field.required ? `text(formData, ${name})` : `(text(formData, ${name}) || undefined)`
}

function renderManager(entity: DatabaseEntity, entities: readonly DatabaseEntity[], slug: string, symbol: string, submissionAuthRequired: boolean): string {
  const fields = entity.fields
  const inputs = fields.map(field => renderInput(slug, field)).join('\n')
  const visible = fields.map(field => `row[${JSON.stringify(dataIdentifier(field.name))}]`).join(', ')
  const sessionGate = submissionAuthRequired ? '  if (session === null) return <AccessPanel />\n' : ''
  const csrfInput = submissionAuthRequired ? '      <input type="hidden" name="_csrf" value={csrf} />\n' : ''
  const optionDeclarations = entity.fields.filter(isReference).map(field => `  let ${referenceOptionsVariable(field)}: readonly { id: string; label: string }[] = []`).join('\n')
  const optionLoads = entity.fields.filter(isReference).map(field => {
    const target = findEntity(entities, field.reference_entity!)
    const targetSymbol = pascal(dataIdentifier(target.name))
    const label = dataIdentifier(target.fields.find(candidate => candidate.type !== 'reference')!.name)
    return `      ${referenceOptionsVariable(field)} = new ${targetSymbol}Repository(database).list().map(option => ({ id: option.id, label: String(option[${JSON.stringify(label)}] ?? option.id) }))`
  }).join('\n')
  const managementArea = JSON.stringify(tGeneratedApp('common.managementArea'))
  const managementSignIn = tGeneratedApp('common.managementSignIn')
  const savedRecords = tGeneratedApp('common.savedRecords')
  const yes = JSON.stringify(tGeneratedApp('common.yes'))
  const no = JSON.stringify(tGeneratedApp('common.no'))
  return `import { csrfForCurrentSession, currentSession } from '../../auth/runtime'\nimport { AccessPanel, AccountPanel } from './access-panel'\nimport { openDatabase } from '../../db/client'\nimport { create${symbol} } from '../../server/actions/${slug}'\n${repositoryImports(entity, entities)}\n\nexport default async function ${symbol}Manager() {\n  const session = await currentSession()\n${sessionGate}  const csrf = session === null ? '' : await csrfForCurrentSession()\n  let rows: ReturnType<${symbol}Repository['list']> = []\n${optionDeclarations === '' ? '' : `${optionDeclarations}\n`}  if (session !== null) {\n    const database = openDatabase()\n    try {\n      rows = new ${symbol}Repository(database).list()\n${optionLoads === '' ? '' : `${optionLoads}\n`}    } finally { database.close() }\n  }\n  return <section aria-labelledby=${JSON.stringify(`${slug}-title`)}>\n    {session === null ? null : <AccountPanel />}\n    <h2 id=${JSON.stringify(`${slug}-title`)}>${jsx(entity.name)}</h2>\n    <form action={create${symbol}} data-testid=${JSON.stringify(`${slug}-form`)}>\n${csrfInput}${inputs}\n      <button type="submit">${tGeneratedApp('common.save')}</button>\n    </form>\n    {session === null ? <section aria-label=${managementArea}><p>${managementSignIn}</p><AccessPanel /></section> : <>\n      <h3>${savedRecords}</h3>\n      {rows.length === 0 ? <p>${tGeneratedApp('common.emptyState')}</p> : <ul data-testid=${JSON.stringify(`${slug}-list`)}>\n        {rows.map(row => <li key={row.id}>{[${visible}].filter(value => value !== null && value !== undefined && value !== '').map(value => typeof value === 'boolean' ? (value ? ${yes} : ${no}) : String(value)).join(' · ')}</li>)}\n      </ul>}\n    </>}\n  </section>\n}\n`
}

function renderInput(slug: string, field: DatabaseField): string {
  const name = dataIdentifier(field.name)
  const id = `${slug}-${name}`
  const required = field.required ? ' required' : ''
  if (field.type === 'boolean') {
    return `      <label htmlFor=${JSON.stringify(id)}><input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type="checkbox" /> ${jsx(field.name)}</label>`
  }
  if (field.type === 'selection') {
    const options = field.options!.map(option => `        <option value=${jsx(option)}>${jsx(option)}</option>`).join('\n')
    return `      <label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label>\n      <select id=${JSON.stringify(id)} name=${JSON.stringify(name)}${required}>\n        <option value="">${tGeneratedApp('common.select')}</option>\n${options}\n      </select>`
  }
  if (field.type === 'reference') {
    const options = referenceOptionsVariable(field)
    return `      <label htmlFor=${JSON.stringify(id)}>${jsx(tGeneratedApp('reference.label', { entity: field.reference_entity! }))}</label>\n      <select id=${JSON.stringify(id)} name=${JSON.stringify(name)}${required}>\n        <option value="">${tGeneratedApp('reference.choose')}</option>\n        {${options}.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}\n      </select>`
  }
  const type = field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'
  return `      <label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label>\n      <input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type=${JSON.stringify(type)}${required} />`
}

function renderIndex(entities: readonly DatabaseEntity[]): string {
  return `${entities.map(entity => {
    const slug = dataIdentifier(entity.name)
    return `export { default as ${pascal(slug)}Manager } from './${slug}-manager'`
  }).join('\n')}\n`
}

function jsx(value: string): string { return `{${JSON.stringify(value)}}` }
function pascal(value: string): string { return value.split('_').map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('') }
function isReference(field: DatabaseField): field is DatabaseField & { type: 'reference'; reference_entity: string } { return field.type === 'reference' }
function comparable(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR') }
function findEntity(entities: readonly DatabaseEntity[], name: string): DatabaseEntity { const found=entities.find(entity => comparable(entity.name) === comparable(name)); if(found===undefined)throw new Error(`UNKNOWN_REFERENCE:${name}`); return found }
function referenceVariable(field: DatabaseField): string { return `reference_${dataIdentifier(field.name)}` }
function referenceOptionsVariable(field: DatabaseField): string { return `${dataIdentifier(field.name)}Options` }
function repositoryImports(entity: DatabaseEntity, entities: readonly DatabaseEntity[]): string {
  const selected = new Map<string, DatabaseEntity>([[comparable(entity.name), entity]])
  for (const field of entity.fields.filter(isReference)) { const target=findEntity(entities,field.reference_entity); selected.set(comparable(target.name),target) }
  return [...selected.values()].map(item => { const slug=dataIdentifier(item.name); return `import { ${pascal(slug)}Repository } from '@/src/server/repositories/${slug}'` }).join('\n')
}
