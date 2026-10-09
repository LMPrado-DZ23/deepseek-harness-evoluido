/**
 * S-08: as RESPOSTAS do intake numa tabela por inquilino, contra PostgreSQL 16
 * de verdade — e a prova de que quem recusa o vazamento é o BANCO.
 *
 * Este é o primeiro dos cinco domínios alcançáveis do plano do `S-08`, e foi
 * escolhido por ser o de menor superfície: no serviço inteiro só existem dois
 * pontos que tocam as respostas. Se a travessia der errado, ela não derruba a
 * criação do aplicativo, que é a única coisa que o produto faz.
 *
 * O teste que importa aqui é o ÚLTIMO: a política é DERRUBADA e o vazamento
 * volta a acontecer. Sem ele, este arquivo provaria apenas que um `if` do
 * produto funciona — que é exatamente o que já existia antes da migração, e o
 * motivo de a RLS ter sido pedida.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgresTenantRecordStore } from '../src/tenant-store.ts'
// Por CAMINHO RELATIVO, e não pelo nome do pacote: `storage-postgres` não
// depende de `prompt-to-app`, e não pode passar a depender só para ter um
// teste. A dependência invertida entraria no lockfile de release e no lock da
// imagem, e um teste não pode mudar o que é publicado.
import {
  INTAKE_TURN_UNIT,
  listIntakeTurns,
  putIntakeTurn,
} from '../../prompt-to-app/src/intake-turn-store.ts'
import {
  DESIGN_SPEC_UNIT,
  listDesignSpecs,
  putDesignSpec,
} from '../../prompt-to-app/src/design-spec-store.ts'
import {
  APP_SPEC_UNIT,
  listAppSpecs,
  putAppSpec,
} from '../../prompt-to-app/src/app-spec-store.ts'
import {
  PLAN_UNIT,
  listPlans,
  putPlanRecord,
  PLAN_TABLE,
} from '../../prompt-to-app/src/plan-store.ts'
import {
  EVIDENCE_UNIT,
  listEvidence,
  putEvidenceRecord,
} from '../../prompt-to-app/src/evidence-store.ts'
import type { StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan } from '../../prompt-to-app/src/model.ts'
import { createDesignSpec } from '../../prompt-to-app/src/design.ts'
import { migrationPlan, scopeCounts, verifyMigration, type DomainRow } from '../../../scripts/domain-rls-migration.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const cleanup: Array<() => Promise<void>> = []

function turn(id: string, overrides: Record<string, unknown> = {}): StudioIntakeTurn {
  return {
    turn_id: `turn-${id}`, project_id: 'projeto-1', org_id: 'org-a', tenant_id: 'tenant-a',
    question_id: 'audience', question: 'Para quem?', answer: 'Clientes locais',
    recommended: false, route: 'ollama', model: 'qwen',
    created_at: `2026-09-08T00:0${id}:00.000Z`,
    ...overrides,
  } as StudioIntakeTurn
}

describePostgres('S-08 — respostas do intake e escolhas de visual na tabela por inquilino', () => {
  it('isola por inquilino, mantém a ordem e VOLTA a vazar quando a política cai', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const schema = `s08_${suffix}`
    const role = `s08_runtime_${suffix}`
    const password = randomBytes(24).toString('hex')
    const admin = new Client({ connectionString: dsn, ssl: false })
    await admin.connect()
    let store: PostgresTenantRecordStore | undefined
    cleanup.push(async () => {
      await store?.close().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)
    store = await PostgresTenantRecordStore.create({
      adminConnectionString: dsn!, runtimeConnectionString: runtimeConnectionString(dsn!, role, password),
      schema, ssl: false, poolMax: 4,
    })

    const a = { orgId: 'org-a', tenantId: 'tenant-a' }
    const b = { orgId: 'org-b', tenantId: 'tenant-b' }
    // Gravadas FORA de ordem de propósito: a ordem é parte do contrato, e a
    // tabela não promete nenhuma. Quem ordena é o nosso código.
    await putIntakeTurn(store, turn('3'))
    await putIntakeTurn(store, turn('1'))
    await putIntakeTurn(store, turn('2', { question_id: 'goal', answer: 'Conhecer os serviços' }))
    await putIntakeTurn(store, turn('9', { org_id: 'org-b', tenant_id: 'tenant-b', answer: 'SEGREDO DO OUTRO INQUILINO' }))

    const mine = await listIntakeTurns(store, a)
    expect(mine.map(row => row.turn_id)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    // O intake decide a PRÓXIMA pergunta a partir das respostas já dadas: uma
    // lista embaralhada faria ele repetir pergunta e a tela mostrar a conversa
    // fora de ordem.
    expect(mine.map(row => row.answer)).toEqual(['Clientes locais', 'Conhecer os serviços', 'Clientes locais'])

    // O outro inquilino não aparece. E quem recusa aqui é o banco.
    expect(JSON.stringify(mine)).not.toContain('SEGREDO DO OUTRO INQUILINO')
    const theirs = await listIntakeTurns(store, b)
    expect(theirs.map(row => row.turn_id)).toEqual(['turn-9'])

    // ── FALSIFICAÇÃO ────────────────────────────────────────────────────────
    // Sem isto o teste acima provaria apenas que o nosso filtro funciona — que
    // é o que já existia ANTES da migração. Derrubando a política, o vazamento
    // tem de voltar: se ele não voltar, a RLS não era o que estava segurando.
    // A tabela física é UMA só (`tenant_records`), com a unidade e a tabela
    // lógica como colunas — então a política que estamos derrubando é a MESMA
    // que protege todos os domínios já migrados. É a guarda inteira sob teste,
    // e não uma cópia dela feita para este arquivo.
    const rows = await admin.query<{ unit: string; count: string }>(
      `SELECT unit, count(*)::text AS count FROM "${schema}"."tenant_records" GROUP BY unit`,
    )
    expect(rows.rows.find(row => row.unit === INTAKE_TURN_UNIT)?.count).toBe('4')
    expect(rows.rows.every(row => row.unit === INTAKE_TURN_UNIT)).toBe(true)
    await admin.query(`ALTER TABLE "${schema}"."tenant_records" DISABLE ROW LEVEL SECURITY`)

    const leaked = await listIntakeTurns(store, a)
    expect(leaked.length, 'a política caiu e MESMO ASSIM não vazou: a RLS não era o que segurava').toBe(4)
    expect(JSON.stringify(leaked)).toContain('SEGREDO DO OUTRO INQUILINO')

    // Recolocada, o isolamento volta — sem reiniciar nada.
    await admin.query(`ALTER TABLE "${schema}"."tenant_records" ENABLE ROW LEVEL SECURITY`)
    expect((await listIntakeTurns(store, a)).length).toBe(3)

    // ── o SEGUNDO domínio, na mesma tabela física e sob a mesma política ────
    // As escolhas de visual são o que o pipeline usa para pintar o aplicativo,
    // e a versão MAIS ALTA é a que vale: numa lista fora de ordem a pessoa
    // receberia o visual antigo depois de já ter trocado, sem saber por quê.
    await putDesignSpec(store, design('d1', 1))
    await putDesignSpec(store, design('d3', 3))
    await putDesignSpec(store, design('d2', 2))
    await putDesignSpec(store, design('d9', 1, { org_id: 'org-b', tenant_id: 'tenant-b' }))
    const designs = await listDesignSpecs(store, a)
    expect(designs.map(row => row.version)).toEqual([3, 2, 1])
    expect(designs.map(row => row.design_id)).toEqual(['d3', 'd2', 'd1'])
    expect((await listDesignSpecs(store, b)).map(row => row.design_id)).toEqual(['d9'])

    // A unidade é OUTRA, e ela também é filtrada: um domínio não enxerga o do
    // vizinho por acidente de estarem na mesma tabela.
    // ── o TERCEIRO domínio: a especificação, que é o que a pessoa aprovou ──
    // Se a versão errada atravessar, o Studio constrói uma coisa que ninguém
    // pediu — e constrói com convicção.
    await putAppSpec(store, spec('s2', 2))
    await putAppSpec(store, spec('s1', 1))
    await putAppSpec(store, spec('s7', 1, { org_id: 'org-b', tenant_id: 'tenant-b' }))
    expect((await listAppSpecs(store, a)).map(row => row.spec_id)).toEqual(['s2', 's1'])
    expect((await listAppSpecs(store, b)).map(row => row.spec_id)).toEqual(['s7'])

    // ── o QUARTO: o plano, onde mora a autorização de escrita do gerador ───
    // Ler a revisão errada aqui não produz um aplicativo com defeito: produz
    // um aplicativo que escreve onde não devia.
    await putPlanRecord(store, planOf('p1', 1))
    await putPlanRecord(store, planOf('p3', 3))
    await putPlanRecord(store, planOf('p2', 2))
    await putPlanRecord(store, planOf('p8', 1, { org_id: 'org-b', tenant_id: 'tenant-b' }))
    expect((await listPlans(store, a)).map(row => row.plan_id)).toEqual(['p3', 'p2', 'p1'])
    expect((await listPlans(store, b)).map(row => row.plan_id)).toEqual(['p8'])

    // ── o QUINTO e último: as evidências, que contam o que aconteceu ───────
    // Uma evidência do inquilino errado atravessando não quebra a criação: ela
    // conta a história de OUTRA pessoa a quem abrir o relato.
    await putEvidenceRecord(store, evidenceOf('e2', '2026-09-08T00:02:00.000Z'))
    await putEvidenceRecord(store, evidenceOf('e1', '2026-09-08T00:01:00.000Z'))
    await putEvidenceRecord(store, evidenceOf('e5', '2026-09-08T00:05:00.000Z', { org_id: 'org-b', tenant_id: 'tenant-b' }))
    expect((await listEvidence(store, a)).map(row => row.evidence_id)).toEqual(['e1', 'e2'])
    expect((await listEvidence(store, b)).map(row => row.evidence_id)).toEqual(['e5'])

    // ── a TRAVESSIA de dados de uma instalação que já roda ─────────────────
    // Os cinco domínios saem do padrão `kv`, então uma instalação existente vai
    // ter linhas na chave-valor no dia em que trocar de autoridade. O roteiro
    // genérico do S-09 (`domain-rls-migration`) atende os cinco sem mudança —
    // e é isso que este trecho prova, com o mais delicado deles.
    //
    // A verificação é registro a registro, não por contagem: contar pega o que
    // sumiu e NÃO pega o que chegou diferente — e um plano que chega diferente
    // é outra autorização de escrita.
    const kv: DomainRow[] = [
      { key: 'k1', value: planOf('k1', 1, { project_id: 'projeto-2' }) },
      { key: 'k2', value: planOf('k2', 2, { project_id: 'projeto-2' }) },
      { key: 'k3', value: planOf('k3', 1, { project_id: 'projeto-2', org_id: 'org-b', tenant_id: 'tenant-b' }) },
    ]
    const steps = migrationPlan(kv)
    expect(scopeCounts(steps)).toEqual([
      { scope: 'org-a/tenant-a', rows: 2 },
      { scope: 'org-b/tenant-b', rows: 1 },
    ])
    for (const step of steps) await store.put(step.scope, PLAN_UNIT, PLAN_TABLE, step.key, step.value)

    const migrated: DomainRow[] = []
    for (const scope of [a, b]) {
      for (const row of await store.list(scope, PLAN_UNIT, PLAN_TABLE)) {
        if (kv.some(candidate => candidate.key === row.key)) migrated.push({ key: row.key, value: row.value })
      }
    }
    const report = verifyMigration(kv, migrated)
    expect(report.findings).toEqual([])
    expect(report.sourceDigest).toBe(report.targetDigest)

    const units = await admin.query<{ unit: string }>(
      `SELECT DISTINCT unit FROM "${schema}"."tenant_records" ORDER BY unit`,
    )
    expect(units.rows.map(row => row.unit)).toEqual([APP_SPEC_UNIT, DESIGN_SPEC_UNIT, EVIDENCE_UNIT, INTAKE_TURN_UNIT, PLAN_UNIT].sort())
    expect((await listIntakeTurns(store, a)).length).toBe(3)
  }, 60_000)
})

function spec(id: string, version: number, overrides: Record<string, unknown> = {}): StudioAppSpecRecord {
  return {
    spec_id: id, project_id: 'projeto-1', org_id: 'org-a', tenant_id: 'tenant-a',
    version, app_spec: {}, sha256: 'd'.repeat(64), origin: 'intake',
    created_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  } as StudioAppSpecRecord
}

function design(id: string, version: number, overrides: Record<string, unknown> = {}): StudioDesignSpecRecord {
  return {
    design_id: id, project_id: 'projeto-1', org_id: 'org-a', tenant_id: 'tenant-a',
    version, design_spec: createDesignSpec({ preset: 'modern' }), sha256: 'c'.repeat(64),
    created_by: 'user-1', created_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  } as StudioDesignSpecRecord
}

afterAll(async () => { for (const step of cleanup.reverse()) await step() })

function runtimeConnectionString(adminDsn: string, role: string, password: string): string {
  const url = new URL(adminDsn)
  url.username = role
  url.password = password
  return url.toString()
}

function planOf(id: string, revision: number, overrides: Record<string, unknown> = {}): StudioPlan {
  return {
    plan_id: id, spec_id: 's1', project_id: 'projeto-1', org_id: 'org-a', tenant_id: 'tenant-a',
    revision, status: 'PROPOSED',
    slices: [{ slice_id: 'f1', title: 'Início', description: 'Mostrar', acceptance_criteria: ['aparece'], planned_files: ['src/GeneratedApp.tsx'] }],
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  } as StudioPlan
}

function evidenceOf(id: string, createdAt: string, overrides: Record<string, unknown> = {}): StudioEvidence {
  return {
    evidence_id: id, run_id: 'run-1', project_id: 'projeto-1', org_id: 'org-a', tenant_id: 'tenant-a',
    kind: 'diff', sha256: 'e'.repeat(64), size_bytes: 10, relative_path: `run-1/${id}.json`,
    created_at: createdAt,
    ...overrides,
  } as StudioEvidence
}
