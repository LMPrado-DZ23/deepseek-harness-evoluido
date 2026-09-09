import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { requiresFormSubmissionAuth, requiresGeneratedAuth } from './auth-generator.js'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import { tGeneratedApp } from './generated-i18n.js'
import { t } from './i18n.js'
import type { StudioProjectCategory } from './model.js'

export type AcceptanceStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED'
interface FlowCheck {
  form_test_id: string
  list_test_id: string
  marker_field: string
  submit_requires_auth: boolean
  list_requires_auth: boolean
  fields: { name: string; type: 'text' | 'number' | 'date' | 'boolean' | 'email' | 'phone' | 'selection' | 'reference'; required: boolean; options?: string[] }[]
}
export interface AcceptanceCheck {
  readonly id: string
  /**
   * O identificador de máquina (`page:Início`, `entity:Cliente`).
   *
   * Ele é o que os testes gerados casam, e por isso continua existindo — mas
   * ele NÃO é o que a pessoa lê. A tela mostrava esta lista crua, com `:` e
   * `=` e palavra em inglês, na única tela que responde "meu aplicativo faz o
   * que eu pedi?".
   */
  readonly label: string
  /** A mesma conferência em português, para quem não programa. */
  readonly title?: string
  readonly kind: 'language' | 'title' | 'page' | 'section' | 'entity' | 'criterion' | 'flow' | 'auth' | 'crud' | 'scheduling' | 'dashboard' | 'saas'
  readonly expected?: string
  readonly flow?: FlowCheck
  readonly status: AcceptanceStatus
}

const acceptanceStatusSchema = z.enum(['PENDING', 'PASSED', 'FAILED', 'NOT_AUTOMATED'])
const flowCheckSchema = z.object({
  form_test_id: z.string(), list_test_id: z.string(), marker_field: z.string(),
  submit_requires_auth: z.boolean(), list_requires_auth: z.boolean(),
  fields: z.array(z.object({
    name: z.string(), type: z.enum(['text', 'number', 'date', 'boolean', 'email', 'phone', 'selection', 'reference']),
    required: z.boolean(), options: z.array(z.string()).optional(),
  }).strict()),
}).strict()
const acceptanceCheckSchema = z.object({
  id: z.string().min(1).max(160), label: z.string().min(1).max(2_000), title: z.string().min(1).max(2_000).optional(),
  kind: z.enum(['language', 'title', 'page', 'section', 'entity', 'criterion', 'flow', 'auth', 'crud', 'scheduling', 'dashboard', 'saas']),
  expected: z.string().optional(), flow: flowCheckSchema.optional(), status: acceptanceStatusSchema,
}).strict()
export const acceptanceReportSchema = z.object({
  schema_version: z.literal(1), checks: z.array(acceptanceCheckSchema).min(1).max(500),
}).strict()

export function parseAcceptanceReport(value: unknown, expected: readonly AcceptanceCheck[]): readonly AcceptanceCheck[] {
  const report = acceptanceReportSchema.parse(value)
  if (report.checks.length !== expected.length) throw new Error('APPSPEC_REPORT_MISMATCH')
  const actualById = new Map(report.checks.map(check => [check.id, check] as const))
  if (actualById.size !== report.checks.length) throw new Error('APPSPEC_REPORT_MISMATCH')
  for (const expectedCheck of expected) {
    const actual = actualById.get(expectedCheck.id)
    if (actual === undefined) throw new Error('APPSPEC_REPORT_MISMATCH')
    const { status: actualStatus, ...actualStatic } = actual
    const { status: expectedStatus, ...expectedStatic } = acceptanceCheckSchema.parse(expectedCheck)
    if (JSON.stringify(actualStatic) !== JSON.stringify(expectedStatic)) throw new Error('APPSPEC_REPORT_MISMATCH')
    if (expectedStatus === 'NOT_AUTOMATED' ? actualStatus !== 'NOT_AUTOMATED' : actualStatus === 'NOT_AUTOMATED') {
      throw new Error('APPSPEC_REPORT_MISMATCH')
    }
  }
  return report.checks as readonly AcceptanceCheck[]
}

export function acceptanceChecks(spec: AppSpecV1, category: StudioProjectCategory = 'landing-page'): readonly AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [
    { id: 'language', label: `language=${spec.language}`, title: t('checks.titleLanguage'), kind: 'language', expected: spec.language, status: 'PENDING' },
    { id: 'document-title', label: 'document-title', title: t('checks.titleDocument'), kind: 'title', status: 'PENDING' },
  ]
  spec.pages.forEach((page, pageIndex) => {
    checks.push({ id: `page-${pageIndex}`, label: `page:${page.name}`, title: t('checks.titlePage', { name: page.name }), kind: 'page', expected: page.name, status: 'PENDING' })
    page.sections.forEach((section, sectionIndex) => checks.push({ id: `page-${pageIndex}-section-${sectionIndex}`, label: `section:${section}`, title: t('checks.titleSection', { name: section }), kind: 'section', expected: section, status: 'PENDING' }))
  })
  spec.entities.forEach((entity, entityIndex) => {
    checks.push({ id: `entity-${entityIndex}`, label: `entity:${entity.name}`, title: t('checks.titleEntity', { name: entity.name }), kind: 'entity', expected: entity.name, status: 'PENDING' })
    entity.fields.forEach((field, fieldIndex) => checks.push({ id: `entity-${entityIndex}-field-${fieldIndex}`, label: `field:${typeof field === 'string' ? field : field.name}`, title: t('checks.titleField', { name: typeof field === 'string' ? field : field.name }), kind: 'entity', expected: typeof field === 'string' ? field : field.name, status: 'PENDING' }))
  })
  spec.acceptance_criteria.forEach((criterion, index) => {
    const literal = extractLiteral(criterion)
    checks.push({ id: `criterion-${index}`, label: criterion, title: criterion, kind: 'criterion', ...(literal === undefined ? {} : { expected: literal }), status: literal === undefined ? 'NOT_AUTOMATED' : 'PENDING' })
  })
  const authRequired = requiresGeneratedAuth(spec, category)
  if (authRequired) checks.push({ id: 'auth', label: t('checks.auth'), title: t('checks.titleAuth'), kind: 'auth', status: 'PENDING' })
  if (category === 'form-database' || category === 'crud-panel') addDataFlows(checks, spec, category)
  if (category === 'scheduling') checks.push({ id: 'scheduling-no-overlap', label: t('checks.scheduling'), title: t('checks.titleScheduling'), kind: 'scheduling', expected: schedulingSlot(spec), status: 'PENDING' })
  if (category === 'dashboard') addDashboardCheck(checks, spec)
  if (category === 'saas-authenticated') checks.push({ id: 'saas-isolation', label: t('checks.saas'), title: t('checks.titleSaas'), kind: 'saas', status: 'PENDING' })
  return checks
}

function addDashboardCheck(checks: AcceptanceCheck[], spec: AppSpecV1): void {
  const entity = spec.entities.find(value => value.kind === 'database')
  if (entity === undefined || entity.kind !== 'database') return
  const fields = entity.fields.map(field => ({ name: dataIdentifier(field.name), type: field.type, required: field.required, ...(field.options === undefined ? {} : { options: field.options }) }))
  checks.push({
    id: 'dashboard-read-only', label: t('checks.dashboard'), title: t('checks.titleDashboard'), kind: 'dashboard', expected: entity.name,
    flow: { form_test_id: '', list_test_id: '', marker_field: fields[0]?.name ?? 'id', fields, submit_requires_auth: true, list_requires_auth: true },
    status: 'PENDING',
  })
}

function addDataFlows(checks: AcceptanceCheck[], spec: AppSpecV1, category: StudioProjectCategory): void {
  spec.entities.filter(entity => entity.kind === 'database').forEach((entity, index) => {
    const fields = entity.fields.map(field => ({ name: dataIdentifier(field.name), type: field.type, required: field.required, ...(field.options === undefined ? {} : { options: field.options }) }))
    const marker = fields.find(field => ['text', 'email', 'phone'].includes(field.type)) ?? fields[0]!
    const slug = dataIdentifier(entity.name); const crud = category === 'crud-panel'
    const hasReference = fields.some(field => field.type === 'reference')
    checks.push({ id: `${crud ? 'crud' : 'flow'}-${index}`, label: `${crud ? 'crud' : 'fluxo'}:${entity.name}`, title: t(crud ? 'checks.titleCrud' : 'checks.titleFlow', { name: entity.name }), kind: crud ? 'crud' : 'flow', expected: entity.name, flow: { form_test_id: `${slug}-${crud ? 'create-' : ''}form`, list_test_id: `${slug}-list`, marker_field: marker.name, fields, submit_requires_auth: crud || requiresFormSubmissionAuth(spec), list_requires_auth: true }, status: hasReference ? 'NOT_AUTOMATED' : 'PENDING' })
  })
}

export async function writeAcceptanceArtifacts(runDirectory: string, spec: AppSpecV1, category: StudioProjectCategory = 'landing-page'): Promise<void> {
  const checks = acceptanceChecks(spec, category)
  await mkdir(resolve(runDirectory, 'evidence'), { recursive: true }); await mkdir(resolve(runDirectory, 'tests', 'e2e'), { recursive: true })
  await writeFile(resolve(runDirectory, 'evidence', 'appspec-report.json'), `${JSON.stringify({ schema_version: 1, checks }, null, 2)}\n`, 'utf8')
  await writeFile(resolve(runDirectory, 'tests', 'e2e', 'appspec.spec.ts'), generatedPlaywright(checks), 'utf8')
}

function extractLiteral(criterion: string): string | undefined { const match=/["“]([^"”]{2,})["”]/u.exec(criterion); return match?.[1]?.trim()||undefined }

function generatedPlaywright(checks: readonly AcceptanceCheck[]): string {
  const authRequired = checks.some(check => check.kind === 'auth' || check.kind === 'crud' || check.flow?.submit_requires_auth === true || check.flow?.list_requires_auth === true)
  const tests = checks.filter(check => check.status === 'PENDING').map(check => renderCheck(check, authRequired)).join('\n')
  return `import { expect, test } from '@playwright/test'\nimport { readFile, writeFile } from 'node:fs/promises'\nimport { resolve } from 'node:path'\nconst reportPath=resolve(process.cwd(),'evidence/appspec-report.json')\nasync function record(id:string,status:'PASSED'|'FAILED'){const report=JSON.parse(await readFile(reportPath,'utf8'));report.checks=report.checks.map((check:{id:string})=>check.id===id?{...check,status}:check);await writeFile(reportPath,JSON.stringify(report,null,2)+'\\n')}\nasync function checked(id:string,assertion:()=>Promise<void>){try{await assertion();await record(id,'PASSED')}catch(error){await record(id,'FAILED');throw error}}\n${authRequired ? LOGIN_HELPER : ''}\n${tests}\n`
}

const LOGIN_HELPER = `const authStatePath=resolve(process.cwd(),'data/studio-auth-state.json')
async function captured(){try{return JSON.parse(await readFile(resolve(process.cwd(),'data/studio-capture.json'),'utf8')) as Array<{kind:string;email:string;code?:string}>}catch{return []}}
async function loginAsOwner(page:import('@playwright/test').Page){const email='owner@example.test';try{const state=JSON.parse(await readFile(authStatePath,'utf8')) as {cookies:Parameters<ReturnType<typeof page.context>['addCookies']>[0]};await page.context().addCookies(state.cookies);await page.goto('/');if(await page.getByTestId('signed-in-user').count()>0)return}catch{}await page.goto('/');const before=await captured();await page.getByTestId('request-code-form').locator('[name="email"]').fill(email);await page.getByTestId('request-code-form').getByRole('button',{name:${JSON.stringify(tGeneratedApp('auth.requestCode'))}}).click();await expect.poll(async()=>{const items=await captured();return items.length>before.length?[...items].reverse().find(item=>item.kind==='code'&&item.email===email)?.code:undefined}).toMatch(/^\\d{6}$/u);const captures=await captured();const code=[...captures].reverse().find(item=>item.kind==='code'&&item.email===email)?.code;await page.getByTestId('verify-code-form').locator('[name="email"]').fill(email);await page.getByTestId('verify-code-form').locator('[name="code"]').fill(code!);await page.getByTestId('verify-code-form').getByRole('button',{name:${JSON.stringify(tGeneratedApp('auth.submit'))}}).click();await expect(page.getByTestId('signed-in-user')).toContainText(email);await writeFile(authStatePath,JSON.stringify({cookies:await page.context().cookies()}),{encoding:'utf8',mode:0o600})}`

function renderCheck(check: AcceptanceCheck, authRequired: boolean): string {
  const id=JSON.stringify(check.id); const label=JSON.stringify(check.label); const enter=authRequired?'await loginAsOwner(page);':"await page.goto('/');"
  if(check.kind==='language') return `test(${label},async({page})=>checked(${id},async()=>{${enter}await expect(page.locator('html')).toHaveAttribute('lang',${JSON.stringify(check.expected)})}))`
  if(check.kind==='title') return `test(${label},async({page})=>checked(${id},async()=>{${enter}await expect(page).toHaveTitle(/\\S+/u)}))`
  if(check.kind==='auth') return `test(${label},async({page})=>checked(${id},async()=>{await page.goto('/');const denied=await page.evaluate(async()=>fetch('/api/auth/session').then(response=>response.status));expect(denied).toBe(401);await loginAsOwner(page);const allowed=await page.evaluate(async()=>fetch('/api/auth/session').then(response=>response.status));expect(allowed).toBe(200)}))`
  if(check.kind==='flow') return renderFlow(check)
  if(check.kind==='crud') return renderCrud(check)
  if(check.kind==='scheduling') return `test(${label},async()=>checked(${id},async()=>{const { openDatabase }=await import('../../src/db/client');const { migrateScheduling }=await import('../../src/db/scheduling-migration');const { SchedulingRepository }=await import('../../src/server/scheduling/repository');const database=openDatabase();try{migrateScheduling(database);const repository=new SchedulingRepository(database);repository.create({date:'2099-09-04',slot:${JSON.stringify(check.expected)},createdBy:'member'});expect(repository.list({userId:'other',role:'member'})).toEqual([]);const created=repository.list({userId:'owner',role:'owner'})[0]!;expect(created.state).toBe('pending');try{repository.create({date:'2099-09-04',slot:${JSON.stringify(check.expected)},createdBy:'other'});throw new Error('EXPECTED_SLOT_CONFLICT')}catch(error){expect(error).toMatchObject({code:'SLOT_ALREADY_RESERVED'})}repository.transition(String(created.id),'confirmed',{userId:'owner',role:'owner'});expect(repository.list({userId:'member',role:'member'})[0]).toMatchObject({state:'confirmed'});repository.transition(String(created.id),'cancelled',{userId:'member',role:'member'});expect(repository.create({date:'2099-09-04',slot:${JSON.stringify(check.expected)},createdBy:'other'})).toBeUndefined()}finally{database.close()}}))`
  if(check.kind==='dashboard') return renderDashboard(check)
  if(check.kind==='saas') return `test(${label},async()=>checked(${id},async()=>{const { DatabaseSync }=await import('node:sqlite');const { migrateSaas }=await import('../../src/db/saas-migrations');const { SaasRecordNotFoundError,SaasRepository }=await import('../../src/server/saas/repository');const database=new DatabaseSync(':memory:');try{database.exec("PRAGMA foreign_keys=ON;CREATE TABLE auth_users(id TEXT PRIMARY KEY);INSERT INTO auth_users VALUES('owner'),('a'),('b')");migrateSaas(database);const repository=new SaasRepository(database);const row=repository.create('acceptance',{name:'B'},{userId:'b',role:'member'});expect(()=>repository.get(row.id,{userId:'a',role:'member'})).toThrow(SaasRecordNotFoundError);expect(repository.get(row.id,{userId:'owner',role:'owner'}).id).toBe(row.id)}finally{database.close()}}))`
  return `test(${label},async({page})=>checked(${id},async()=>{${enter}await expect(page.getByText(${JSON.stringify(check.expected)},{exact:true}).first()).toBeVisible()}))`
}

function fieldEntries(flow: FlowCheck, marker: string): string[] { return flow.fields.map(field=>{const locator=`form.locator(${JSON.stringify(`[name="${field.name}"]`)})`;if(field.type==='boolean')return `await ${locator}.check()`;if(field.type==='selection')return `await ${locator}.selectOption(${JSON.stringify(field.options?.[0]??'')})`;if(field.type==='reference')return `await ${locator}.selectOption({index:1})`;const value=field.name===flow.marker_field?(field.type==='email'?`${marker}@example.test`:field.type==='phone'?'11987654321':marker):field.type==='number'?'42':field.type==='date'?'2026-09-03':field.type==='email'?`test-${marker}@example.test`:field.type==='phone'?'11987654321':`Value-${field.name}`;return `await ${locator}.fill(${JSON.stringify(value)})`}) }
function markerValue(flow: FlowCheck, marker: string): string { const field=flow.fields.find(value=>value.name===flow.marker_field)!; return field.type==='email'?`${marker}@example.test`:field.type==='phone'?'11987654321':field.type==='number'?'42':field.type==='date'?'2026-09-03':field.type==='selection'?field.options?.[0]??'':field.type==='boolean'?tGeneratedApp('common.yes'):marker }
function schedulingSlot(spec: AppSpecV1): string { const entity=spec.entities.find(value=>value.kind==='database');const slot=entity?.kind==='database'?entity.fields.find(field=>field.type==='selection')?.options?.[0]:undefined;return slot??'09:00' }
function renderFlow(check: AcceptanceCheck): string { const flow=check.flow!;const marker=`DZ23-${check.id}`;const enter=flow.submit_requires_auth?'await loginAsOwner(page);':"await page.goto('/');";const provePrivate=flow.submit_requires_auth?'':`await expect(page.getByTestId(${JSON.stringify(flow.list_test_id)})).toHaveCount(0);await loginAsOwner(page);`;return `test(${JSON.stringify(check.label)},async({page})=>checked(${JSON.stringify(check.id)},async()=>{${enter}const form=page.getByTestId(${JSON.stringify(flow.form_test_id)});${fieldEntries(flow,marker).join(';')};await form.getByRole('button',{name:${JSON.stringify(tGeneratedApp('common.save'))}}).click();${provePrivate}await expect(page.getByTestId(${JSON.stringify(flow.list_test_id)})).toContainText(${JSON.stringify(markerValue(flow,marker))})}))` }
function renderCrud(check: AcceptanceCheck): string { const flow=check.flow!;const marker=`DZ23-${check.id}`;const edited=`${marker}-edited`;const saveChanges=JSON.stringify(tGeneratedApp('common.saveChanges'));return `test(${JSON.stringify(check.label)},async({page})=>checked(${JSON.stringify(check.id)},async()=>{await loginAsOwner(page);const form=page.getByTestId(${JSON.stringify(flow.form_test_id)});${fieldEntries(flow,marker).join(';')};await form.getByRole('button',{name:${JSON.stringify(tGeneratedApp('common.add'))}}).click();let row=page.getByTestId(${JSON.stringify(flow.list_test_id)}).getByRole('listitem').filter({hasText:${JSON.stringify(marker)}});await expect(row).toBeVisible();const edit=row.locator('form').filter({hasText:${saveChanges}});await edit.locator(${JSON.stringify(`[name="${flow.marker_field}"]`)}).fill(${JSON.stringify(edited)});await edit.getByRole('button',{name:${saveChanges}}).click();row=page.getByTestId(${JSON.stringify(flow.list_test_id)}).getByRole('listitem').filter({hasText:${JSON.stringify(edited)}});await expect(row).toBeVisible();page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:${JSON.stringify(tGeneratedApp('common.delete'))}}).click();await expect(page.getByText(${JSON.stringify(edited)},{exact:false})).toHaveCount(0)}))` }
function renderDashboard(check: AcceptanceCheck): string { const flow=check.flow!;const slug=dataIdentifier(check.expected??'registro');const symbol=slug.split('_').map(part=>`${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');const values=Object.fromEntries(flow.fields.map(field=>[field.name,field.type==='number'?42:field.type==='date'?'2099-09-04':field.type==='boolean'?true:field.type==='selection'?field.options?.[0]??'Teste':field.type==='email'?'dashboard@example.test':field.type==='phone'?'11987654321':`DZ23-${field.name}`]));return `test(${JSON.stringify(check.label)},async({page})=>checked(${JSON.stringify(check.id)},async()=>{const { openDatabase }=await import('../../src/db/client');const { ${symbol}Repository }=await import('../../src/server/repositories/${slug}');const database=openDatabase();try{new ${symbol}Repository(database).create(${JSON.stringify(values)})}finally{database.close()}await loginAsOwner(page);await expect(page.getByText('1',{exact:true}).first()).toBeVisible();const tables=page.locator('table');const charts=page.locator('svg[aria-hidden="true"]');expect(await tables.count()).toBeGreaterThan(0);await expect(charts).toHaveCount(await tables.count());await expect(page.locator('main > section form').filter({has:page.locator('input:not([type="hidden"]),select,textarea')})).toHaveCount(0)}))` }
