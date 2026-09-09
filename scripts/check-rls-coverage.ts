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
  { domain: 'studio_integrations', repository: 'plugins/integration-hub/src/tenant-repository.ts' },
  { domain: 'studio_intake_turns', repository: 'plugins/prompt-to-app/src/intake-turn-store.ts' },
]

/**
 * Quantos domínios já migraram. É um piso: o portão reprova se a lista
 * encolher, e passa quando ela cresce.
 *
 * Um número cravado, e não `RLS_MIGRATED.length`, de propósito: comparar a
 * lista consigo mesma passaria sempre, inclusive quando alguém apagasse uma
 * linha dela.
 */
export const RLS_MIGRATED_FLOOR = 3

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
 * - `startup-reconciliation`: o domínio é varrido NO INÍCIO do processo, antes
 *   de existir pessoa, sessão ou escopo, para fechar o que ficou pela metade
 *   num desligamento. Uma credencial escopada por inquilino não enxerga essa
 *   varredura, e rodá-la por inquilino exige primeiro ENUMERAR os inquilinos —
 *   que é uma consulta de resolução de escopo, a categoria acima. Tem saída,
 *   mas a saída é DESENHO, e não a troca mecânica de leitura que `ready`
 *   promete;
 * - `needs-review`: ainda não conferido no código. Está aqui como PENDÊNCIA
 *   declarada, e não como suposição travestida de classificação.
 */
export interface PendingClassification {
  readonly category: 'ready' | 'hot-guard' | 'tenant-resolution' | 'cross-tenant-invariant' | 'startup-reconciliation' | 'needs-review'
  readonly reason: string
  /**
   * O arquivo e o símbolo que sustentam o motivo.
   *
   * Exigido para as categorias que afirmam um FATO SOBRE O CÓDIGO
   * (`hot-guard`, `cross-tenant-invariant`, `startup-reconciliation`). Cinco
   * motivos desta tabela já foram para o repositório dizendo que uma varredura
   * lia tabelas que ela não lê — um auditor abriu o arquivo e mostrou. Com a
   * citação obrigatória e CONFERIDA, um motivo não pode mais apontar para uma
   * função que não existe.
   *
   * O portão confere a CITAÇÃO, não o SENTIDO: ele garante que o arquivo existe
   * e que o símbolo está lá, não que a leitura seja mesmo sem escopo. Julgar o
   * sentido continua sendo trabalho de gente, e dizer o contrário seria vender
   * uma garantia que este arquivo não pode dar.
   */
  readonly evidence?: { readonly file: string; readonly symbol: string }
}

export const PENDING_CLASSIFICATION: Readonly<Record<string, PendingClassification>> = {
  studio_projects: { category: 'startup-reconciliation', reason: 'reconcileInterruptedExecutions() (service.ts:311) le TODOS os projetos e TODAS as execucoes sem ator, no start do plugin, e ESCREVE em cima; uma credencial escopada nao enxerga essa varredura', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_app_specs: { category: 'startup-reconciliation', reason: 'a varredura de inicio NAO le esta tabela, mas ela vive no MESMO PromptToAppRepository, cujas leituras sao sincronas e sem escopo (projects(), specs(), ...); migrar uma sem as outras parte o repositorio em dois donos', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_design_specs: { category: 'startup-reconciliation', reason: 'idem studio_app_specs: fora da varredura, dentro do mesmo repositorio', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_plans: { category: 'startup-reconciliation', reason: 'idem studio_app_specs: fora da varredura, dentro do mesmo repositorio', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_runs: { category: 'startup-reconciliation', reason: 'a varredura de inicio le as execucoes PENDING e RUNNING de TODOS os inquilinos e as marca FAILED', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_evidence: { category: 'startup-reconciliation', reason: 'idem studio_app_specs: fora da varredura, dentro do mesmo repositorio', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_approvals: { category: 'startup-reconciliation', reason: 'a varredura de inicio ESCREVE aprovacao de recuperacao para projetos de qualquer inquilino', evidence: { file: 'plugins/prompt-to-app/src/service.ts', symbol: 'reconcileInterruptedExecutions' } },
  studio_policy_audit: { category: 'cross-tenant-invariant', reason: 'a trilha e UMA corrente de hash GLOBAL: seq e previous_sha256 encadeiam entradas de todos os inquilinos (policy/src/index.ts:394-425), e verifyPolicyAuditChain so fecha lendo a corrente inteira', evidence: { file: 'plugins/policy/src/index.ts', symbol: 'verifyPolicyAuditChain' } },
  studio_agent_runs: { category: 'startup-reconciliation', reason: '#performRestartReconciliation() (agents/src/service.ts:480) le as execucoes RUNNING de TODOS os inquilinos no reinicio; #hasPersistedWork() faz o mesmo', evidence: { file: 'plugins/agents/src/service.ts', symbol: '#performRestartReconciliation' } },
  studio_agent_teams: { category: 'startup-reconciliation', reason: 'reconcileInterruptedTeams() (agent-team/src/service.ts:201) varre tarefas e equipes de todos os inquilinos no reinicio', evidence: { file: 'plugins/agent-team/src/service.ts', symbol: 'reconcileInterruptedTeams' } },

  studio_agent_leases: { category: 'hot-guard', reason: 'lido de forma sincrona em start() para o conflito de caminhos e para a cerca, antes de cada delegacao', evidence: { file: 'plugins/agents/src/service.ts', symbol: '#hasPersistedWork' } },
  studio_emergency_stop: { category: 'hot-guard', reason: 'assertRunning() e SINCRONO e roda antes de cada delegacao e de cada chamada de integracao', evidence: { file: 'plugins/emergency-stop/src/service.ts', symbol: 'assertRunning' } },
  studio_integration_switches: { category: 'hot-guard', reason: 'assertScopeEnabled() e SINCRONO e roda em callIntegration antes de qualquer saida', evidence: { file: 'plugins/integration-hub/src/service.ts', symbol: 'assertScopeEnabled' } },
  studio_route_health: { category: 'hot-guard', reason: 'chooseRoute() le o registro a cada requisicao de modelo', evidence: { file: 'plugins/route-health/src/service.ts', symbol: 'chooseRoute' } },

  studio_identity_users: { category: 'tenant-resolution', reason: 'a identidade e o que DETERMINA a organizacao e o inquilino; filtrar por eles seria circular' },
  studio_identity_sessions: { category: 'tenant-resolution', reason: 'a sessao e resolvida ANTES de o escopo existir, e em todo pedido' },
  studio_identity_audit: { category: 'tenant-resolution', reason: 'registra tentativas que podem nao ter escopo resolvido, inclusive as que falharam' },
  studio_orgs: { category: 'tenant-resolution', reason: 'a organizacao e o proprio escopo; ela nao pode ser filtrada por si mesma' },
  studio_workspaces: { category: 'tenant-resolution', reason: 'o espaco de trabalho faz parte do proprio escopo; ele nao pode ser filtrado por si mesmo' },
  studio_memberships: { category: 'tenant-resolution', reason: 'e a tabela que decide a que escopo a pessoa pertence' },

  studio_staging_releases: { category: 'cross-tenant-invariant', reason: 'reserveRelease prende o destino FISICO ao primeiro escopo que o reservou e recusa outro (active-conflict); ver essa colisao exige ler releases de OUTROS inquilinos, que a RLS impede por desenho', evidence: { file: 'plugins/staging/src/service.ts', symbol: 'reserveRelease' } },

  // Conferido (set/2026), e a resposta NAO era a capacidade global.
  //
  // `authorize(hostname, cookie)` roda no portao da previa, em toda requisicao
  // que chega em `<algo>.preview.<host>`, e procura a previa PELO NOME DE HOST,
  // sem ator e sem escopo. E ele nao pode ter escopo: o inquilino e justamente
  // o que essa busca esta DESCOBRINDO. Filtrar por inquilino aqui seria pedir a
  // resposta antes da pergunta - a mesma circularidade de `studio_identity_*`.
  //
  // O `CapacityGovernor` global existe e nao e o motivo: ele e um limite de
  // recursos, e um limite pode ser distribuido por fora sem que a tabela deixe
  // de ser filtravel. Se fosse so isso, estas duas migrariam.
  studio_previews: { category: 'tenant-resolution', reason: 'authorize() acha a previa PELO NOME DE HOST, sem ator, no portao: o inquilino e o que essa busca descobre, e filtrar por ele seria circular', evidence: { file: 'plugins/preview/src/service.ts', symbol: 'authorize' } },
  studio_preview_admissions: { category: 'tenant-resolution', reason: 'a admissao e lida no mesmo authorize(), por preview_id e cookie, antes de qualquer escopo existir', evidence: { file: 'plugins/preview/src/service.ts', symbol: 'authorize' } },
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
  readSource: (path: string) => string | undefined = defaultReadSource,
): readonly string[] {
  const findings: string[] = []
  for (const name of scoped) {
    if (migrated.includes(name)) continue
    const entry = Object.hasOwn(table, name) ? table[name] : undefined
    if (entry === undefined) { findings.push(`domínio pendente sem classificação: ${name}`); continue }
    if (entry.reason.trim().length < 20) findings.push(`classificação de ${name} sem motivo escrito`)
    findings.push(...evidenceFindings(name, entry, readSource))
  }
  for (const name of Object.keys(table)) {
    if (!scoped.includes(name)) findings.push(`classificação de um domínio que não tem escopo por linha: ${name}`)
    else if (migrated.includes(name)) findings.push(`classificação de um domínio JÁ migrado: ${name}`)
  }
  return findings
}


/** As categorias que AFIRMAM um fato sobre o código, e por isso precisam citá-lo. */
const CATEGORIES_REQUIRING_EVIDENCE: readonly PendingClassification['category'][] = [
  'hot-guard', 'cross-tenant-invariant', 'startup-reconciliation',
]

/** Lê um arquivo do repositório, ou `undefined` se ele não existir. */
function defaultReadSource(path: string): string | undefined {
  const absolute = resolve(root, path)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined
}

/**
 * Os problemas da CITAÇÃO de uma classificação.
 *
 * Cinco motivos desta tabela chegaram ao repositório afirmando que uma varredura
 * de início lia tabelas que ela não lê. Ninguém percebeu porque nada conferia a
 * afirmação contra o arquivo. Agora, categoria que afirma fato sobre o código
 * cita arquivo e símbolo, e o portão abre o arquivo.
 *
 * O que ele confere é a CITAÇÃO — arquivo existe, símbolo está lá. O SENTIDO
 * (se a leitura é mesmo sem escopo) continua sendo julgamento de gente.
 * @param name - o domínio.
 * @param entry - a classificação.
 * @param readSource - como ler um arquivo do repositório (injetado para o self-test).
 * @returns os achados.
 */
export function evidenceFindings(
  name: string,
  entry: PendingClassification,
  readSource: (path: string) => string | undefined,
): readonly string[] {
  const evidence = entry.evidence
  // A citação é EXIGIDA nas categorias que afirmam um fato sobre o código, e
  // CONFERIDA sempre que existir. A regra antiga só olhava as exigidas, e isso
  // deixava uma porta aberta: uma classificação de `tenant-resolution` podia
  // citar um arquivo que não existe e ninguém percebia — a citação errada é
  // pior que a ausência dela, porque parece prova.
  if (evidence === undefined) {
    return CATEGORIES_REQUIRING_EVIDENCE.includes(entry.category)
      ? [`classificação ${entry.category} de ${name} sem citação de arquivo e símbolo`]
      : []
  }
  const source = readSource(evidence.file)
  if (source === undefined) return [`a citação de ${name} aponta para um arquivo que não existe: ${evidence.file}`]
  if (!source.includes(evidence.symbol)) {
    return [`a citação de ${name} aponta para ${evidence.symbol}, que não está em ${evidence.file}`]
  }
  return []
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
  // Uma citação que aponta para símbolo ausente REPROVA. Este é o caso que
  // cinco motivos falsos atravessaram sem ninguém notar.
  if (evidenceFindings('teste', { category: 'startup-reconciliation', reason: 'motivo com mais de vinte caracteres', evidence: { file: 'package.json', symbol: 'funcaoQueNaoExiste' } }, defaultReadSource).length === 0) {
    throw new Error('self-test: o portão não viu uma citação apontando para símbolo ausente')
  }
  checks.push('citacao-simbolo-ausente')
  // E uma citação para arquivo que não existe também.
  if (evidenceFindings('teste', { category: 'hot-guard', reason: 'motivo com mais de vinte caracteres', evidence: { file: 'nao/existe.ts', symbol: 'x' } }, defaultReadSource).length === 0) {
    throw new Error('self-test: o portão não viu uma citação apontando para arquivo inexistente')
  }
  checks.push('citacao-arquivo-ausente')
  // E a ausência da citação, numa categoria que afirma fato sobre o código.
  if (evidenceFindings('teste', { category: 'cross-tenant-invariant', reason: 'motivo com mais de vinte caracteres' }, defaultReadSource).length === 0) {
    throw new Error('self-test: o portão não viu uma classificação sem citação')
  }
  checks.push('citacao-ausente')
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
