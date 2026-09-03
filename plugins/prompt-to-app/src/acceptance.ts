import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'
import { dataIdentifier } from './data-generator.js'
import type { StudioProjectCategory } from './model.js'

export type AcceptanceStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED'
export interface AcceptanceCheck {
  readonly id: string
  readonly label: string
  readonly kind: 'language' | 'title' | 'page' | 'section' | 'entity' | 'criterion' | 'flow'
  readonly expected?: string
  readonly flow?: {
    readonly form_test_id: string
    readonly list_test_id: string
    readonly marker_field: string
    readonly fields: { name: string; type: 'text' | 'number' | 'date' | 'boolean' | 'email' | 'phone' | 'selection' | 'reference'; required: boolean; options?: string[] }[]
  }
  readonly status: AcceptanceStatus
}

export function acceptanceChecks(spec: AppSpecV1, category: StudioProjectCategory = 'landing-page'): readonly AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [
    { id: 'language', label: `language=${spec.language}`, kind: 'language', expected: spec.language, status: 'PENDING' },
    { id: 'document-title', label: 'document-title', kind: 'title', status: 'PENDING' },
  ]
  spec.pages.forEach((page, pageIndex) => {
    checks.push({ id: `page-${pageIndex}`, label: `page:${page.name}`, kind: 'page', expected: page.name, status: 'PENDING' })
    page.sections.forEach((section, sectionIndex) => checks.push({
      id: `page-${pageIndex}-section-${sectionIndex}`, label: `section:${section}`, kind: 'section', expected: section, status: 'PENDING',
    }))
  })
  spec.entities.forEach((entity, entityIndex) => {
    checks.push({ id: `entity-${entityIndex}`, label: `entity:${entity.name}`, kind: 'entity', expected: entity.name, status: 'PENDING' })
    entity.fields.forEach((field, fieldIndex) => checks.push({
      id: `entity-${entityIndex}-field-${fieldIndex}`, label: `field:${typeof field === 'string' ? field : field.name}`, kind: 'entity', expected: typeof field === 'string' ? field : field.name, status: 'PENDING',
    }))
  })
  spec.acceptance_criteria.forEach((criterion, index) => {
    const literal = extractLiteral(criterion)
    checks.push({
      id: `criterion-${index}`, label: criterion, kind: 'criterion',
      ...(literal === undefined ? {} : { expected: literal }),
      status: literal === undefined ? 'NOT_AUTOMATED' : 'PENDING',
    })
  })
  if (category === 'form-database') {
    spec.entities.filter(entity => entity.kind === 'database').forEach((entity, index) => {
      const fields = entity.fields.filter(field => field.type !== 'reference').map(field => ({
        name: dataIdentifier(field.name), type: field.type, required: field.required,
        ...(field.options === undefined ? {} : { options: field.options }),
      }))
      const marker = fields.find(field => ['text', 'email', 'phone'].includes(field.type)) ?? fields[0]!
      const slug = dataIdentifier(entity.name)
      checks.push({
        id: `flow-${index}`, label: `fluxo:${entity.name}:preencher-gravar-listar`, kind: 'flow', expected: entity.name,
        flow: { form_test_id: `${slug}-form`, list_test_id: `${slug}-list`, marker_field: marker.name, fields }, status: 'PENDING',
      })
    })
  }
  return checks
}

export async function writeAcceptanceArtifacts(runDirectory: string, spec: AppSpecV1, category: StudioProjectCategory = 'landing-page'): Promise<void> {
  const checks = acceptanceChecks(spec, category)
  await mkdir(resolve(runDirectory, 'evidence'), { recursive: true })
  await mkdir(resolve(runDirectory, 'tests', 'e2e'), { recursive: true })
  await writeFile(resolve(runDirectory, 'evidence', 'appspec-report.json'), `${JSON.stringify({ schema_version: 1, checks }, null, 2)}\n`, 'utf8')
  await writeFile(resolve(runDirectory, 'tests', 'e2e', 'appspec.spec.ts'), generatedPlaywright(checks), 'utf8')
}

function extractLiteral(criterion: string): string | undefined {
  const match = /["“]([^"”]{2,})["”]/u.exec(criterion)
  return match?.[1]?.trim() || undefined
}

function generatedPlaywright(checks: readonly AcceptanceCheck[]): string {
  return `import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const reportPath = resolve(process.cwd(), 'evidence/appspec-report.json')
async function record(id: string, status: 'PASSED' | 'FAILED') {
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  report.checks = report.checks.map((check: { id: string }) => check.id === id ? { ...check, status } : check)
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\\n')
}
async function checked(id: string, assertion: () => Promise<void>) {
  try { await assertion(); await record(id, 'PASSED') } catch (error) { await record(id, 'FAILED'); throw error }
}
${checks.filter(check => check.status === 'PENDING').map(check => {
  const id = JSON.stringify(check.id)
  const label = JSON.stringify(check.label)
  if (check.kind === 'language') return `test(${label}, async ({ page }) => checked(${id}, async () => { await page.goto('/'); await expect(page.locator('html')).toHaveAttribute('lang', ${JSON.stringify(check.expected)}) }))`
  if (check.kind === 'title') return `test(${label}, async ({ page }) => checked(${id}, async () => { await page.goto('/'); await expect(page).toHaveTitle(/\\S+/u) }))`
  if (check.kind === 'flow') return generatedFlowTest(check)
  return `test(${label}, async ({ page }) => checked(${id}, async () => { await page.goto('/'); await expect(page.getByText(${JSON.stringify(check.expected)}, { exact: true }).first()).toBeVisible() }))`
}).join('\n')}
`
}

function generatedFlowTest(check: AcceptanceCheck): string {
  const flow = check.flow!
  const marker = `DZ23-${check.id}`
  const entries = flow.fields.map(field => {
    const locator = `form.locator(${JSON.stringify(`[name="${field.name}"]`)})`
    if (field.type === 'boolean') return `${locator}.check()`
    if (field.type === 'selection') return `${locator}.selectOption(${JSON.stringify(field.options?.[0] ?? '')})`
    const value = field.name === flow.marker_field
      ? field.type === 'email' ? `${marker}@example.test` : field.type === 'phone' ? '11987654321' : marker
      : field.type === 'number' ? '42' : field.type === 'date' ? '2026-09-03' : field.type === 'email' ? `teste-${check.id}@example.test` : field.type === 'phone' ? '11987654321' : `Valor-${field.name}`
    return `${locator}.fill(${JSON.stringify(value)})`
  })
  const markerField = flow.fields.find(field => field.name === flow.marker_field)!
  const expected = markerField.type === 'email' ? `${marker}@example.test` : markerField.type === 'phone' ? '11987654321' : markerField.type === 'number' ? '42' : markerField.type === 'date' ? '2026-09-03' : markerField.type === 'selection' ? markerField.options?.[0] ?? '' : markerField.type === 'boolean' ? 'Sim' : marker
  return `test(${JSON.stringify(check.label)}, async ({ page }) => checked(${JSON.stringify(check.id)}, async () => { await page.goto('/'); const form = page.getByTestId(${JSON.stringify(flow.form_test_id)}); ${entries.map(entry => `await ${entry}`).join('; ')}; await form.getByRole('button', { name: 'Salvar' }).click(); await expect(page.getByTestId(${JSON.stringify(flow.list_test_id)})).toContainText(${JSON.stringify(expected)}) }))`
}
