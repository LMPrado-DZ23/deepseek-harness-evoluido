import { describe, expect, it } from 'vitest'
import {
  MigrationError,
  canonicalJson,
  migrationPlan,
  payloadDigest,
  rowDigest,
  scopeCounts,
  scopeOf,
  verifyMigration,
  type DomainRow,
} from '../../../scripts/domain-rls-migration.ts'

function row(key: string, extra: Record<string, unknown> = {}): DomainRow {
  return { key, value: { org_id: 'org-1', tenant_id: 'tenant-1', state: 'PENDING', ...extra } }
}

describe('texto canônico', () => {
  it('a ordem das chaves não muda o texto', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    // Sem isto, dois registros IGUAIS gravados em ordens diferentes fariam a
    // verificação reprovar uma migração correta - e quem opera aprenderia a
    // ignorar a verificação.
    expect(rowDigest(row('a', { x: 1, y: 2 }))).toBe(rowDigest({ key: 'a', value: { y: 2, x: 1, org_id: 'org-1', tenant_id: 'tenant-1', state: 'PENDING' } }))
  })

  it('valores aninhados e listas também são canônicos', () => {
    expect(canonicalJson({ a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}]}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(undefined)).toBe('null')
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it('a lista NÃO é reordenada: ordem de lista é conteúdo', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})

describe('digest de registro', () => {
  it('a chave entra no digest', () => {
    // Sem a chave, duas linhas de conteúdo igual e chaves trocadas passariam:
    // a migração teria embaralhado identificadores sem ninguém ver.
    expect(rowDigest(row('a'))).not.toBe(rowDigest(row('b')))
  })

  it('o digest do conjunto não depende da ordem de leitura', () => {
    // A chave-valor e a tabela devolvem em ordens diferentes.
    expect(payloadDigest([row('a'), row('b')])).toBe(payloadDigest([row('b'), row('a')]))
  })

  it('o digest do conjunto muda quando uma linha muda', () => {
    expect(payloadDigest([row('a')])).not.toBe(payloadDigest([row('a', { state: 'DENIED' })]))
  })

  it('conjunto vazio tem digest próprio, e não é o de uma linha', () => {
    expect(payloadDigest([])).not.toBe(payloadDigest([row('a')]))
  })
})

describe('escopo da linha', () => {
  it('o escopo sai do registro', () => {
    expect(scopeOf(row('a'))).toEqual({ orgId: 'org-1', tenantId: 'tenant-1' })
  })

  it('linha sem escopo derruba a migração, e não recebe um escopo padrão', () => {
    // Um escopo inventado colocaria a linha EMBAIXO de alguém.
    for (const broken of [
      { key: 'a', value: { tenant_id: 'tenant-1' } },
      { key: 'a', value: { org_id: 'org-1' } },
      { key: 'a', value: { org_id: '', tenant_id: 'tenant-1' } },
      { key: 'a', value: null },
      { key: 'a', value: 'texto' },
    ]) {
      expect(() => scopeOf(broken), JSON.stringify(broken)).toThrow(MigrationError)
    }
    expect(() => scopeOf({ key: 'quebrada', value: null })).toThrow('quebrada')
  })
})

describe('plano', () => {
  it('o plano inteiro é montado antes de qualquer escrita', () => {
    // Uma linha sem escopo derruba o PLANO, com o destino ainda intocado. Se o
    // escopo fosse resolvido durante a cópia, a migração pararia no meio.
    expect(() => migrationPlan([row('a'), { key: 'b', value: {} }])).toThrow(MigrationError)
  })

  it('o plano sai em ordem de chave, com o escopo de cada linha', () => {
    const plan = migrationPlan([row('c'), row('a'), row('b', { org_id: 'org-2' })])
    expect(plan.map(step => step.key)).toEqual(['a', 'b', 'c'])
    expect(plan[1]!.scope).toEqual({ orgId: 'org-2', tenantId: 'tenant-1' })
  })

  it('a contagem por escopo é o número que quem opera confere', () => {
    expect(scopeCounts(migrationPlan([row('a'), row('b'), row('c', { tenant_id: 'tenant-2' })])))
      .toEqual([{ scope: 'org-1/tenant-1', rows: 2 }, { scope: 'org-1/tenant-2', rows: 1 }])
  })
})

describe('verificação', () => {
  it('dois lados iguais conferem', () => {
    const report = verifyMigration([row('a'), row('b')], [row('b'), row('a')])
    expect(report.verified).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.sourceDigest).toBe(report.targetDigest)
  })

  it('o que sumiu aparece como faltando', () => {
    const report = verifyMigration([row('a'), row('b')], [row('a')])
    expect(report.verified).toBe(false)
    expect(report.findings).toEqual([{ kind: 'missing', key: 'b' }])
  })

  it('o que chegou diferente NÃO passa por contagem igual', () => {
    // Contar linhas dos dois lados pega o que sumiu e não pega o que chegou
    // diferente. Numa autoridade de confirmação, um registro diferente é uma
    // confirmação com outro conteúdo do que a pessoa aprovou.
    const report = verifyMigration([row('a')], [row('a', { state: 'DENIED' })])
    expect({ source: report.source, target: report.target }).toEqual({ source: 1, target: 1 })
    expect(report.verified).toBe(false)
    expect(report.findings).toEqual([{ kind: 'different', key: 'a' }])
  })

  it('o que chegou a mais também reprova', () => {
    // Destino não vazio: alguém está prestes a declarar migrado um conjunto
    // misturado com o que já estava lá.
    const report = verifyMigration([row('a')], [row('a'), row('z')])
    expect(report.verified).toBe(false)
    expect(report.findings).toEqual([{ kind: 'extra', key: 'z' }])
  })

  it('migração de nada para nada confere, e diz que era nada', () => {
    const report = verifyMigration([], [])
    expect(report.verified).toBe(true)
    expect({ source: report.source, target: report.target }).toEqual({ source: 0, target: 0 })
  })

  it('os achados saem em ordem de chave, para o relatório ser lido', () => {
    const report = verifyMigration([row('b'), row('a')], [row('c')])
    expect(report.findings.map(finding => finding.key)).toEqual(['a', 'b', 'c'])
  })
})
