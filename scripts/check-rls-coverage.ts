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

/**
 * Por que cada domínio pendente ainda NÃO migrou.
 *
 * Esta tabela existe porque "faltam 25" sugere 25 tarefas iguais, e elas não
 * são. Descobrir isso tarde — no meio de uma migração — seria descobrir com
 * dados de gente em cima. As categorias:
 *
 * - `ready`: dado puramente por inquilino. O que falta é a leitura do
 *   repositório virar escopada e assíncrona. É a única categoria mecânica;
 * - `hot-guard`: lido de forma SÍNCRONA numa guarda de caminho quente. Trocar
 *   por leitura assíncrona no banco não é migração, é mudança de desenho da
 *   guarda — e fazer isso às pressas num caminho de parada de emergência é
 *   pior do que o buraco que se quer fechar;
 * - `tenant-resolution`: o domínio é o que RESOLVE de qual inquilino a pessoa
 *   é. Uma política de RLS que filtra pelo inquilino corrente não pode servir
 *   a consulta que DETERMINA o inquilino corrente. Não é ordem de trabalho: é
 *   uma contradição, e migrar isto exigiria outro desenho;
 * - `cross-tenant-invariant`: o domínio garante algo ENTRE inquilinos, e a
 *   RLS torna impossível a leitura de que a garantia depende;
 * - `needs-review`: ainda não conferido no código. Está aqui como PENDÊNCIA
 *   declarada, e não como suposição travestida de classificação.
 */
export const PENDING_CLASSIFICATION: Readonly<Record<string, { readonly category: 'ready' | 'hot-guard' | 'tenant-resolution' | 'cross-tenant-invariant' | 'needs-review'; readonly reason: string }>> = {
  studio_projects: { category: 'ready', reason: 'dado por inquilino; a leitura do PromptToAppRepository devolve a tabela inteira e o servico filtra em memoria' },
  studio_app_specs: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_design_specs: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_intake_turns: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_plans: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_runs: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_evidence: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_approvals: { category: 'ready', reason: 'idem studio_projects, mesmo repositorio' },
  studio_policy_audit: { category: 'ready', reason: 'trilha por inquilino, escrita-dominante' },
  studio_agent_runs: { category: 'ready', reason: 'dado por inquilino; leitura do AgentRepository e sincrona mas fora de guarda' },
  studio_agent_teams: { category: 'ready', reason: 'idem studio_agent_runs' },
  studio_integrations: { category: 'ready', reason: 'dado por inquilino; o catalogo ja pagina no servidor' },

  studio_agent_leases: { category: 'hot-guard', reason: 'lido de forma sincrona em start() para o conflito de caminhos e para a cerca, antes de cada delegacao' },
  studio_emergency_stop: { category: 'hot-guard', reason: 'assertRunning() e SINCRONO e roda antes de cada delegacao e de cada chamada de integracao' },
  studio_integration_switches: { category: 'hot-guard', reason: 'assertScopeEnabled() e SINCRONO e roda em callIntegration antes de qualquer saida' },
  studio_route_health: { category: 'hot-guard', reason: 'chooseRoute() le o registro a cada requisicao de modelo' },

  studio_identity_users: { category: 'tenant-resolution', reason: 'a identidade e o que DETERMINA a organizacao e o inquilino; filtrar por eles seria circular' },
  studio_identity_sessions: { category: 'tenant-resolution', reason: 'a sessao e resolvida ANTES de o escopo existir, e em todo pedido' },
  studio_identity_audit: { category: 'tenant-resolution', reason: 'registra tentativas que podem nao ter escopo resolvido, inclusive as que falharam' },
  studio_orgs: { category: 'tenant-resolution', reason: 'a organizacao e o proprio escopo; ela nao pode ser filtrada por si mesma' },
  studio_workspaces: { category: 'tenant-resolution', reason: 'o espaco de trabalho faz parte do proprio escopo; ele nao pode ser filtrado por si mesmo' },
  studio_memberships: { category: 'tenant-resolution', reason: 'e a tabela que decide a que escopo a pessoa pertence' },

  studio_staging_releases: { category: 'cross-tenant-invariant', reason: 'reserveRelease prende o destino FISICO ao primeiro escopo que o reservou e recusa outro (active-conflict); ver essa colisao exige ler releases de OUTROS inquilinos, que a RLS impede por desenho' },

  studio_previews: { category: 'needs-review', reason: 'ha um CapacityGovernor global; falta conferir se o dominio em si tem invariante entre inquilinos ou se e so a capacidade' },
  studio_preview_admissions: { category: 'needs-review', reason: 'idem studio_previews' },
}

/**
 * Os problemas da tabela de classificação: pendente sem linha, motivo vazio, e
 * linha para um domínio que já migrou ou que não existe.
 *
 * Sem a primeira checagem a lista de pendentes volta a sugerir 25 tarefas
 * iguais, que é justamente o que ela não é. Sem as últimas, a tabela vira um
 * documento sobre o passado que ninguém mantém.
 * @param scoped - os domínios com escopo por linha.
 * @param migrated - os que já saíram da chave-valor.
 * @param table - a classificação sob exame.
 * @returns os achados.
 */
export function classificationFindings(
  scoped: readonly string[],
  migrated: readonly string[],
  table: typeof PENDING_CLASSIFICATION,
): readonly string[] {
  const findings: string[] = []
  for (const name of scoped) {
    if (migrated.includes(name)) continue
    const entry = Object.hasOwn(table, name) ? table[name] : undefined
    if (entry === undefined) { findings.push(`domínio pendente sem classificação: ${name}`); continue }
    if (entry.reason.trim().length < 20) findings.push(`classificação de ${name} sem motivo escrito`)
  }
  for (const name of Object.keys(table)) {
    if (!scoped.includes(name)) findings.push(`classificação de um domínio que não tem escopo por linha: ${name}`)
    else if (migrated.includes(name)) findings.push(`classificação de um domínio JÁ migrado: ${name}`)
  }
  return findings
}

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
  findings.push(...classificationFindings(scoped, names, PENDING_CLASSIFICATION))
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
  // Um pendente sem classificação reprova.
  // Um pendente sem classificação reprova: tiramos uma linha da tabela e o
  // portão tem de acusar.
  const withoutOne = Object.fromEntries(Object.entries(PENDING_CLASSIFICATION).slice(1))
  if (classificationFindings(tenantScopedDomains(STUDIO_DOMAIN_SCOPES), RLS_MIGRATED.map(entry => entry.domain), withoutOne).length === 0) {
    throw new Error('self-test: o portão não viu um pendente sem classificação')
  }
  checks.push('pendente-sem-classificacao')
  // E uma classificação de domínio inexistente também reprova.
  if (classificationFindings(tenantScopedDomains(STUDIO_DOMAIN_SCOPES), RLS_MIGRATED.map(entry => entry.domain), { ...PENDING_CLASSIFICATION, nao_existe: { category: 'ready', reason: 'motivo com mais de vinte caracteres para passar do minimo' } }).length === 0) {
    throw new Error('self-test: o portão não viu uma classificação inventada')
  }
  checks.push('classificacao-inventada')
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
  + `- pendentes (isolamento por codigo do produto, nao pelo banco): ${report.pending.join(', ')}\n`
  + `- por categoria: ${categorySummary(report.pending)}\n`,
)

/** Quantos pendentes há em cada categoria — o número que diz se a fila é mecânica ou não. */
function categorySummary(pending: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const name of pending) {
    const category = Object.hasOwn(PENDING_CLASSIFICATION, name) ? PENDING_CLASSIFICATION[name]!.category : 'sem-classificacao'
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()].sort().map(([category, count]) => `${category}=${String(count)}`).join(' ')
}
