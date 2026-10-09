import { assertDomainScopeManifest } from './domain-scope-gate.ts'

await assertDomainScopeManifest(process.cwd())
process.stdout.write('PASS: every Studio domain table has an explicit tenant-scope classification.\n')
