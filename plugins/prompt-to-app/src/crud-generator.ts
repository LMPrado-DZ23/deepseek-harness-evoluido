import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import { tGeneratedApp } from './generated-i18n.js'
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
  const files: GeneratedFile[] = [{ path: 'src/components/generated/confirm-delete-button.tsx', content: CONFIRM_DELETE_BUTTON }]
  for (const entity of entities) {
    const slug = dataIdentifier(entity.name); const symbol = pascal(slug)
    files.push(
      { path: `src/server/actions/${slug}.ts`, content: renderActions(entity, entities, slug, symbol) },
      { path: `src/components/generated/${slug}-panel.tsx`, content: renderPanel(entity, entities, slug, symbol) },
    )
  }
  files.push({ path: 'src/components/generated/index.ts', content: `${entities.map(entity => { const slug=dataIdentifier(entity.name); return `export { default as ${pascal(slug)}Panel } from './${slug}-panel'` }).join('\n')}\n` })
  return { files, protectedPaths: files.map(file => file.path) }
}

export async function writeCrudLayer(root: string, layer: GeneratedCrudLayer): Promise<void> {
  for (const file of layer.files) { const target=resolve(root,file.path); await mkdir(dirname(target),{recursive:true}); await writeFile(target,file.content,{encoding:'utf8',flag:'wx'}) }
}

function renderActions(entity: DatabaseEntity, entities: readonly DatabaseEntity[], slug: string, symbol: string): string {
  const values = entity.fields.map(field => `    ${JSON.stringify(dataIdentifier(field.name))}: ${formValue(field)},`).join('\n')
  const referenceSetup = entity.fields.filter(isReference).map(field => {
    const target = findEntity(entities, field.reference_entity)
    const variable = referenceVariable(field)
    const required = field.required ? `if(${variable}==='')throw new Error(${JSON.stringify(tGeneratedApp('reference.required'))});` : ''
    return `const ${variable}=text(formData,${JSON.stringify(dataIdentifier(field.name))});${required}if(${variable}!==''&&new ${pascal(dataIdentifier(target.name))}Repository(database).get(${variable})===undefined)throw new Error(${JSON.stringify(tGeneratedApp('reference.invalid'))});`
  }).join('')
  const imports = repositoryImports(entity, entities)
  const inUse = JSON.stringify(tGeneratedApp('reference.inUse'))
  return `'use server'\nimport { revalidatePath } from 'next/cache'\nimport type { DatabaseSync } from 'node:sqlite'\nimport { requireFormSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\n${imports}\nfunction text(formData:FormData,name:string):string{const value=formData.get(name);return typeof value==='string'?value.trim():''}\nfunction values(database:DatabaseSync,formData:FormData){${referenceSetup}return {\n${values}\n  }}\nfunction rethrowDeleteConstraint(error:unknown):never{if(error instanceof Error&&/FOREIGN KEY constraint failed/iu.test(error.message))throw new Error(${inUse});throw error}\nexport async function create${symbol}(formData:FormData):Promise<void>{await requireFormSession(formData);const db=openDatabase();try{new ${symbol}Repository(db).create(values(db,formData))}finally{db.close()}revalidatePath('/')}\nexport async function update${symbol}(formData:FormData):Promise<void>{await requireFormSession(formData);const db=openDatabase();try{new ${symbol}Repository(db).update(text(formData,'id'),values(db,formData))}finally{db.close()}revalidatePath('/')}\nexport async function delete${symbol}(formData:FormData):Promise<void>{await requireFormSession(formData);const db=openDatabase();try{new ${symbol}Repository(db).delete(text(formData,'id'))}catch(error){rethrowDeleteConstraint(error)}finally{db.close()}revalidatePath('/')}\n`
}

function renderPanel(entity: DatabaseEntity, entities: readonly DatabaseEntity[], slug: string, symbol: string): string {
  const createInputs = entity.fields.map(field => renderInput(slug, field)).join('\n')
  const editInputs = entity.fields.map(field => renderInput(slug, field, 'row')).join('\n')
  const visible = entity.fields.map(field => `row[${JSON.stringify(dataIdentifier(field.name))}]`).join(', ')
  const optionDeclarations = entity.fields.filter(isReference).map(field => `let ${referenceOptionsVariable(field)}:readonly {id:string;label:string}[]=[];`).join('')
  const optionLoads = entity.fields.filter(isReference).map(field => { const target=findEntity(entities,field.reference_entity); const targetSymbol=pascal(dataIdentifier(target.name)); const label=dataIdentifier(target.fields.find(candidate=>candidate.type!=='reference')!.name); return `${referenceOptionsVariable(field)}=new ${targetSymbol}Repository(db).list().map(option=>({id:option.id,label:String(option[${JSON.stringify(label)}]??option.id)}));` }).join('')
  const yes = JSON.stringify(tGeneratedApp('common.yes'))
  const no = JSON.stringify(tGeneratedApp('common.no'))
  return `import { csrfForCurrentSession, currentSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { create${symbol},delete${symbol},update${symbol} } from '../../server/actions/${slug}'\n${repositoryImports(entity, entities)}\nimport { AccessPanel,AccountPanel } from './access-panel'\nimport { ConfirmDeleteButton } from './confirm-delete-button'\nexport default async function ${symbol}Panel(){const session=await currentSession();if(session===null)return <AccessPanel/>;const csrf=await csrfForCurrentSession();const db=openDatabase();let rows:ReturnType<${symbol}Repository['list']>;${optionDeclarations}try{rows=new ${symbol}Repository(db).list();${optionLoads}}finally{db.close()}return <main><AccountPanel/><h1>${jsx(tGeneratedApp('common.manageEntity',{entity:entity.name}))}</h1><section><h2>${tGeneratedApp('common.newRecord')}</h2><form action={create${symbol}} data-testid=${JSON.stringify(`${slug}-create-form`)}><input type="hidden" name="_csrf" value={csrf}/>\n${createInputs}\n<button type="submit">${tGeneratedApp('common.add')}</button></form></section><section><h2>${tGeneratedApp('common.records')}</h2>{rows.length===0?<p>${tGeneratedApp('common.emptyState')}</p>:<ul data-testid=${JSON.stringify(`${slug}-list`)}>{rows.map(row=><li key={row.id} data-testid={\`${slug}-row-\${row.id}\`}><p>{[${visible}].filter(value=>value!==null&&value!==undefined&&value!=='').map(value=>typeof value==='boolean'?(value?${yes}:${no}):String(value)).join(' · ')}</p><form action={update${symbol}} data-testid={\`${slug}-edit-\${row.id}\`}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="id" value={row.id}/>\n${editInputs}\n<button type="submit">${tGeneratedApp('common.saveChanges')}</button></form><form action={delete${symbol}}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="id" value={row.id}/><ConfirmDeleteButton/></form></li>)}</ul>}</section></main>}\n`
}

function renderInput(slug: string, field: DatabaseField, row?: string): string {
  const name=dataIdentifier(field.name); const id=row===undefined?`${slug}-new-${name}`:`${slug}-edit-${name}`; const required=field.required?' required':''; const value=row===undefined?undefined:`${row}[${JSON.stringify(name)}]`
  if(field.type==='boolean') return `<label htmlFor=${JSON.stringify(id)}><input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type="checkbox"${value===undefined?'':` defaultChecked={${value}===true}`}/> ${jsx(field.name)}</label>`
  if(field.type==='selection'){const options=field.options!.map(option=>`<option value=${JSON.stringify(option)}>${jsx(option)}</option>`).join('');return `<label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label><select id=${JSON.stringify(id)} name=${JSON.stringify(name)}${required}${value===undefined?'':` defaultValue={${value}??''}`}><option value="">${tGeneratedApp('common.select')}</option>${options}</select>`}
  if(field.type==='reference'){const options=referenceOptionsVariable(field);return `<label htmlFor=${JSON.stringify(id)}>${jsx(tGeneratedApp('reference.label',{entity:field.reference_entity!}))}</label><select id=${JSON.stringify(id)} name=${JSON.stringify(name)}${required}${value===undefined?'':` defaultValue={${value}??''}`}><option value="">${tGeneratedApp('reference.choose')}</option>{${options}.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}</select>`}
  const type=field.type==='email'?'email':field.type==='phone'?'tel':field.type==='date'?'date':field.type==='number'?'number':'text'
  return `<label htmlFor=${JSON.stringify(id)}>${jsx(field.name)}</label><input id=${JSON.stringify(id)} name=${JSON.stringify(name)} type=${JSON.stringify(type)}${required}${value===undefined?'':` defaultValue={${value}??''}`}/>`
}
function formValue(field:DatabaseField):string{const name=JSON.stringify(dataIdentifier(field.name));if(field.type==='reference')return `(${referenceVariable(field)}===''?undefined:${referenceVariable(field)})`;if(field.type==='boolean')return `formData.get(${name})==='on'`;if(field.type==='number')return `(text(formData,${name})===''?undefined:Number(text(formData,${name})))`;return field.required?`text(formData,${name})`:`(text(formData,${name})||undefined)`}
function jsx(value:string):string{return `{${JSON.stringify(value)}}`}
function pascal(value:string):string{return value.split('_').map(part=>`${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('')}

function isReference(field:DatabaseField):field is DatabaseField&{type:'reference';reference_entity:string}{return field.type==='reference'}
function comparable(value:string):string{return value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR')}
function findEntity(entities:readonly DatabaseEntity[],name:string):DatabaseEntity{const found=entities.find(entity=>comparable(entity.name)===comparable(name));if(found===undefined)throw new Error(`UNKNOWN_REFERENCE:${name}`);return found}
function referenceVariable(field:DatabaseField):string{return `reference_${dataIdentifier(field.name)}`}
function referenceOptionsVariable(field:DatabaseField):string{return `${dataIdentifier(field.name)}Options`}
function repositoryImports(entity:DatabaseEntity,entities:readonly DatabaseEntity[]):string{const selected=new Map<string,DatabaseEntity>([[comparable(entity.name),entity]]);for(const field of entity.fields.filter(isReference)){const target=findEntity(entities,field.reference_entity);selected.set(comparable(target.name),target)}return [...selected.values()].map(item=>{const itemSlug=dataIdentifier(item.name);return `import { ${pascal(itemSlug)}Repository } from '@/src/server/repositories/${itemSlug}'`}).join('\n')}

const CONFIRM_DELETE_BUTTON = `'use client'\nexport function ConfirmDeleteButton(){return <button type="submit" onClick={event=>{if(!window.confirm(${JSON.stringify(tGeneratedApp('common.confirmDelete'))}))event.preventDefault()}}>${tGeneratedApp('common.delete')}</button>}\n`
