import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AppSpecV1 } from './appspec.js'

export type AcceptanceStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'NOT_AUTOMATED'
export interface AcceptanceCheck {
  readonly id: string
  readonly label: string
  readonly kind: 'language' | 'title' | 'page' | 'section' | 'entity' | 'criterion'
  readonly expected?: string
  readonly status: AcceptanceStatus
}

export function acceptanceChecks(spec: AppSpecV1): readonly AcceptanceCheck[] {
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
      id: `entity-${entityIndex}-field-${fieldIndex}`, label: `field:${field}`, kind: 'entity', expected: field, status: 'PENDING',
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
  return checks
}

export async function writeAcceptanceArtifacts(runDirectory: string, spec: AppSpecV1): Promise<void> {
  const checks = acceptanceChecks(spec)
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
  return `test(${label}, async ({ page }) => checked(${id}, async () => { await page.goto('/'); await expect(page.getByText(${JSON.stringify(check.expected)}, { exact: true }).first()).toBeVisible() }))`
}).join('\n')}
`
}
