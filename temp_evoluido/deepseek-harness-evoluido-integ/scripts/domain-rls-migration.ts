/**
 * Migração de um domínio do armazenamento por chave-valor opaco para a tabela
 * por inquilino com isolamento por linha — o miolo verificável do requisito S-09.
 *
 * A parte que decide fica aqui, separada de qualquer banco, porque é ela que
 * precisa de prova: o que conta como "copiou tudo", o que conta como "confere",
 * e o que conta como "não confere e portanto não vale". A ida ao banco é o
 * pedaço fácil.
 *
 * A regra que atravessa o arquivo inteiro: uma migração só vale quando os DOIS
 * lados são comparados registro a registro. Contar linhas dos dois lados pega o
 * que sumiu e não pega o que chegou diferente — e um registro que chega
 * diferente numa autoridade de confirmação é uma confirmação com outro conteúdo
 * do que a pessoa aprovou.
 */
import { createHash } from 'node:crypto'

/** Um registro qualquer de domínio, do jeito que ele atravessa a migração. */
export interface DomainRow {
  readonly key: string
  readonly value: unknown
}

/** O escopo físico de uma linha na tabela por inquilino. */
export interface RowScope {
  readonly orgId: string
  readonly tenantId: string
}

export class MigrationError extends Error {
  constructor(readonly code: 'SCOPE_MISSING' | 'VERIFICATION_FAILED', message: string) { super(message) }
}

/**
 * JSON canônico: chaves em ordem, sem espaço.
 *
 * Sem canonicalizar, dois registros IGUAIS com as chaves em ordens diferentes
 * dariam digests diferentes e a verificação reprovaria uma migração correta —
 * o que treina quem opera a ignorar a verificação.
 * @param value - o valor a serializar.
 * @returns o texto canônico.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * O digest de um registro: chave e conteúdo, juntos.
 *
 * A chave entra no digest de propósito. Sem ela, duas linhas com o mesmo
 * conteúdo e chaves trocadas passariam na verificação, e a migração teria
 * embaralhado os identificadores sem ninguém ver.
 * @param row - a linha.
 * @returns o SHA-256 em hexadecimal.
 */
export function rowDigest(row: DomainRow): string {
  return createHash('sha256').update(canonicalJson([row.key, row.value])).digest('hex')
}

/**
 * O digest do conjunto inteiro, independente da ordem de leitura.
 *
 * Os digests das linhas são ordenados antes de serem juntados: a chave-valor e
 * a tabela devolvem em ordens diferentes, e uma verificação sensível à ordem
 * reprovaria uma migração correta por causa de um `ORDER BY`.
 * @param rows - as linhas de um lado.
 * @returns o SHA-256 do conjunto.
 */
export function payloadDigest(rows: readonly DomainRow[]): string {
  // Só a lista ordenada. O tamanho já está dentro dela - uma lista com um
  // registro a mais é outro texto - e um campo redundante no digest é um campo
  // que ninguém consegue provar que faz falta.
  const digests = rows.map(rowDigest).sort()
  return createHash('sha256').update(canonicalJson(digests)).digest('hex')
}

/**
 * O escopo físico de uma linha, tirado do próprio registro.
 *
 * Uma linha sem organização e inquilino NÃO recebe um escopo padrão: ela não
 * tem lugar na tabela por inquilino, e inventar um a colocaria embaixo de
 * alguém. A migração para inteira e diz qual chave está sem escopo.
 * @param row - a linha lida da chave-valor.
 * @returns o escopo físico da linha.
 */
export function scopeOf(row: DomainRow): RowScope {
  const value = row.value as { org_id?: unknown, tenant_id?: unknown } | null
  const orgId = typeof value?.org_id === 'string' ? value.org_id : ''
  const tenantId = typeof value?.tenant_id === 'string' ? value.tenant_id : ''
  if (orgId === '' || tenantId === '') {
    throw new MigrationError('SCOPE_MISSING', `a linha "${row.key}" não diz a que organização e inquilino pertence`)
  }
  return { orgId, tenantId }
}

/** Um achado de verificação, escrito para quem opera, não para quem programou. */
export interface VerificationFinding {
  readonly kind: 'missing' | 'extra' | 'different'
  readonly key: string
}

export interface VerificationReport {
  readonly source: number
  readonly target: number
  readonly sourceDigest: string
  readonly targetDigest: string
  readonly findings: readonly VerificationFinding[]
  readonly verified: boolean
}

/**
 * Compara os dois lados, registro a registro e no conjunto.
 *
 * `missing` é o que existia e não chegou. `extra` é o que chegou e não existia
 * — que numa migração é tão grave quanto o que sumiu, porque significa que o
 * destino não estava vazio e alguém está prestes a declarar migrado um conjunto
 * misturado. `different` é a mesma chave com outro conteúdo.
 * @param source - as linhas do lado de origem.
 * @param target - as linhas do lado de destino.
 * @returns o relatório, com `verified` só quando não há nenhum achado.
 */
export function verifyMigration(source: readonly DomainRow[], target: readonly DomainRow[]): VerificationReport {
  const sourceByKey = new Map(source.map(row => [row.key, rowDigest(row)]))
  const targetByKey = new Map(target.map(row => [row.key, rowDigest(row)]))
  const findings: VerificationFinding[] = []
  for (const [key, digest] of sourceByKey) {
    const other = targetByKey.get(key)
    if (other === undefined) findings.push({ kind: 'missing', key })
    else if (other !== digest) findings.push({ kind: 'different', key })
  }
  for (const key of targetByKey.keys()) {
    if (!sourceByKey.has(key)) findings.push({ kind: 'extra', key })
  }
  findings.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.kind.localeCompare(right.kind)))
  const sourceDigest = payloadDigest(source)
  const targetDigest = payloadDigest(target)
  return {
    source: source.length,
    target: target.length,
    sourceDigest,
    targetDigest,
    findings,
    // Os dois testes têm de passar. O digest sozinho não diz QUAL chave está
    // errada, e a lista de achados sozinha não pegaria uma diferença numa
    // chave que os dois lados não tenham em comum.
    verified: findings.length === 0 && sourceDigest === targetDigest,
  }
}

/** O plano de cópia: cada linha com o escopo em que ela vai ser gravada. */
export interface MigrationStep {
  readonly key: string
  readonly value: unknown
  readonly scope: RowScope
}

/**
 * O plano de uma migração, montado ANTES de qualquer escrita.
 *
 * Montar tudo antes é o que permite a execução a seco: uma linha sem escopo
 * derruba o plano inteiro, e nada foi gravado ainda. Se o escopo fosse
 * resolvido durante a cópia, a migração pararia no meio com metade dos
 * registros de um lado e metade do outro.
 * @param rows - as linhas do lado de origem.
 * @returns um passo por linha, na ordem da chave.
 */
export function migrationPlan(rows: readonly DomainRow[]): readonly MigrationStep[] {
  return rows
    .map(row => ({ key: row.key, value: row.value, scope: scopeOf(row) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/**
 * Quantos registros por escopo. É o número que quem opera confere de olho.
 * @param steps - o plano já montado.
 * @returns a contagem por `org/tenant`, em ordem.
 */
export function scopeCounts(steps: readonly MigrationStep[]): readonly { readonly scope: string, readonly rows: number }[] {
  const counts = new Map<string, number>()
  for (const step of steps) {
    const name = `${step.scope.orgId}/${step.scope.tenantId}`
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].sort().map(([scope, rows]) => ({ scope, rows }))
}
