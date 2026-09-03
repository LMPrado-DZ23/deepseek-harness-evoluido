import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import type { GeneratedFile } from './generator.js'
import type { StudioProjectCategory } from './model.js'
import { assertCategoryCanGenerate } from './planner.js'

type DatabaseEntity = Extract<AppSpecV1['entities'][number], { kind: 'database' }>
type DatabaseField = DatabaseEntity['fields'][number]

export class CrudCategoryError extends Error { readonly code = 'CRUD_REFERENCE_REQUIRES_SELECTOR' }
export interface GeneratedCrudLayer { readonly files: readonly GeneratedFile[]; readonly protectedPaths: readonly string[] }

export function generateCrudLayer(spec: AppSpecV1, category: StudioProjectCategory): GeneratedCrudLayer {
  if (category !== 'crud-panel') return { files: [], protectedPaths: [] }
  assertCategoryCanGenerate(category, spec)
  const entities = spec.entities.filter((entity): entity is DatabaseEntity => entity.kind === 'database')
  if (entities.some(entity => entity.fields.some(field => field.type === 'reference'))) throw new CrudCategoryError('O painel com ligações entre cadastros exige um seletor seguro que ainda não está disponível.')
  const files: GeneratedFile[] = [{ path: 'src/components/generated/confirm-delete-button.tsx', content: CONFIRM_DELETE_BUTTON }]
  for (const entity of entities) {
    const slug = dataIdentifier(entity.name); const symbol = pascal(slug)
    files.push(
      { path: `src/server/actions/${slug}.ts`, content: renderActions(entity, slug, symbol) },
      { path: `src/components/generated/${slug}-panel.tsx`, content: renderPanel(entity, slug, symbol) },
    )
  }
  files.push({ path: 'src/components/generated/index.ts', content: `${entities.map(entity => { const slug=dataIdentifier(entity.name); return `export { default as ${pascal(slug)}Panel } from './${slug}-panel'` }).join('\n')}\n` })
  return { files, protectedPaths: files.map(file => file.path) }
}

export async function writeCrudLayer(root: string, layer: GeneratedCrudLayer): Promise<void> {
  for (const file of layer.files) { const target=resolve(root,file.path); await mkdir(dirname(target),{recursive:true}); await writeFile(target,file.content,{encoding:'utf8',flag:'wx'}) }
}

function renderActions(entity: DatabaseEntity, slug: string, symbol: string): string {
  const values = entity.fields.map(field => `    ${JSON.stringify(dataIdentifier(field.name))}: ${formValue(field)},`).join('\n')
  return `'use server'\nimport { revalidatePath } from 'next/cache'\nimport { requireFormSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { ${symbol}Repository } from '../repositories/${slug}'\nfunction text(formData:FormData,name:string):string{const value=formData.get(name);return typeof value==='string'?value.trim():''}\nfunction values(formData:FormData){return {\n${values}\n  }}\nexport async function create${symbol}(formData:FormData):Promise<void>{await requireFormSession(formData);const db=openDatabase();try{new ${symbol}Repository(db).create(values(formData))}finally{db.close()}revalidatePath('/')}\nexport async function update${symbol}(formData:FormData):Promise<void>{await requireFormSession(formData);const db=openDatabase();try{new ${symbol}Repository(db).update(text(formData,'id'),values(formData))}finally{db.close()}revalidatePath('/')}\nexport async function delete${symbol}(formData:FormData):Promise<void>{await requireFormSession(formData);const db=openDatabase();try{new ${symbol}Repository(db).delete(text(formData,'id'))}finally{db.close()}revalidatePath('/')}\n`
}

function renderPanel(entity: DatabaseEntity, slug: string, symbol: string): string {
  const createInputs = entity.fields.map(field => renderInput(slug, field)).join('\n')
  const editInputs = entity.fields.map(field => renderInput(slug, field, 'row')).join('\n')
  const visible = entity.fields.map(field => `row[${JSON.stringify(dataIdentifier(field.name))}]`).join(', ')
  return `import { csrfForCurrentSession, currentSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { create${symbol},delete${symbol},update${symbol} } from '../../server/actions/${slug}'\nimport { ${symbol}Repository } from '../../server/repositories/${slug}'\nimport { AccessPanel,AccountPanel } from './access-panel'\nimport { ConfirmDeleteButton } from './confirm-delete-button'\nexport default async function ${symbol}Panel(){const session=await currentSession();if(session===null)return <AccessPanel/>;const csrf=await csrfForCurrentSession();const db=openDatabase();let rows:ReturnType<${symbol}Repository['list']>;try{rows=new ${symbol}Repository(db).list()}finally{db.close()}return <main><AccountPanel/><h1>${jsx(`Gerenciar ${entity.name}`)}</h1><section><h2>Novo cadastro</h2><form action={create${symbol}} data-testid=${JSON.stringify(`${slug}-create-form`)}><input type="hidden" name="_csrf" value={csrf}/>\n${createInputs}\n<button type="submit">Adicionar</button></form></section><section><h2>Cadastros</h2>{rows.length===0?<p>Nenhum cadastro ainda.</p>:<ul data-testid=${JSON.stringify(`${slug}-list`)}>{rows.map(row=><li key={row.id} data-testid={\`${slug}-row-\${row.id}\`}><p>{[${visible}].filter(value=>value!==null&&value!==undefined&&value!=='').map(value=>typeof value==='boolean'?(value?'Sim':'Não'):String(value)).join(' · ')}</p><form action={update${symbol}} data-testid={\`${slug}-edit-\${row.id}\`}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="id" value={row.id}/>\n${editInputs}\n<button type="submit">Salvar alterações</button></form><form action={delete${symbol}}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="id" value={row.id}/><ConfirmDeleteButton/></form></li>)}</ul>}</section></main>}\n`
}

function renderInput(slug: string, field: DatabaseField, row?: string): string {
  const name=dataIdentifier(field.name); const id=row===undefined?`${slug}-new-${name}`:`${slug}-edit-${name}`; const required=field.required?' required':''; const value=row===undefined?undefined:`${row}[${JSON.stringify(name)}]`
  if(field.type==='boolean') return `<label htmlFor=${JSON.stringify(id)}><input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type="checkbox"${value===undefined?'':` defaultChecked={${value}===true}`}/> ${jsx(field.name)}</label>`
  if(field.type==='selection'){const options=field.options!.map(option=>`<option value=${JSON.stringify(option)}>${jsx(option)}</option>`).join('');return `<label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label><select id=${JSON.stringify(id)} name=${JSON.stringify(name)}${required}${value===undefined?'':` defaultValue={${value}??''}`}><option value="">Selecione</option>${options}</select>`}
  const type=field.type==='email'?'email':field.type==='phone'?'tel':field.type==='date'?'date':field.type==='number'?'number':'text'
  return `<label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label><input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type=${JSON.stringify(type)}${required}${value===undefined?'':` defaultValue={${value}??''}`}/>`
}
function formValue(field:DatabaseField):string{const name=JSON.stringify(dataIdentifier(field.name));if(field.type==='boolean')return `formData.get(${name})==='on'`;if(field.type==='number')return `(text(formData,${name})===''?undefined:Number(text(formData,${name})))`;return field.required?`text(formData,${name})`:`(text(formData,${name})||undefined)`}
function jsx(value:string):string{return `{${JSON.stringify(value)}}`}
function pascal(value:string):string{return value.split('_').map(part=>`${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('')}

const CONFIRM_DELETE_BUTTON = `'use client'\nexport function ConfirmDeleteButton(){return <button type="submit" onClick={event=>{if(!window.confirm('Excluir este cadastro?'))event.preventDefault()}}>Excluir</button>}\n`
