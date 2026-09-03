import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requiresFormSubmissionAuth, requiresGeneratedAuth } from './auth-generator.js'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
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
  readonly label: string
  readonly kind: 'language' | 'title' | 'page' | 'section' | 'entity' | 'criterion' | 'flow' | 'auth' | 'crud'
  readonly expected?: string
  readonly flow?: FlowCheck
  readonly status: AcceptanceStatus
}

export function acceptanceChecks(spec: AppSpecV1, category: StudioProjectCategory = 'landing-page'): readonly AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [
    { id: 'language', label: `language=${spec.language}`, kind: 'language', expected: spec.language, status: 'PENDING' },
    { id: 'document-title', label: 'document-title', kind: 'title', status: 'PENDING' },
  ]
  spec.pages.forEach((page, pageIndex) => {
    checks.push({ id: `page-${pageIndex}`, label: `page:${page.name}`, kind: 'page', expected: page.name, status: 'PENDING' })
    page.sections.forEach((section, sectionIndex) => checks.push({ id: `page-${pageIndex}-section-${sectionIndex}`, label: `section:${section}`, kind: 'section', expected: section, status: 'PENDING' }))
  })
  spec.entities.forEach((entity, entityIndex) => {
    checks.push({ id: `entity-${entityIndex}`, label: `entity:${entity.name}`, kind: 'entity', expected: entity.name, status: 'PENDING' })
    entity.fields.forEach((field, fieldIndex) => checks.push({ id: `entity-${entityIndex}-field-${fieldIndex}`, label: `field:${typeof field === 'string' ? field : field.name}`, kind: 'entity', expected: typeof field === 'string' ? field : field.name, status: 'PENDING' }))
  })
  spec.acceptance_criteria.forEach((criterion, index) => {
    const literal = extractLiteral(criterion)
    checks.push({ id: `criterion-${index}`, label: criterion, kind: 'criterion', ...(literal === undefined ? {} : { expected: literal }), status: literal === undefined ? 'NOT_AUTOMATED' : 'PENDING' })
  })
  const authRequired = requiresGeneratedAuth(spec, category)
  if (authRequired) checks.push({ id: 'auth', label: 'acesso:sem-sessão-401-e-login-por-código', kind: 'auth', status: 'PENDING' })
  if (category === 'form-database' || category === 'crud-panel') addDataFlows(checks, spec, category)
  return checks
}

function addDataFlows(checks: AcceptanceCheck[], spec: AppSpecV1, category: StudioProjectCategory): void {
  spec.entities.filter(entity => entity.kind === 'database').forEach((entity, index) => {
    const fields = entity.fields.filter(field => field.type !== 'reference').map(field => ({ name: dataIdentifier(field.name), type: field.type, required: field.required, ...(field.options === undefined ? {} : { options: field.options }) }))
    const marker = fields.find(field => ['text', 'email', 'phone'].includes(field.type)) ?? fields[0]!
    const slug = dataIdentifier(entity.name); const crud = category === 'crud-panel'
    checks.push({ id: `${crud ? 'crud' : 'flow'}-${index}`, label: `${crud ? 'crud' : 'fluxo'}:${entity.name}`, kind: crud ? 'crud' : 'flow', expected: entity.name, flow: { form_test_id: `${slug}-${crud ? 'create-' : ''}form`, list_test_id: `${slug}-list`, marker_field: marker.name, fields, submit_requires_auth: crud || requiresFormSubmissionAuth(spec), list_requires_auth: true }, status: 'PENDING' })
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
async function loginAsOwner(page:import('@playwright/test').Page){const email='owner@example.test';try{const state=JSON.parse(await readFile(authStatePath,'utf8')) as {cookies:Parameters<ReturnType<typeof page.context>['addCookies']>[0]};await page.context().addCookies(state.cookies);await page.goto('/');if(await page.getByTestId('signed-in-user').count()>0)return}catch{}await page.goto('/');const before=await captured();await page.getByTestId('request-code-form').locator('[name="email"]').fill(email);await page.getByTestId('request-code-form').getByRole('button',{name:'Enviar código'}).click();await expect.poll(async()=>{const items=await captured();return items.length>before.length?[...items].reverse().find(item=>item.kind==='code'&&item.email===email)?.code:undefined}).toMatch(/^\\d{6}$/u);const captures=await captured();const code=[...captures].reverse().find(item=>item.kind==='code'&&item.email===email)?.code;await page.getByTestId('verify-code-form').locator('[name="email"]').fill(email);await page.getByTestId('verify-code-form').locator('[name="code"]').fill(code!);await page.getByTestId('verify-code-form').getByRole('button',{name:'Entrar'}).click();await expect(page.getByTestId('signed-in-user')).toContainText(email);await writeFile(authStatePath,JSON.stringify({cookies:await page.context().cookies()}),{encoding:'utf8',mode:0o600})}`

function renderCheck(check: AcceptanceCheck, authRequired: boolean): string {
  const id=JSON.stringify(check.id); const label=JSON.stringify(check.label); const enter=authRequired?'await loginAsOwner(page);':"await page.goto('/');"
  if(check.kind==='language') return `test(${label},async({page})=>checked(${id},async()=>{${enter}await expect(page.locator('html')).toHaveAttribute('lang',${JSON.stringify(check.expected)})}))`
  if(check.kind==='title') return `test(${label},async({page})=>checked(${id},async()=>{${enter}await expect(page).toHaveTitle(/\\S+/u)}))`
  if(check.kind==='auth') return `test(${label},async({page})=>checked(${id},async()=>{await page.goto('/');const denied=await page.evaluate(async()=>fetch('/api/auth/session').then(response=>response.status));expect(denied).toBe(401);await loginAsOwner(page);const allowed=await page.evaluate(async()=>fetch('/api/auth/session').then(response=>response.status));expect(allowed).toBe(200)}))`
  if(check.kind==='flow') return renderFlow(check)
  if(check.kind==='crud') return renderCrud(check)
  return `test(${label},async({page})=>checked(${id},async()=>{${enter}await expect(page.getByText(${JSON.stringify(check.expected)},{exact:true}).first()).toBeVisible()}))`
}

function fieldEntries(flow: FlowCheck, marker: string): string[] { return flow.fields.map(field=>{const locator=`form.locator(${JSON.stringify(`[name="${field.name}"]`)})`;if(field.type==='boolean')return `await ${locator}.check()`;if(field.type==='selection')return `await ${locator}.selectOption(${JSON.stringify(field.options?.[0]??'')})`;const value=field.name===flow.marker_field?(field.type==='email'?`${marker}@example.test`:field.type==='phone'?'11987654321':marker):field.type==='number'?'42':field.type==='date'?'2026-09-03':field.type==='email'?`teste-${marker}@example.test`:field.type==='phone'?'11987654321':`Valor-${field.name}`;return `await ${locator}.fill(${JSON.stringify(value)})`}) }
function markerValue(flow: FlowCheck, marker: string): string { const field=flow.fields.find(value=>value.name===flow.marker_field)!; return field.type==='email'?`${marker}@example.test`:field.type==='phone'?'11987654321':field.type==='number'?'42':field.type==='date'?'2026-09-03':field.type==='selection'?field.options?.[0]??'':field.type==='boolean'?'Sim':marker }
function renderFlow(check: AcceptanceCheck): string { const flow=check.flow!;const marker=`DZ23-${check.id}`;const enter=flow.submit_requires_auth?'await loginAsOwner(page);':"await page.goto('/');";const provePrivate=flow.submit_requires_auth?'':`await expect(page.getByTestId(${JSON.stringify(flow.list_test_id)})).toHaveCount(0);await loginAsOwner(page);`;return `test(${JSON.stringify(check.label)},async({page})=>checked(${JSON.stringify(check.id)},async()=>{${enter}const form=page.getByTestId(${JSON.stringify(flow.form_test_id)});${fieldEntries(flow,marker).join(';')};await form.getByRole('button',{name:'Salvar'}).click();${provePrivate}await expect(page.getByTestId(${JSON.stringify(flow.list_test_id)})).toContainText(${JSON.stringify(markerValue(flow,marker))})}))` }
function renderCrud(check: AcceptanceCheck): string { const flow=check.flow!;const marker=`DZ23-${check.id}`;const edited=`${marker}-editado`;return `test(${JSON.stringify(check.label)},async({page})=>checked(${JSON.stringify(check.id)},async()=>{await loginAsOwner(page);const form=page.getByTestId(${JSON.stringify(flow.form_test_id)});${fieldEntries(flow,marker).join(';')};await form.getByRole('button',{name:'Adicionar'}).click();let row=page.getByTestId(${JSON.stringify(flow.list_test_id)}).getByRole('listitem').filter({hasText:${JSON.stringify(marker)}});await expect(row).toBeVisible();const edit=row.locator('form').filter({hasText:'Salvar alterações'});await edit.locator(${JSON.stringify(`[name="${flow.marker_field}"]`)}).fill(${JSON.stringify(edited)});await edit.getByRole('button',{name:'Salvar alterações'}).click();row=page.getByTestId(${JSON.stringify(flow.list_test_id)}).getByRole('listitem').filter({hasText:${JSON.stringify(edited)}});await expect(row).toBeVisible();page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'Excluir'}).click();await expect(page.getByText(${JSON.stringify(edited)},{exact:false})).toHaveCount(0)}))` }
