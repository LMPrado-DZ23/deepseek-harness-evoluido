/**
 * Portão da cobertura de RLS por domínio (S-08 / S-09).
 *
 * O requisito S-08 pede `org_id` e `tenant_id` em TODA tabela. Hoje isso é
 * FALSO, e este portão existe para que a distância até lá seja um NÚMERO em vez
 * de uma impressão — e para que ela só possa diminuir.
 *
 * O que é verdade hoje, e está provado contra PostgreSQL 16 real:
 *
 * - `tenant_records` tem `org_id`, `tenant_id`, RLS ENABLE + FORCE e política
 *   por escopo, com credencial de execução NOSUPERUSER/NOBYPASSRLS;
 * - a credencial de execução NÃO ALCANÇA nenhuma tabela do motor de
 *   chave-valor — nem para ler (kv-boundary.postgres.spec.ts);
 * - os domínios que ainda vivem na chave-valor são servidos pela credencial de
 *   ADMINISTRAÇÃO, e o isolamento entre inquilinos deles é feito por código do
 *   produto, não pelo banco. Esse é o buraco, e é ele que este portão mede.
 *
 * A regra: a lista de domínios migrados só pode CRESCER. Um domínio que sai
 * dela é uma regressão de isolamento, e regressão de isolamento não passa
 * despercebida.
 *
 * Uso: node --experimental-strip-types scripts/check-rls-coverage.ts [--self-test]
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { STUDIO_DOMAIN_SCOPES } from './domain-scope-gate.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Os domínios que JÁ saíram da chave-valor opaca para a tabela por inquilino.
 *
 * Cada entrada aponta para o arquivo que faz a leitura e a escrita pela tabela
 * com RLS. O arquivo é conferido: uma entrada aqui sem repositório de verdade
 * seria a lista mentindo sobre o que já foi feito.
 */
export const RLS_MIGRATED: readonly { readonly domain: string; readonly repository: string }[] = [
  { domain: 'studio_action_approvals', repository: 'plugins/action-approval/src/tenant-repository.ts' },
]

/**
 * Quantos domínios já migraram. É um piso: o portão reprova se a lista
 * encolher, e passa quando ela cresce.
 *
 * Um número cravado, e não `RLS_MIGRATED.length`, de propósito: comparar a
 * lista consigo mesma passaria sempre, inclusive quando alguém apagasse uma
 * linha dela.
 */
export const RLS_MIGRATED_FLOOR = 1

/** Os domínios cujo isolamento depende de escopo por linha. `org-root` também: ele carrega `org_id`. */
export function tenantScopedDomains(scopes: typeof STUDIO_DOMAIN_SCOPES): readonly string[] {
  return scopes
    .filter(entry => Object.values(entry.tables).some(table => table.requiredFields.includes('org_id')))
    .map(entry => entry.physicalName)
}

export interface CoverageReport {
  readonly total: number
  readonly migrated: readonly string[]
  readonly pending: readonly string[]
  readonly findings: readonly string[]
}

/**
 * O retrato da cobertura, e o que está errado nele.
 * @param scopes - a classificação de escopo de cada domínio.
 * @param migrated - a lista de migrados.
 * @param floor - o piso que a lista não pode furar.
 * @param repositoryExists - se o arquivo do repositório existe (injetado para o self-test).
 * @returns os números e os achados.
 */
export function coverage(
  scopes: typeof STUDIO_DOMAIN_SCOPES,
  migrated: typeof RLS_MIGRATED,
  floor: number,
  repositoryExists: (path: string) => boolean,
): CoverageReport {
  const scoped = tenantScopedDomains(scopes)
  const findings: string[] = []
  const names = migrated.map(entry => entry.domain)
  for (const entry of migrated) {
    // Um domínio migrado que não é um domínio: a lista está falando de algo que
    // não existe, e o número que ela produz não significa nada.
    if (!scoped.includes(entry.domain)) findings.push(`domínio migrado que não é um domínio com escopo por linha: ${entry.domain}`)
    // Uma entrada sem repositório de verdade é a lista mentindo sobre o que já foi feito.
    if (!repositoryExists(entry.repository)) findings.push(`domínio ${entry.domain} declarado migrado sem repositório em ${entry.repository}`)
  }
  if (new Set(names).size !== names.length) findings.push('a lista de migrados tem domínio repetido, e a contagem dela mentiria')
  if (names.length < floor) findings.push(`a cobertura de RLS ENCOLHEU: ${String(names.length)} migrados contra um piso de ${String(floor)}`)
  return {
    total: scoped.length,
    migrated: [...names].sort(),
    pending: scoped.filter(name => !names.includes(name)).sort(),
    findings,
  }
}

const exists = (path: string): boolean => existsSync(resolve(root, path))

if (process.argv.includes('--self-test')) {
  const checks: string[] = []
  // Encolher a lista reprova.
  if (coverage(STUDIO_DOMAIN_SCOPES, [], RLS_MIGRATED_FLOOR, exists).findings.length === 0) {
    throw new Error('self-test: o portão não viu a cobertura encolher')
  }
  checks.push('encolhimento')
  // Declarar migrado sem repositório reprova.
  if (coverage(STUDIO_DOMAIN_SCOPES, RLS_MIGRATED, RLS_MIGRATED_FLOOR, () => false).findings.length === 0) {
    throw new Error('self-test: o portão não viu um migrado sem repositório')
  }
  checks.push('repositorio-ausente')
  // Um nome inventado reprova.
  if (coverage(STUDIO_DOMAIN_SCOPES, [{ domain: 'nao_existe', repository: RLS_MIGRATED[0]!.repository }], 0, exists).findings.length === 0) {
    throw new Error('self-test: o portão não viu um domínio inventado')
  }
  checks.push('dominio-inventado')
  // Repetido reprova.
  if (coverage(STUDIO_DOMAIN_SCOPES, [RLS_MIGRATED[0]!, RLS_MIGRATED[0]!], 0, exists).findings.length === 0) {
    throw new Error('self-test: o portão não viu um domínio repetido')
  }
  checks.push('repetido')
  process.stdout.write(`RLS_COVERAGE_SELF_TEST=PASS checks=${String(checks.length)}\n`)
}

const report = coverage(STUDIO_DOMAIN_SCOPES, RLS_MIGRATED, RLS_MIGRATED_FLOOR, exists)
if (report.findings.length > 0) {
  process.stdout.write(`RLS_COVERAGE=FAIL\n${report.findings.map(line => `- ${line}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  `RLS_COVERAGE=PASS migrados=${String(report.migrated.length)}/${String(report.total)} `
  + `pendentes=${String(report.pending.length)}\n`
  + `- migrados: ${report.migrated.join(', ')}\n`
  + `- pendentes (isolamento por codigo do produto, nao pelo banco): ${report.pending.join(', ')}\n`,
)
