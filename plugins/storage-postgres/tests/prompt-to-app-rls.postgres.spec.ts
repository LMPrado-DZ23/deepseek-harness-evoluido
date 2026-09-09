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
import type { StudioDesignSpecRecord, StudioIntakeTurn } from '../../prompt-to-app/src/model.ts'
import { createDesignSpec } from '../../prompt-to-app/src/design.ts'

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
    const units = await admin.query<{ unit: string }>(
      `SELECT DISTINCT unit FROM "${schema}"."tenant_records" ORDER BY unit`,
    )
    expect(units.rows.map(row => row.unit)).toEqual([DESIGN_SPEC_UNIT, INTAKE_TURN_UNIT].sort())
    expect((await listIntakeTurns(store, a)).length).toBe(3)
  }, 60_000)
})

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
