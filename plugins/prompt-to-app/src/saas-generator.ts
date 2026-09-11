import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import { tGeneratedApp } from './generated-i18n.js'
import type { GeneratedFile } from './generator.js'
import type { StudioProjectCategory } from './model.js'

type JsonPrimitive = boolean | number | string | null
export type SaasPayload = JsonPrimitive | readonly SaasPayload[] | { readonly [key: string]: SaasPayload }
export type SaasRole = 'owner' | 'member'

export interface SaasSession {
  readonly userId: string
  readonly role: SaasRole
  readonly csrf: string
}

export interface SaasRequest {
  readonly session: SaasSession | null
  readonly csrfSubmitted?: string
}

export interface SaasRecord {
  readonly id: string
  readonly entity: string
  readonly ownerUserId: string
  readonly payload: Readonly<Record<string, SaasPayload>>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface GeneratedSaasLayer {
  readonly entities: readonly string[]
  readonly files: readonly GeneratedFile[]
  readonly protectedPaths: readonly string[]
}

export class SaasContractError extends Error {
  readonly code = 'INVALID_SAAS_CONTRACT'
}

export class SaasAccessError extends Error {
  readonly code: 'AUTH_REQUIRED' | 'ROLE_FORBIDDEN' | 'CSRF'

  constructor(code: SaasAccessError['code']) {
    super(code)
    this.code = code
  }
}

export class SaasRecordNotFoundError extends Error {
  readonly code = 'NOT_FOUND'
  readonly status = 404

  constructor() {
    super(tGeneratedApp('saas.notFound'))
  }
}

/**
 * Executable authorization contract mirrored by the generated SQLite adapter.
 * It intentionally returns the same 404 for an absent record and for a record
 * owned by another member, so callers cannot probe identifiers.
 */
export class SaasDomain {
  readonly #rows = new Map<string, SaasRecord>()
  readonly #createId: () => string
  readonly #now: () => Date

  constructor(options: { readonly createId?: () => string; readonly now?: () => Date } = {}) {
    this.#createId = options.createId ?? randomUUID
    this.#now = options.now ?? (() => new Date())
  }

  create(entity: string, input: unknown, request: SaasRequest): SaasRecord {
    const session = authorize(request, true)
    const payload = payloadObject(input)
    const now = this.#now().toISOString()
    const row: SaasRecord = {
      id: this.#createId(),
      entity: entityName(entity),
      ownerUserId: session.userId,
      payload,
      createdAt: now,
      updatedAt: now,
    }
    this.#rows.set(row.id, row)
    return row
  }

  list(entity: string, request: SaasRequest): readonly SaasRecord[] {
    const session = authorize(request, false)
    const normalizedEntity = entityName(entity)
    return [...this.#rows.values()].filter(row => (
      row.entity === normalizedEntity && (session.role === 'owner' || row.ownerUserId === session.userId)
    ))
  }

  get(id: string, request: SaasRequest): SaasRecord {
    const session = authorize(request, false)
    return visibleRecord(this.#rows.get(id), session)
  }

  update(id: string, input: unknown, request: SaasRequest): SaasRecord {
    const session = authorize(request, true)
    const current = visibleRecord(this.#rows.get(id), session)
    const updated: SaasRecord = {
      ...current,
      payload: payloadObject(input),
      updatedAt: this.#now().toISOString(),
    }
    this.#rows.set(id, updated)
    return updated
  }

  delete(id: string, request: SaasRequest): void {
    const session = authorize(request, true)
    visibleRecord(this.#rows.get(id), session)
    this.#rows.delete(id)
  }
}

export function generateSaasLayer(spec: AppSpecV1, category: StudioProjectCategory): GeneratedSaasLayer {
  if (category !== 'saas-authenticated') return { entities: [], files: [], protectedPaths: [] }
  const databaseEntities = spec.entities
    .filter((entity): entity is Extract<AppSpecV1['entities'][number], { kind: 'database' }> => entity.kind === 'database')
  const entities = databaseEntities.map(entity => dataIdentifier(entity.name))
  if (entities.length === 0) throw new SaasContractError('SAAS_REQUIRES_DATABASE_ENTITY')
  if (new Set(entities).size !== entities.length) throw new SaasContractError('SAAS_ENTITY_IDENTIFIER_COLLISION')
  if (databaseEntities.some(entity => entity.fields.some(field => field.type === 'reference'))) throw new SaasContractError('SAAS_REFERENCE_REQUIRES_SCOPED_SELECTOR')

  const files: GeneratedFile[] = [
    { path: 'src/db/saas-migrations.ts', content: renderMigration() },
    { path: 'src/server/saas/repository.ts', content: renderNodeCompatibleRepository() },
    { path: 'src/server/actions/saas-records.ts', content: renderActions(databaseEntities) },
    { path: 'src/components/generated/saas-panel.tsx', content: renderPanel(databaseEntities) },
    { path: 'src/components/generated/index.ts', content: "export { default as SaasPanel } from './saas-panel'\n" },
    { path: 'tests/generated-saas-isolation.spec.ts', content: renderTest(entities[0]!) },
  ]
  return { entities, files, protectedPaths: files.map(file => file.path) }
}

export async function writeSaasLayer(root: string, layer: GeneratedSaasLayer): Promise<void> {
  for (const file of layer.files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
}

function authorize(request: SaasRequest, mutation: boolean): SaasSession {
  const session = request.session
  if (session === null) throw new SaasAccessError('AUTH_REQUIRED')
  if (session.role !== 'owner' && session.role !== 'member') throw new SaasAccessError('ROLE_FORBIDDEN')
  if (session.userId.trim() === '') throw new SaasAccessError('AUTH_REQUIRED')
  if (mutation && (session.csrf === '' || request.csrfSubmitted !== session.csrf)) throw new SaasAccessError('CSRF')
  return session
}

function visibleRecord(row: SaasRecord | undefined, session: SaasSession): SaasRecord {
  if (row === undefined || (session.role === 'member' && row.ownerUserId !== session.userId)) {
    throw new SaasRecordNotFoundError()
  }
  return row
}

function entityName(value: string): string {
  if (value.normalize('NFKC').trim() === '') throw new SaasContractError('INVALID_SAAS_ENTITY')
  const normalized = dataIdentifier(value)
  if (normalized === '' || normalized.length > 100) throw new SaasContractError('INVALID_SAAS_ENTITY')
  return normalized
}

const AUTHORITY_FIELDS = new Set([
  'owner_user_id', 'ownerUserId', 'user_id', 'userId', 'org_id', 'orgId',
  'tenant_id', 'tenantId', 'role', 'membership', 'permissions',
  '__proto__', 'prototype', 'constructor',
])

function payloadObject(value: unknown): Readonly<Record<string, SaasPayload>> {
  const payload = jsonValue(value, '$')
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaasContractError('SAAS_PAYLOAD_MUST_BE_OBJECT')
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16_384) throw new SaasContractError('SAAS_PAYLOAD_TOO_LARGE')
  return payload as Readonly<Record<string, SaasPayload>>
}

function jsonValue(value: unknown, path: string): SaasPayload {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > 2_000) throw new SaasContractError(`SAAS_STRING_TOO_LARGE:${path}`)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SaasContractError(`INVALID_NUMBER:${path}`)
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new SaasContractError(`SAAS_ARRAY_TOO_LARGE:${path}`)
    return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SaasContractError(`INVALID_JSON_VALUE:${path}`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 100) throw new SaasContractError(`SAAS_OBJECT_TOO_LARGE:${path}`)
  const result: Record<string, SaasPayload> = {}
  for (const [key, entry] of entries) {
    if (AUTHORITY_FIELDS.has(key)) throw new SaasContractError(`AUTHORITY_FIELD_FORBIDDEN:${path}.${key}`)
    if (key.length === 0 || key.length > 100) throw new SaasContractError(`INVALID_PAYLOAD_KEY:${path}`)
    result[key] = jsonValue(entry, `${path}.${key}`)
  }
  return result
}

function renderMigration(): string {
  return `import type { DatabaseSync } from 'node:sqlite'\nexport function migrateSaas(database:DatabaseSync):void{database.exec('PRAGMA foreign_keys = ON');database.exec('BEGIN IMMEDIATE');try{database.exec(${JSON.stringify(`CREATE TABLE IF NOT EXISTS saas_records (id TEXT PRIMARY KEY, entity TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES auth_users(id) ON UPDATE CASCADE ON DELETE RESTRICT, payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS saas_records_owner_entity ON saas_records(owner_user_id,entity,created_at,id);`)});database.exec('COMMIT')}catch(error){database.exec('ROLLBACK');throw error}}\n`
}

function renderRepository(): string {
  const notFound = tGeneratedApp('saas.notFound')
  return `import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
export type SaasPrincipal={readonly userId:string;readonly role:'owner'|'member'}
export interface SaasRow{readonly id:string;readonly entity:string;readonly ownerUserId:string;readonly payload:Readonly<Record<string,unknown>>;readonly createdAt:string;readonly updatedAt:string}
export class SaasRecordNotFoundError extends Error{readonly code='NOT_FOUND';readonly status=404;constructor(){super(${JSON.stringify(notFound)})}}
const authority=new Set(['owner_user_id','ownerUserId','user_id','userId','org_id','orgId','tenant_id','tenantId','role','membership','permissions','__proto__','prototype','constructor'])
function payload(input:unknown,path='$'):unknown{
  if(input===null||typeof input==='boolean')return input
  if(typeof input==='string'){if(input.length>2000)throw new Error('SAAS_STRING_TOO_LARGE');return input}
  if(typeof input==='number'){if(!Number.isFinite(input))throw new Error('INVALID_PAYLOAD');return input}
  if(Array.isArray(input)){if(input.length>100)throw new Error('SAAS_ARRAY_TOO_LARGE');return input.map((value,index)=>payload(value,\`\${path}[\${index}]\`))}
  if(typeof input!=='object'||Object.getPrototypeOf(input)!==Object.prototype)throw new Error('INVALID_PAYLOAD')
  if(Object.keys(input).length>100)throw new Error('SAAS_OBJECT_TOO_LARGE')
  const output=Object.create(null) as Record<string,unknown>
  for(const [key,value] of Object.entries(input)){if(authority.has(key))throw new Error('AUTHORITY_FIELD_FORBIDDEN');output[key]=payload(value,\`\${path}.\${key}\`)}
  return output
}
function encoded(input:unknown):string{const value=JSON.stringify(payload(input));if(Buffer.byteLength(value,'utf8')>16384)throw new Error('SAAS_PAYLOAD_TOO_LARGE');return value}
function decode(row:Record<string,unknown>):SaasRow{return{id:String(row.id),entity:String(row.entity),ownerUserId:String(row.owner_user_id),payload:payload(JSON.parse(String(row.payload))) as Readonly<Record<string,unknown>>,createdAt:String(row.created_at),updatedAt:String(row.updated_at)}}
export class SaasRepository{
  constructor(private readonly database:DatabaseSync){}
  create(entity:string,input:unknown,principal:SaasPrincipal):SaasRow{const now=new Date().toISOString();const id=randomUUID();this.database.prepare('INSERT INTO saas_records (id,entity,owner_user_id,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,entity,principal.userId,encoded(input),now,now);return this.get(id,principal)}
  list(entity:string,principal:SaasPrincipal):readonly SaasRow[]{const rows=(principal.role==='owner'?this.database.prepare('SELECT * FROM saas_records WHERE entity=? ORDER BY created_at,id').all(entity):this.database.prepare('SELECT * FROM saas_records WHERE entity=? AND owner_user_id=? ORDER BY created_at,id').all(entity,principal.userId)) as Record<string,unknown>[];return rows.map(decode)}
  get(id:string,principal:SaasPrincipal):SaasRow{const row=(principal.role==='owner'?this.database.prepare('SELECT * FROM saas_records WHERE id=?').get(id):this.database.prepare('SELECT * FROM saas_records WHERE id=? AND owner_user_id=?').get(id,principal.userId)) as Record<string,unknown>|undefined;if(row===undefined)throw new SaasRecordNotFoundError();return decode(row)}
  update(id:string,input:unknown,principal:SaasPrincipal):SaasRow{this.get(id,principal);const value=encoded(input);const result=(principal.role==='owner'?this.database.prepare('UPDATE saas_records SET payload=?,updated_at=? WHERE id=?').run(value,new Date().toISOString(),id):this.database.prepare('UPDATE saas_records SET payload=?,updated_at=? WHERE id=? AND owner_user_id=?').run(value,new Date().toISOString(),id,principal.userId));if(Number(result.changes)!==1)throw new SaasRecordNotFoundError();return this.get(id,principal)}
  delete(id:string,principal:SaasPrincipal):void{this.get(id,principal);const result=(principal.role==='owner'?this.database.prepare('DELETE FROM saas_records WHERE id=?').run(id):this.database.prepare('DELETE FROM saas_records WHERE id=? AND owner_user_id=?').run(id,principal.userId));if(Number(result.changes)!==1)throw new SaasRecordNotFoundError()}
}
`
}

function renderActions(entities: readonly Extract<AppSpecV1['entities'][number], { kind: 'database' }>[]): string {
  const fields = Object.fromEntries(entities.map(entity => [dataIdentifier(entity.name), entity.fields.map(field => ({ name: dataIdentifier(field.name), type: field.type, required: field.required, ...(field.options === undefined ? {} : { options: field.options }) }))]))
  return `'use server'\nimport { revalidatePath } from 'next/cache'\nimport { requireFormSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { migrateSaas } from '../../db/saas-migrations'\nimport { SaasRepository } from '../saas/repository'\nconst fields=${JSON.stringify(fields)} as const\nfunction text(formData:FormData,name:string):string{const value=formData.get(name);return typeof value==='string'?value.trim():''}\nfunction entity(formData:FormData):keyof typeof fields{const value=text(formData,'entity');if(!Object.hasOwn(fields,value))throw new Error('UNKNOWN_ENTITY');return value as keyof typeof fields}\nfunction fieldValue(formData:FormData,field:{readonly name:string;readonly type:string;readonly required:boolean;readonly options?:readonly string[]}):unknown{const raw=text(formData,field.name);if(field.required&&raw==='')throw new Error('REQUIRED_FIELD');if(raw.length>2000)throw new Error('FIELD_TOO_LARGE');if(raw==='')return '';if(field.type==='number'){const value=Number(raw);if(!Number.isFinite(value))throw new Error('INVALID_NUMBER');return value}if(field.type==='email'&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(raw))throw new Error('INVALID_EMAIL');if(field.type==='date'&&!/^\\d{4}-\\d{2}-\\d{2}$/u.test(raw))throw new Error('INVALID_DATE');if(field.type==='phone'&&!/^[+() 0-9-]{8,24}$/u.test(raw))throw new Error('INVALID_PHONE');if(field.type==='selection'&&!field.options?.includes(raw))throw new Error('INVALID_SELECTION');return raw}\nfunction data(formData:FormData,kind:keyof typeof fields):unknown{const value=Object.fromEntries(fields[kind].map(field=>[field.name,fieldValue(formData,field)]));if(Buffer.byteLength(JSON.stringify(value),'utf8')>16384)throw new Error('SAAS_PAYLOAD_TOO_LARGE');return value}\nexport async function createSaasRecord(formData:FormData):Promise<void>{const session=await requireFormSession(formData,['owner','member']);const kind=entity(formData);const database=openDatabase();try{migrateSaas(database);new SaasRepository(database).create(kind,data(formData,kind),{userId:session.userId,role:session.role})}finally{database.close()}revalidatePath('/')}\nexport async function updateSaasRecord(formData:FormData):Promise<void>{const session=await requireFormSession(formData,['owner','member']);const kind=entity(formData);const database=openDatabase();try{migrateSaas(database);new SaasRepository(database).update(text(formData,'record_id'),data(formData,kind),{userId:session.userId,role:session.role})}finally{database.close()}revalidatePath('/')}\nexport async function deleteSaasRecord(formData:FormData):Promise<void>{const session=await requireFormSession(formData,['owner','member']);const database=openDatabase();try{migrateSaas(database);new SaasRepository(database).delete(text(formData,'record_id'),{userId:session.userId,role:session.role})}finally{database.close()}revalidatePath('/')}\n`
}

function renderNodeCompatibleRepository(): string {
  return renderRepository().replace(
    'constructor(private readonly database:DatabaseSync){}',
    'private readonly database:DatabaseSync;constructor(database:DatabaseSync){this.database=database}',
  )
}

function renderPanel(entities: readonly Extract<AppSpecV1['entities'][number], { kind: 'database' }>[]): string {
  const sections = entities.map(entity => {
    const slug = dataIdentifier(entity.name)
    const inputs = entity.fields.map(field => `<label>${escapeJsx(field.name)}<input name=${JSON.stringify(dataIdentifier(field.name))} type=${JSON.stringify(field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text')}${field.required ? ' required' : ''}/></label>`).join('')
    const editInputs = entity.fields.map(field => `<label>${escapeJsx(field.name)}<input name=${JSON.stringify(dataIdentifier(field.name))} type=${JSON.stringify(field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text')} defaultValue={String(row.payload[${JSON.stringify(dataIdentifier(field.name))}]??'')}${field.required ? ' required' : ''}/></label>`).join('')
    const displayFields = entity.fields.map(field => `<div><dt>${escapeJsx(field.name)}</dt><dd>{String(row.payload[${JSON.stringify(dataIdentifier(field.name))}]??'—')}</dd></div>`).join('')
    return `<section><h2>${escapeJsx(entity.name)}</h2><form action={createSaasRecord} data-testid=${JSON.stringify(`${slug}-saas-form`)}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="entity" value=${JSON.stringify(slug)}/>${inputs}<button type="submit">${tGeneratedApp('common.save')}</button></form><ul data-testid=${JSON.stringify(`${slug}-saas-list`)}>{rows.filter(row=>row.entity===${JSON.stringify(slug)}).map(row=><li key={row.id}><dl>${displayFields}</dl><form action={updateSaasRecord} data-testid={\`${slug}-saas-edit-\${row.id}\`}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="entity" value=${JSON.stringify(slug)}/><input type="hidden" name="record_id" value={row.id}/>${editInputs}<button type="submit">${tGeneratedApp('common.saveChanges')}</button></form><details><summary>${tGeneratedApp('common.delete')}</summary><p>${tGeneratedApp('common.confirmDelete')}</p><form action={deleteSaasRecord}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="record_id" value={row.id}/><button type="submit">${tGeneratedApp('common.confirmDeleteAction')}</button></form></details></li>)}</ul></section>`
  }).join('')
  return `import { csrfForCurrentSession,currentSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { migrateSaas } from '../../db/saas-migrations'\nimport { createSaasRecord,deleteSaasRecord,updateSaasRecord } from '../../server/actions/saas-records'\nimport { SaasRepository } from '../../server/saas/repository'\nimport { AccessPanel,AccountPanel } from './access-panel'\nexport default async function SaasPanel(){const session=await currentSession();if(session===null)return <AccessPanel/>;const csrf=await csrfForCurrentSession();const database=openDatabase();let rows:ReturnType<SaasRepository['list']>=[];try{migrateSaas(database);const repository=new SaasRepository(database);rows=${JSON.stringify(entities.map(entity => dataIdentifier(entity.name)))}.flatMap(entity=>repository.list(entity,{userId:session.userId,role:session.role}))}finally{database.close()}return <main><AccountPanel/><h1>${tGeneratedApp('saas.title')}</h1>${sections}</main>}\n`
}

function escapeJsx(value: string): string { return `{${JSON.stringify(value)}}` }

function renderTest(entity: string): string {
  return `// @vitest-environment node\nimport { DatabaseSync } from 'node:sqlite'\nimport { describe,expect,it } from 'vitest'\nimport { migrateSaas } from '../src/db/saas-migrations'\nimport { SaasRecordNotFoundError,SaasRepository } from '../src/server/saas/repository'\ndescribe('generated SaaS isolation',()=>{it('keeps server ownership, member 404 isolation and owner visibility',()=>{const database=new DatabaseSync(':memory:');try{database.exec(\"PRAGMA foreign_keys=ON; CREATE TABLE auth_users (id TEXT PRIMARY KEY); INSERT INTO auth_users VALUES ('owner-1'),('member-a'),('member-b')\");migrateSaas(database);const repository=new SaasRepository(database);const first=repository.create(${JSON.stringify(entity)},{name:'Record A'},{userId:'member-a',role:'member'});const second=repository.create(${JSON.stringify(entity)},{name:'Record B'},{userId:'member-b',role:'member'});expect(first.ownerUserId).toBe('member-a');expect(repository.list(${JSON.stringify(entity)},{userId:'member-a',role:'member'}).map(row=>row.id)).toEqual([first.id]);expect(repository.list(${JSON.stringify(entity)},{userId:'owner-1',role:'owner'}).map(row=>row.id)).toEqual([first.id,second.id]);for(const action of [()=>repository.get(second.id,{userId:'member-a',role:'member'}),()=>repository.update(second.id,{name:'Attack'},{userId:'member-a',role:'member'}),()=>repository.delete(second.id,{userId:'member-a',role:'member'})])expect(action).toThrow(SaasRecordNotFoundError);expect(()=>repository.create(${JSON.stringify(entity)},{owner_user_id:'member-b'},{userId:'member-a',role:'member'})).toThrow('AUTHORITY_FIELD_FORBIDDEN');expect(()=>repository.create(${JSON.stringify(entity)},JSON.parse('{\"__proto__\":{\"role\":\"owner\"}}'),{userId:'member-a',role:'member'})).toThrow('AUTHORITY_FIELD_FORBIDDEN');expect(repository.get(second.id,{userId:'owner-1',role:'owner'}).ownerUserId).toBe('member-b')}finally{database.close()}})})\n`
}
