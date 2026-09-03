import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
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
  const entities = spec.entities.filter((entity): entity is DatabaseEntity => entity.kind === 'database')
  const files: GeneratedFile[] = entities.flatMap(entity => {
    const slug = dataIdentifier(entity.name)
    const symbol = pascal(slug)
    return [
      { path: `src/server/actions/${slug}.ts`, content: renderAction(entity, slug, symbol) },
      { path: `src/components/generated/${slug}-manager.tsx`, content: renderManager(entity, slug, symbol) },
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

function renderAction(entity: DatabaseEntity, slug: string, symbol: string): string {
  const values = entity.fields.map(field => `    ${JSON.stringify(dataIdentifier(field.name))}: ${formValue(field)},`).join('\n')
  return `'use server'\n\nimport { revalidatePath } from 'next/cache'\nimport { openDatabase } from '../../db/client'\nimport { ${symbol}Repository } from '../repositories/${slug}'\n\nfunction text(formData: FormData, name: string): string {\n  const value = formData.get(name)\n  return typeof value === 'string' ? value.trim() : ''\n}\n\nexport async function create${symbol}(formData: FormData): Promise<void> {\n  const database = openDatabase()\n  try {\n    new ${symbol}Repository(database).create({\n${values}\n    })\n  } finally {\n    database.close()\n  }\n  revalidatePath('/')\n}\n`
}

function formValue(field: DatabaseField): string {
  const name = JSON.stringify(dataIdentifier(field.name))
  if (field.type === 'reference') return 'undefined'
  if (field.type === 'boolean') return `formData.get(${name}) === 'on'`
  if (field.type === 'number') return `(text(formData, ${name}) === '' ? undefined : Number(text(formData, ${name})))`
  return field.required ? `text(formData, ${name})` : `(text(formData, ${name}) || undefined)`
}

function renderManager(entity: DatabaseEntity, slug: string, symbol: string): string {
  const fields = entity.fields.filter(field => field.type !== 'reference')
  const inputs = fields.map(field => renderInput(slug, field)).join('\n')
  const visible = fields.map(field => `row[${JSON.stringify(dataIdentifier(field.name))}]`).join(', ')
  return `import { openDatabase } from '../../db/client'\nimport { create${symbol} } from '../../server/actions/${slug}'\nimport { ${symbol}Repository } from '../../server/repositories/${slug}'\n\nexport default function ${symbol}Manager() {\n  const database = openDatabase()\n  let rows: ReturnType<${symbol}Repository['list']>\n  try { rows = new ${symbol}Repository(database).list() } finally { database.close() }\n  return <section aria-labelledby=${JSON.stringify(`${slug}-title`)}>\n    <h2 id=${JSON.stringify(`${slug}-title`)}>${jsx(entity.name)}</h2>\n    <form action={create${symbol}} data-testid=${JSON.stringify(`${slug}-form`)}>\n${inputs}\n      <button type="submit">Salvar</button>\n    </form>\n    <h3>Cadastros salvos</h3>\n    {rows.length === 0 ? <p>Nenhum cadastro ainda.</p> : <ul data-testid=${JSON.stringify(`${slug}-list`)}>\n      {rows.map(row => <li key={row.id}>{[${visible}].filter(value => value !== null && value !== undefined && value !== '').map(value => typeof value === 'boolean' ? (value ? 'Sim' : 'Não') : String(value)).join(' · ')}</li>)}\n    </ul>}\n  </section>\n}\n`
}

function renderInput(slug: string, field: DatabaseField): string {
  const name = dataIdentifier(field.name)
  const id = `${slug}-${name}`
  const required = field.required ? ' required' : ''
  if (field.type === 'boolean') {
    return `      <label htmlFor=${JSON.stringify(id)}><input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type="checkbox" /> ${jsx(field.name)}</label>`
  }
  if (field.type === 'selection') {
    const options = field.options!.map(option => `        <option value=${JSON.stringify(option)}>${jsx(option)}</option>`).join('\n')
    return `      <label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label>\n      <select id=${JSON.stringify(id)} name=${JSON.stringify(name)}${required}>\n        <option value="">Selecione</option>\n${options}\n      </select>`
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
