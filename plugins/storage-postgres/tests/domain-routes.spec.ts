import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDomainRoutes, expectedDomainNames, parsePostgresRoutes, ROUTED_PATCH_FILES } from '../../../scripts/domain-route-gate.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'

const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('Studio domain → postgres route gate', () => {
  it('routes every Studio domain to postgres in both Harness patches', async () => {
    const reports = await assertDomainRoutes(process.cwd())
    expect(reports.map(report => report.file)).toEqual([...ROUTED_PATCH_FILES])
    for (const report of reports) {
      expect(report.missing).toEqual([])
      expect(report.unknown).toEqual([])
      expect(report.routed).toEqual(expectedDomainNames())
    }
    expect(expectedDomainNames()).toHaveLength(STUDIO_DOMAIN_SPECS.length)
  })

  it('parses only the routes mapping and ignores comments and other backends', () => {
    const patch = [
      '# routes: studio_fake: postgres', '- id: storage-domain', '  config:', '    backend: json', '    routes:',
      '      studio_hello: postgres', '      studio_other: json', '      # studio_commented: postgres', '- id: connection', '  config:',
      '    studio_not_a_route: postgres',
    ].join('\n')
    expect(parsePostgresRoutes(patch)).toEqual(['studio_hello'])
  })

  it('fails on a missing domain, an unknown route and a patch with zero routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-route-gate-'))
    scratch.push(root)
    const routes = expectedDomainNames().filter(name => name !== 'studio_runs').map(name => `      ${name}: postgres`)
    await writeFile(join(root, 'patch.yml'), ['- id: storage-domain', '  config:', '    routes:', ...routes, '      studio_ghost: postgres'].join('\n'))
    await writeFile(join(root, 'empty.yml'), ['- id: storage-domain', '  config:', '    backend: json'].join('\n'))
    await expect(assertDomainRoutes(root, ['patch.yml'])).rejects.toThrow(/studio_runs.*no 'postgres' route[\s\S]*studio_ghost/u)
    await expect(assertDomainRoutes(root, ['empty.yml'])).rejects.toThrow(/zero postgres routes is a failure/u)
  })

  it('fails on zero patch files, instead of reporting DOMAIN_ROUTE_GATE=PASS domains=0 files=0', async () => {
    // The per-file guard covered a patch with no routes; nothing covered a gate with no patches.
    // With ROUTED_PATCH_FILES emptied there was nothing to read and everything was approved.
    await expect(assertDomainRoutes(process.cwd(), [])).rejects.toThrow(/zero files is a failure/u)
    // The real list still passes, so the guard did not simply turn the gate off.
    await expect(assertDomainRoutes(process.cwd())).resolves.toHaveLength(ROUTED_PATCH_FILES.length)
  })
})
