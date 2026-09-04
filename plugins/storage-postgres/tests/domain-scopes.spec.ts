import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDomainScopeManifest, STUDIO_DOMAIN_SCOPES } from '../../../scripts/domain-scope-gate.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'

const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('Studio domain tenant-scope gate', () => {
  it('classifies every defineDomain declaration with no wildcard', async () => {
    await expect(assertDomainScopeManifest(process.cwd())).resolves.toBeUndefined()
  }, 15_000)

  it('fails instead of passing when it inspected nothing at all', async () => {
    // Two empty lists compare EQUAL: with no `defineDomain` under plugins/ and an empty manifest the
    // gate used to print PASS having looked at zero declarations. By this project's rules that is a
    // failure. Both halves are checked, because either one alone is enough to make the pass vacuous.
    const root = await mkdtemp(join(tmpdir(), 'dz23-scope-gate-'))
    scratch.push(root)
    await mkdir(join(root, 'plugins'), { recursive: true })
    await expect(assertDomainScopeManifest(root, [])).rejects.toThrow(/zero items is a failure/u)
    await expect(assertDomainScopeManifest(root)).rejects.toThrow(/zero items is a failure/u)
    // And the real tree with a real manifest still passes, so the guard is not just refusing everything.
    await expect(assertDomainScopeManifest(process.cwd(), STUDIO_DOMAIN_SCOPES)).resolves.toBeUndefined()
  })

  it('matches every physical domain and table and requires its structural scope fields', () => {
    expect(STUDIO_DOMAIN_SCOPES).toHaveLength(STUDIO_DOMAIN_SPECS.length)
    for (const entry of STUDIO_DOMAIN_SCOPES) {
      const spec = STUDIO_DOMAIN_SPECS.find(candidate => candidate.name === entry.physicalName)
      expect(spec, entry.physicalName).toBeDefined()
      expect(Object.keys(spec!.tables).sort()).toEqual(Object.keys(entry.tables).sort())
      for (const [tableName, rule] of Object.entries(entry.tables)) {
        const table = (spec!.tables as Record<string, { valueSchema: unknown }>)[tableName]!
        const fields = schemaFields(table.valueSchema)
        expect(fields, `${entry.physicalName}.${tableName}`).toEqual(expect.arrayContaining([...rule.requiredFields]))
        if (rule.scope !== 'org-tenant') expect(rule.reason).toBeTruthy()
      }
    }
  })
})

function schemaFields(schema: unknown): string[] {
  let current = schema as { shape?: Record<string, unknown>; in?: unknown }
  while (current.shape === undefined && current.in !== undefined) current = current.in as typeof current
  if (current.shape === undefined) throw new Error('Expected a Zod object schema')
  return Object.keys(current.shape)
}
