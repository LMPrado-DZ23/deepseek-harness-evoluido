import { assertDomainRoutes } from './domain-route-gate.ts'

const reports = await assertDomainRoutes(process.cwd())
for (const report of reports) process.stdout.write(`${report.file}: ${String(report.routed.length)} domínios roteados para postgres\n`)
process.stdout.write(`DOMAIN_ROUTE_GATE=PASS domains=${String(reports[0]?.routed.length ?? 0)} files=${String(reports.length)}\n`)
