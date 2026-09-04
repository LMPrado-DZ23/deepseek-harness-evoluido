import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import { tGeneratedApp } from './generated-i18n.js'
import type { GeneratedFile } from './generator.js'

type DatabaseEntity = Extract<AppSpecV1['entities'][number], { kind: 'database' }>
type DatabaseField = DatabaseEntity['fields'][number]

export type SchedulingState = 'pending' | 'confirmed' | 'cancelled'
export type SchedulingRole = 'owner' | 'member'

export interface SchedulingSession {
  readonly userId: string
  readonly role: SchedulingRole
  readonly csrf: string
}

export interface SchedulingRequest {
  readonly session: SchedulingSession | null
  readonly csrfSubmitted: string | undefined
}

export interface SchedulingReservation {
  readonly id: string
  readonly date: string
  readonly slot: string
  readonly state: SchedulingState
  readonly createdBy: string
}

export interface SchedulingContract {
  readonly entity: string
  readonly dateField: string
  readonly slotField: string
  readonly slots: readonly string[]
}

export interface GeneratedSchedulingLayer {
  readonly contract: SchedulingContract
  readonly files: readonly GeneratedFile[]
  readonly protectedPaths: readonly string[]
}

export class SchedulingContractError extends Error {
  readonly code = 'INVALID_SCHEDULING_CONTRACT'
}

export class SchedulingAccessError extends Error {
  readonly code: 'AUTH_REQUIRED' | 'ROLE_FORBIDDEN' | 'CSRF'

  constructor(code: SchedulingAccessError['code']) {
    super(code)
    this.code = code
  }
}

export class SchedulingConflictError extends Error {
  readonly code = 'SLOT_ALREADY_RESERVED'

  constructor() {
    super(tGeneratedApp('scheduling.conflict'))
  }
}

export class SchedulingTransitionError extends Error {
  readonly code = 'INVALID_SCHEDULING_TRANSITION'
}

/**
 * Executable reference contract used by the generator tests and by adapters that
 * need the same fail-closed scheduling semantics before persistence is wired.
 */
export class SchedulingDomain {
  readonly #rows = new Map<string, SchedulingReservation>()
  readonly #occupied = new Set<string>()
  readonly #slots: ReadonlySet<string>
  readonly #createId: () => string

  constructor(slots: readonly string[], createId: () => string = randomUUID) {
    const normalized = slots.map(slot => slot.normalize('NFKC').trim()).filter(Boolean)
    if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
      throw new SchedulingContractError('SCHEDULING_SLOTS_MUST_BE_UNIQUE')
    }
    this.#slots = new Set(normalized)
    this.#createId = createId
  }

  create(input: unknown, request: SchedulingRequest): SchedulingReservation {
    const session = authorize(request)
    const value = schedulingInput(input)
    if (!this.#slots.has(value.slot)) throw new SchedulingContractError('SCHEDULING_SLOT_NOT_ALLOWED')
    const key = occupancyKey(value.date, value.slot)
    if (this.#occupied.has(key)) throw new SchedulingConflictError()
    const row: SchedulingReservation = {
      id: this.#createId(),
      date: value.date,
      slot: value.slot,
      state: 'pending',
      createdBy: session.userId,
    }
    this.#rows.set(row.id, row)
    this.#occupied.add(key)
    return row
  }

  transition(id: string, action: 'confirm' | 'cancel', request: SchedulingRequest): SchedulingReservation {
    const session = authorize(request)
    const current = this.#rows.get(id)
    if (current === undefined || (session.role === 'member' && current.createdBy !== session.userId)) throw new SchedulingTransitionError('RESERVATION_NOT_FOUND')
    if (session.role === 'member' && action === 'confirm') throw new SchedulingTransitionError('ROLE_FORBIDDEN')
    const next: SchedulingState = action === 'confirm' ? 'confirmed' : 'cancelled'
    const allowed = current.state === 'pending' || (current.state === 'confirmed' && next === 'cancelled')
    if (!allowed) throw new SchedulingTransitionError(`INVALID_TRANSITION:${current.state}:${next}`)
    const updated = { ...current, state: next }
    this.#rows.set(id, updated)
    if (next === 'cancelled') this.#occupied.delete(occupancyKey(current.date, current.slot))
    return updated
  }

  list(request: SchedulingRequest): readonly SchedulingReservation[] {
    const session = authorize(request)
    return [...this.#rows.values()].filter(row => session.role === 'owner' || row.createdBy === session.userId)
  }
}

export function schedulingContract(spec: AppSpecV1): SchedulingContract {
  const entities = spec.entities.filter((entity): entity is DatabaseEntity => entity.kind === 'database')
  if (entities.length !== 1) throw new SchedulingContractError('SCHEDULING_REQUIRES_EXACTLY_ONE_DATABASE_ENTITY')
  const entity = entities[0]!
  const dateFields = entity.fields.filter(field => field.type === 'date')
  const slotFields = entity.fields.filter(field => field.type === 'selection')
  if (dateFields.length !== 1) throw new SchedulingContractError('SCHEDULING_REQUIRES_EXACTLY_ONE_DATE_FIELD')
  if (slotFields.length !== 1) throw new SchedulingContractError('SCHEDULING_REQUIRES_EXACTLY_ONE_SLOT_FIELD')
  const date = dateFields[0]!
  const slot = slotFields[0]!
  if (!date.required || !slot.required) throw new SchedulingContractError('SCHEDULING_DATE_AND_SLOT_MUST_BE_REQUIRED')
  if (entity.fields.some(field => systemStateName(field.name))) {
    throw new SchedulingContractError('SCHEDULING_STATE_IS_SYSTEM_OWNED')
  }
  if (entity.fields.length !== 2) throw new SchedulingContractError('SCHEDULING_SUPPORTS_DATE_AND_SLOT_ONLY')
  const slots = [...new Set(slot.options?.map(value => value.normalize('NFKC').trim()).filter(Boolean) ?? [])]
  if (slots.length === 0 || slots.length !== slot.options?.length) {
    throw new SchedulingContractError('SCHEDULING_SLOTS_MUST_BE_UNIQUE')
  }
  return { entity: entity.name, dateField: date.name, slotField: slot.name, slots }
}

export function generateSchedulingLayer(spec: AppSpecV1): GeneratedSchedulingLayer {
  const contract = schedulingContract(spec)
  const entity = spec.entities.find((candidate): candidate is DatabaseEntity => candidate.kind === 'database')!
  const date = entity.fields.find(field => field.type === 'date')!
  const slot = entity.fields.find(field => field.type === 'selection')!
  const names = {
    table: `scheduling_${dataIdentifier(entity.name)}`,
    date: dataIdentifier(date.name),
    slot: dataIdentifier(slot.name),
  }
  const files: GeneratedFile[] = [
    { path: 'src/db/scheduling-migration.ts', content: renderMigration(names) },
    { path: 'src/server/scheduling/repository.ts', content: renderNodeCompatibleRepository(names) },
    { path: 'src/server/actions/scheduling.ts', content: renderActions(names, contract.slots) },
    { path: 'src/components/generated/scheduling-panel.tsx', content: renderPanel(names, contract) },
  ]
  return { contract, files, protectedPaths: files.map(file => file.path) }
}

export async function writeSchedulingLayer(root: string, layer: GeneratedSchedulingLayer): Promise<void> {
  for (const file of layer.files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
}

function authorize(request: SchedulingRequest): SchedulingSession {
  if (request.session === null) throw new SchedulingAccessError('AUTH_REQUIRED')
  if (request.session.role !== 'owner' && request.session.role !== 'member') throw new SchedulingAccessError('ROLE_FORBIDDEN')
  if (request.session.csrf === '' || request.csrfSubmitted !== request.session.csrf) throw new SchedulingAccessError('CSRF')
  return request.session
}

function schedulingInput(input: unknown): { date: string; slot: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new SchedulingContractError('INVALID_SCHEDULING_INPUT')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => key !== 'date' && key !== 'slot')) throw new SchedulingContractError('SYSTEM_FIELD_IN_SCHEDULING_INPUT')
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.date)) throw new SchedulingContractError('INVALID_SCHEDULING_DATE')
  if (typeof value.slot !== 'string' || value.slot.trim() === '') throw new SchedulingContractError('INVALID_SCHEDULING_SLOT')
  return { date: value.date, slot: value.slot.normalize('NFKC').trim() }
}

function occupancyKey(date: string, slot: string): string {
  return `${date}\u0000${slot.normalize('NFKC').trim()}`
}

function systemStateName(value: string): boolean {
  return /^(?:state|status|estado)$/u.test(dataIdentifier(value))
}

function renderMigration(names: { table: string; date: string; slot: string }): string {
  const table = quoteId(names.table)
  const date = quoteId(names.date)
  const slot = quoteId(names.slot)
  return `import type { DatabaseSync } from 'node:sqlite'\nexport function migrateScheduling(database:DatabaseSync):void{database.exec(${JSON.stringify(`CREATE TABLE IF NOT EXISTS ${table} ("id" TEXT PRIMARY KEY, ${date} TEXT NOT NULL, ${slot} TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','confirmed','cancelled')), "created_by" TEXT NOT NULL, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS ${quoteId(`${names.table}_active_slot`)} ON ${table} (${date}, ${slot}) WHERE "state" <> 'cancelled';`)})}\n`
}

function renderRepository(names: { table: string; date: string; slot: string }): string {
  const table = quoteId(names.table)
  const date = quoteId(names.date)
  const slot = quoteId(names.slot)
  const conflict = tGeneratedApp('scheduling.conflict')
  return `import { randomUUID } from 'node:crypto'\nimport type { DatabaseSync } from 'node:sqlite'\nexport type SchedulingState='pending'|'confirmed'|'cancelled'\nexport type SchedulingPrincipal={readonly userId:string;readonly role:'owner'|'member'}\nexport class SchedulingConflictError extends Error{readonly code='SLOT_ALREADY_RESERVED';constructor(){super(${JSON.stringify(conflict)})}}\nexport class SchedulingRepository{constructor(private readonly database:DatabaseSync){}create(input:{date:string;slot:string;createdBy:string}){const now=new Date().toISOString();try{this.database.prepare(${JSON.stringify(`INSERT INTO ${table} ("id",${date},${slot},"state","created_by","created_at","updated_at") VALUES (@id,@date,@slot,'pending',@createdBy,@now,@now)`) }).run({id:randomUUID(),...input,now})}catch(error){if(error instanceof Error&&'code' in error&&String(error.code).startsWith('SQLITE_CONSTRAINT'))throw new SchedulingConflictError();throw error}}transition(id:string,target:Exclude<SchedulingState,'pending'>,principal:SchedulingPrincipal){if(principal.role==='member'&&target==='confirmed')throw new Error(${JSON.stringify(tGeneratedApp('scheduling.invalidTransition'))});const allowed=target==='confirmed'?\`"state"='pending'\`:\`"state" IN ('pending','confirmed')\`;const ownership=principal.role==='owner'?'':\` AND "created_by"=?\`;const parameters=principal.role==='owner'?[target,new Date().toISOString(),id]:[target,new Date().toISOString(),id,principal.userId];const result=this.database.prepare(\`UPDATE ${table} SET "state"=?,"updated_at"=? WHERE "id"=? AND \${allowed}\${ownership}\`).run(...parameters);if(Number(result.changes)!==1)throw new Error(${JSON.stringify(tGeneratedApp('scheduling.invalidTransition'))})}list(principal:SchedulingPrincipal){return (principal.role==='owner'?this.database.prepare(${JSON.stringify(`SELECT "id",${date} AS "date",${slot} AS "slot","state","created_by" AS "createdBy" FROM ${table} ORDER BY ${date},${slot}`)}).all():this.database.prepare(${JSON.stringify(`SELECT "id",${date} AS "date",${slot} AS "slot","state","created_by" AS "createdBy" FROM ${table} WHERE "created_by"=? ORDER BY ${date},${slot}`)}).all(principal.userId))}}\n`
}

function renderActions(names: { date: string; slot: string }, slots: readonly string[]): string {
  return `'use server'\nimport { revalidatePath } from 'next/cache'\nimport { requireFormSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { migrateScheduling } from '../../db/scheduling-migration'\nimport { SchedulingRepository } from '../scheduling/repository'\nconst slots=new Set(${JSON.stringify(slots)} as readonly string[])\nfunction text(formData:FormData,name:string):string{const value=formData.get(name);return typeof value==='string'?value.trim():''}\nexport async function createReservation(formData:FormData):Promise<void>{const session=await requireFormSession(formData,['owner','member']);const date=text(formData,${JSON.stringify(names.date)});const slot=text(formData,${JSON.stringify(names.slot)});if(!/^\\d{4}-\\d{2}-\\d{2}$/u.test(date)||!slots.has(slot))throw new Error(${JSON.stringify(tGeneratedApp('scheduling.invalidDate'))});if(date<new Date().toISOString().slice(0,10))throw new Error(${JSON.stringify(tGeneratedApp('scheduling.pastDate'))});const database=openDatabase();try{migrateScheduling(database);new SchedulingRepository(database).create({date,slot,createdBy:session.userId})}finally{database.close()}revalidatePath('/')}\nasync function changeReservation(formData:FormData,target:'confirmed'|'cancelled'):Promise<void>{const session=await requireFormSession(formData,target==='confirmed'?['owner']:['owner','member']);const database=openDatabase();try{migrateScheduling(database);new SchedulingRepository(database).transition(text(formData,'id'),target,{userId:session.userId,role:session.role})}finally{database.close()}revalidatePath('/')}\nexport async function confirmReservation(formData:FormData):Promise<void>{return changeReservation(formData,'confirmed')}\nexport async function cancelReservation(formData:FormData):Promise<void>{return changeReservation(formData,'cancelled')}\n`
}

function renderNodeCompatibleRepository(names: { table: string; date: string; slot: string }): string {
  return renderRepository(names).replace(
    'constructor(private readonly database:DatabaseSync){}',
    'private readonly database:DatabaseSync;constructor(database:DatabaseSync){this.database=database}',
  )
}

function renderPanel(names: { date: string; slot: string }, contract: SchedulingContract): string {
  const options = contract.slots.map(slot => `<option value=${JSON.stringify(slot)}>${escapeJsx(slot)}</option>`).join('')
  const statusLabels = JSON.stringify({
    pending: tGeneratedApp('scheduling.statusPending'),
    confirmed: tGeneratedApp('scheduling.statusConfirmed'),
    cancelled: tGeneratedApp('scheduling.statusCancelled'),
  })
  return `import { csrfForCurrentSession,currentSession } from '../../auth/runtime'\nimport { openDatabase } from '../../db/client'\nimport { migrateScheduling } from '../../db/scheduling-migration'\nimport { cancelReservation,confirmReservation,createReservation } from '../../server/actions/scheduling'\nimport { SchedulingRepository,type SchedulingState } from '../../server/scheduling/repository'\nimport { AccessPanel,AccountPanel } from './access-panel'\nconst statusLabels=${statusLabels} satisfies Readonly<Record<SchedulingState,string>>\nexport default async function SchedulingPanel(){const session=await currentSession();if(session===null)return <AccessPanel/>;const csrf=await csrfForCurrentSession();const today=new Date().toISOString().slice(0,10);const database=openDatabase();let rows:ReturnType<SchedulingRepository['list']>;try{migrateScheduling(database);rows=new SchedulingRepository(database).list({userId:session.userId,role:session.role})}finally{database.close()}return <main><AccountPanel/><h1>{${JSON.stringify(tGeneratedApp('scheduling.title'))}}</h1><form action={createReservation}><input type="hidden" name="_csrf" value={csrf}/><label>${escapeJsx(contract.dateField)}<input type="date" min={today} name=${JSON.stringify(names.date)} required/></label><label>${escapeJsx(contract.slotField)}<select name=${JSON.stringify(names.slot)} required><option value="">${tGeneratedApp('reference.choose')}</option>${options}</select></label><button type="submit">{${JSON.stringify(tGeneratedApp('scheduling.create'))}}</button></form>{rows.length===0?<p>{${JSON.stringify(tGeneratedApp('scheduling.emptyState'))}}</p>:<ul>{rows.map(row=><li key={String(row.id)}>{String(row.date)} · {String(row.slot)} · {statusLabels[row.state as SchedulingState]}{session.role==='owner'&&row.state==='pending'?<form action={confirmReservation}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="id" value={String(row.id)}/><button type="submit">{${JSON.stringify(tGeneratedApp('scheduling.confirm'))}}</button></form>:null}{row.state==='cancelled'?null:<form action={cancelReservation}><input type="hidden" name="_csrf" value={csrf}/><input type="hidden" name="id" value={String(row.id)}/><button type="submit">{${JSON.stringify(tGeneratedApp('common.cancel'))}}</button></form>}</li>)}</ul>}</main>}\n`
}

function quoteId(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function escapeJsx(value: string): string {
  return `{${JSON.stringify(value)}}`
}
