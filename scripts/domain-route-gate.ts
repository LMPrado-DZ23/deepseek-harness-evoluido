import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { STUDIO_DOMAIN_SPECS } from './studio-domain-specs.ts'

/**
 * Every Studio-owned domain must be routed to the `postgres` backend in each
 * Harness patch that composes the PostgreSQL storage plugin. A domain left
 * out silently lands on the default `json` backend: no durability contract,
 * no single-writer lease, no backup. The patch files are the only place this
 * decision lives, so the gate reads them as text and refuses any gap.
 */
export const ROUTED_PATCH_FILES = [
  'deploy/harness/edge.patch.yml',
  'deploy/harness/postgres-proof.patch.yml',
] as const

export interface DomainRouteReport {
  file: string
  routed: string[]
  missing: string[]
  unknown: string[]
}

export function expectedDomainNames(): string[] {
  return STUDIO_DOMAIN_SPECS.map(spec => spec.name).sort()
}

/** Parse `<domain>: postgres` lines under the `routes:` mapping of a Harness patch. */
export function parsePostgresRoutes(patchText: string): string[] {
  const lines = patchText.split(/\r?\n/u)
  const routed: string[] = []
  let inRoutes = false
  let routesIndent = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (inRoutes && indent <= routesIndent) inRoutes = false
    if (/^routes:\s*$/u.test(trimmed)) { inRoutes = true; routesIndent = indent; continue }
    if (!inRoutes) continue
    const match = /^([A-Za-z0-9_]+):\s*postgres\s*$/u.exec(trimmed)
    if (match !== null) routed.push(match[1]!)
  }
  return routed.sort()
}

export async function reportDomainRoutes(root: string, files: readonly string[] = ROUTED_PATCH_FILES): Promise<DomainRouteReport[]> {
  const expected = expectedDomainNames()
  const reports: DomainRouteReport[] = []
  for (const file of files) {
    const routed = parsePostgresRoutes(await readFile(resolve(root, file), 'utf8'))
    reports.push({
      file,
      routed,
      missing: expected.filter(name => !routed.includes(name)),
      unknown: routed.filter(name => !expected.includes(name)),
    })
  }
  return reports
}

export async function assertDomainRoutes(root: string, files: readonly string[] = ROUTED_PATCH_FILES): Promise<DomainRouteReport[]> {
  const reports = await reportDomainRoutes(root, files)
  const failures: string[] = []
  // Zero routes in ONE patch was already a failure; zero PATCHES was still a pass, and printed
  // `domains=0 files=0` as if it had checked something. With `ROUTED_PATCH_FILES` emptied — by a
  // merge, by a rename of a patch — the gate had nothing to read and approved everything. The same
  // holds for the expected side: no Studio domains means the comparison is vacuous.
  if (files.length === 0) failures.push('no Harness patch was checked: a gate with zero files is a failure, not a pass')
  if (expectedDomainNames().length === 0) failures.push('no Studio domain was found in scripts/studio-domain-specs.ts: a gate with zero domains is a failure, not a pass')
  failures.push(...reports.flatMap(report => [
    ...report.missing.map(name => `${report.file}: domain '${name}' has no 'postgres' route (it would fall back to the json backend)`),
    ...report.unknown.map(name => `${report.file}: route '${name}' does not match any Studio domain in scripts/studio-domain-specs.ts`),
  ]))
  if (reports.some(report => report.routed.length === 0)) failures.push('a patch with zero postgres routes is a failure, not a pass')
  if (failures.length > 0) throw new Error(`DOMAIN_ROUTE_GATE=FAIL\n${failures.join('\n')}`)
  return reports
}
