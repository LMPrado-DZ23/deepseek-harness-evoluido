import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import { tGeneratedApp } from './generated-i18n.js'
import type { GeneratedFile } from './generator.js'
import type { StudioProjectCategory } from './model.js'

type DatabaseEntity = Extract<AppSpecV1['entities'][number], { kind: 'database' }>

export interface DashboardRecord {
  readonly [field: string]: unknown
}

export interface DashboardBucket {
  readonly key: string
  readonly label: string
  readonly count: number
}

export interface DashboardSummary {
  readonly total: number
  readonly bySelection: readonly DashboardBucket[]
  readonly byMonth: readonly DashboardBucket[]
}

export interface GeneratedDashboardLayer {
  readonly files: readonly GeneratedFile[]
  readonly protectedPaths: readonly string[]
}

export class DashboardCategoryError extends Error {
  readonly code = 'DASHBOARD_REQUIRES_DATABASE_ENTITY'
}

const MONTH_NAMES = tGeneratedApp('dashboard.months').split('|')

/**
 * Produces deterministic, read-only aggregates. Missing or invalid values remain
 * visible as an explicit bucket instead of disappearing from the totals.
 */
export function summarizeDashboardRows(
  rows: readonly DashboardRecord[],
  selectionField?: string,
  dateField?: string,
): DashboardSummary {
  return {
    total: rows.length,
    bySelection: selectionField === undefined
      ? []
      : buckets(rows.map(row => selectionValue(row[selectionField]))),
    byMonth: dateField === undefined
      ? []
      : buckets(rows.map(row => monthValue(row[dateField]))),
  }
}

export function generateDashboardLayer(spec: AppSpecV1, category: StudioProjectCategory): GeneratedDashboardLayer {
  if (category !== 'dashboard') return { files: [], protectedPaths: [] }
  const entities = spec.entities.filter((entity): entity is DatabaseEntity => entity.kind === 'database')
  if (entities.length === 0) throw new DashboardCategoryError('Um painel precisa de ao menos um cadastro para resumir.')

  const files: GeneratedFile[] = entities.map(entity => {
    const slug = dataIdentifier(entity.name)
    return {
      path: `src/components/generated/dashboards/${slug}-dashboard.tsx`,
      content: renderDashboard(entity, slug, pascal(slug)),
    }
  })
  files.push({
    path: 'src/components/generated/dashboards/index.ts',
    content: `${entities.map(entity => {
      const slug = dataIdentifier(entity.name)
      return `export { default as ${pascal(slug)}Dashboard } from './${slug}-dashboard'`
    }).join('\n')}\n`,
  })
  return { files, protectedPaths: files.map(file => file.path) }
}

export async function writeDashboardLayer(root: string, layer: GeneratedDashboardLayer): Promise<void> {
  for (const file of layer.files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
}

function buckets(values: readonly { key: string; label: string }[]): readonly DashboardBucket[] {
  const counts = new Map<string, { label: string; count: number }>()
  for (const value of values) {
    const current = counts.get(value.key)
    counts.set(value.key, { label: current?.label ?? value.label, count: (current?.count ?? 0) + 1 })
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareBucketKeys(left, right))
    .map(([key, value]) => ({ key, ...value }))
}

function compareBucketKeys(left: string, right: string): number {
  if (left === '__missing__') return right === '__missing__' ? 0 : 1
  if (right === '__missing__') return -1
  return left < right ? -1 : left > right ? 1 : 0
}

function selectionValue(value: unknown): { key: string; label: string } {
  if (typeof value !== 'string' || value.trim() === '') return { key: '__missing__', label: tGeneratedApp('dashboard.notInformed') }
  const label = value.normalize('NFKC').trim()
  return { key: label.toLocaleLowerCase('pt-BR'), label }
}

function monthValue(value: unknown): { key: string; label: string } {
  if (typeof value !== 'string') return { key: '__missing__', label: tGeneratedApp('dashboard.dateNotInformed') }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/u.exec(value)
  if (match === null) return { key: '__missing__', label: tGeneratedApp('dashboard.dateNotInformed') }
  const month = Number(match[2])
  if (month < 1 || month > 12) return { key: '__missing__', label: tGeneratedApp('dashboard.dateNotInformed') }
  return { key: `${match[1]}-${match[2]}`, label: tGeneratedApp('dashboard.monthOfYear', { month: MONTH_NAMES[month - 1]!, year: match[1]! }) }
}

function renderDashboard(entity: DatabaseEntity, slug: string, symbol: string): string {
  const selectionField = entity.fields.find(field => field.type === 'selection')
  const dateField = entity.fields.find(field => field.type === 'date')
  const selectionColumn = selectionField === undefined ? 'undefined' : JSON.stringify(dataIdentifier(selectionField.name))
  const dateColumn = dateField === undefined ? 'undefined' : JSON.stringify(dataIdentifier(dateField.name))
  const selectionTitle = selectionField === undefined ? tGeneratedApp('dashboard.records') : selectionField.name
  const dateTitle = dateField === undefined ? tGeneratedApp('dashboard.records') : dateField.name
  const copy = {
    title: tGeneratedApp('dashboard.title'),
    summary: tGeneratedApp('dashboard.summary'),
    empty: tGeneratedApp('dashboard.emptyState'),
    notInformed: tGeneratedApp('dashboard.notInformed'),
    dateNotInformed: tGeneratedApp('dashboard.dateNotInformed'),
    groupBy: tGeneratedApp('dashboard.groupBy', { field: '__FIELD__' }),
    groupCaption: tGeneratedApp('dashboard.groupCaption', { field: '__FIELD__' }),
    count: tGeneratedApp('dashboard.count'),
    singular: tGeneratedApp('dashboard.recordSingular'),
    plural: tGeneratedApp('dashboard.recordPlural'),
    totalSuffix: tGeneratedApp('dashboard.totalSuffix'),
    months: MONTH_NAMES,
    monthTemplate: tGeneratedApp('dashboard.monthOfYear', { month: '__MONTH__', year: '__YEAR__' }),
  }

  return `import { currentSession } from '../../../auth/runtime'
import { openDatabase } from '../../../db/client'
import { ${symbol}Repository } from '../../../server/repositories/${slug}'
import { AccessPanel, AccountPanel } from '../access-panel'

type Row = Record<string, unknown>
type Bucket = { key: string; label: string; count: number }
const copy=${JSON.stringify(copy)} as const
function message(template:string,values:Readonly<Record<string,string>>):string{return Object.entries(values).reduce((value,[key,replacement])=>value.replaceAll(key,replacement),template)}
function grouped(rows:readonly Row[],field:string|undefined,kind:'selection'|'month'):readonly Bucket[]{if(field===undefined)return [];const counts=new Map<string,{label:string,count:number}>();for(const row of rows){const raw=row[field];let key='__missing__';let label:string=kind==='month'?copy.dateNotInformed:copy.notInformed;if(kind==='selection'&&typeof raw==='string'&&raw.trim()!==''){label=raw.normalize('NFKC').trim();key=label.toLocaleLowerCase('pt-BR')}else if(kind==='month'&&typeof raw==='string'){const match=/^(\\d{4})-(\\d{2})-(\\d{2})(?:T|$)/u.exec(raw);const month=match===null?0:Number(match[2]);if(match!==null&&month>=1&&month<=12){key=\`${'${match[1]}'}-${'${match[2]}'}\`;label=message(copy.monthTemplate,{__MONTH__:copy.months[month-1]!,__YEAR__:match[1]!})}}const current=counts.get(key);counts.set(key,{label:current?.label??label,count:(current?.count??0)+1})}return [...counts.entries()].sort(([a],[b])=>a==='__missing__'?(b==='__missing__'?0:1):b==='__missing__'?-1:a<b?-1:a>b?1:0).map(([key,value])=>({key,...value}))}
function Distribution({id,title,buckets}:{id:string;title:string;buckets:readonly Bucket[]}){if(buckets.length===0)return null;const maximum=Math.max(...buckets.map(bucket=>bucket.count),1);return <section aria-labelledby={id}><h2 id={id}>{message(copy.groupBy,{__FIELD__:title})}</h2><svg aria-hidden="true" focusable="false" viewBox={\`0 0 100 ${'${Math.max(24,buckets.length*24)}'}\`}>{buckets.map((bucket,index)=><rect key={bucket.key} x="0" y={index*24} width={(bucket.count/maximum)*100} height="16" rx="2"/>)}</svg><table><caption>{message(copy.groupCaption,{__FIELD__:title})}</caption><thead><tr><th scope="col">{title}</th><th scope="col">{copy.count}</th></tr></thead><tbody>{buckets.map(bucket=><tr key={bucket.key}><th scope="row">{bucket.label}</th><td>{bucket.count}</td></tr>)}</tbody></table></section>}
export default async function ${symbol}Dashboard(){const session=await currentSession();if(session===null)return <AccessPanel/>;const database=openDatabase();let rows:readonly Row[];try{rows=new ${symbol}Repository(database).list() as readonly Row[]}finally{database.close()}const bySelection=grouped(rows,${selectionColumn},'selection');const byMonth=grouped(rows,${dateColumn},'month');return <main><AccountPanel/><h1>{copy.title} · ${jsx(entity.name)}</h1><section aria-labelledby=${JSON.stringify(`${slug}-dashboard-summary`)}><h2 id=${JSON.stringify(`${slug}-dashboard-summary`)}>{copy.summary}</h2><p><strong>{rows.length}</strong> {rows.length===1?copy.singular:copy.plural} {copy.totalSuffix}</p></section>{rows.length===0?<p role="status">{copy.empty}</p>:<><Distribution id=${JSON.stringify(`${slug}-dashboard-selection`)} title=${jsx(selectionTitle)} buckets={bySelection}/><Distribution id=${JSON.stringify(`${slug}-dashboard-month`)} title=${jsx(dateTitle)} buckets={byMonth}/></>}</main>}
`
}

function jsx(value: string): string { return `{${JSON.stringify(value)}}` }
function pascal(value: string): string { return value.split('_').map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('') }
