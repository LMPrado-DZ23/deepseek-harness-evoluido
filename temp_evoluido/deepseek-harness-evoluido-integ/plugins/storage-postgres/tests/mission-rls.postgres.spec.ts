/**
 * As MISSÕES numa tabela por inquilino, contra PostgreSQL 16 de verdade.
 *
 * `studio_missions` era o único domínio classificado `ready` na auditoria do
 * `S-08` (ADR-044), e a `OS-49` cumpriu a classificação. Este arquivo é a prova
 * que faltava para o `T-14`: até aqui o motor de missão só tinha sido exercido
 * contra dublês em memória.
 *
 * Três coisas são provadas, e nenhuma delas é "o nosso filtro funciona":
 *
 * 1. quem recusa o vazamento é o BANCO — a política é DERRUBADA e o vazamento
 *    volta. Sem isso, este arquivo provaria apenas o `if` que já existia antes
 *    da migração, que é o motivo de a RLS ter sido pedida;
 * 2. a gravação condicional acontece DENTRO da instrução, com duas conexões
 *    separadas — que é o que duas réplicas são do ponto de vista do banco;
 * 3. o SERVIÇO inteiro roda sobre essa tabela, e não só o repositório: criar,
 *    comprovar, candidatar e concluir, com a recusa de conclusão sem prova
 *    chegando do motor e não do teste.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgresTenantRecordStore } from '../src/tenant-store.ts'
// Por CAMINHO RELATIVO, e não pelo nome do pacote: `storage-postgres` não
// depende de `mission`, e não pode passar a depender só para ter um teste. A
// dependência invertida entraria no lockfile de release e no lock da imagem.
import {
  MISSION_TENANT_TABLE,
  MISSION_TENANT_UNIT,
  TenantRecordMissionRepository,
} from '../../mission/src/tenant-repository.ts'
import { MissionError, StudioMissionService, type MissionActor } from '../../mission/src/service.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const cleanup: Array<() => Promise<void>> = []

const DONO: MissionActor = { userId: 'u1', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const OUTRO: MissionActor = { userId: 'u2', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' }

function runtimeConnectionString(adminDsn: string, role: string, password: string): string {
  const url = new URL(adminDsn)
  url.username = role
  url.password = password
  return url.toString()
}

describePostgres('S-08 / T-14 — missões na tabela por inquilino, contra PostgreSQL real', () => {
  it('isola pelo BANCO, grava sob condição entre conexões, e carrega o serviço inteiro', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const schema = `missao_${suffix}`
    const role = `missao_runtime_${suffix}`
    const password = randomBytes(24).toString('hex')
    const admin = new Client({ connectionString: dsn, ssl: false })
    await admin.connect()
    let store: PostgresTenantRecordStore | undefined
    let vizinho: PostgresTenantRecordStore | undefined
    cleanup.push(async () => {
      await store?.close().catch(() => undefined)
      await vizinho?.close().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)
    const runtime = runtimeConnectionString(dsn!, role, password)
    store = await PostgresTenantRecordStore.create({
      adminConnectionString: dsn!, runtimeConnectionString: runtime, schema, ssl: false, poolMax: 4,
    })

    const service = new StudioMissionService({ repository: new TenantRecordMissionRepository(store) })
    const vizinhoService = new StudioMissionService({ repository: new TenantRecordMissionRepository(store) })

    // ── o serviço inteiro, e não só o repositório ──────────────────────────
    await service.create(DONO, {
      missionId: 'lancar', objective: 'Colocar o site no ar', maxTotalTokens: 1_000,
      criteria: [
        { criterion_id: 'formulario', statement: 'O formulario envia de verdade' },
        { criterion_id: 'dominio', statement: 'O endereco aponta para a hospedagem' },
      ],
    })
    await vizinhoService.create(OUTRO, {
      missionId: 'lancar', objective: 'SEGREDO DO OUTRO INQUILINO', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo do vizinho' }],
    })

    // O MESMO identificador nas duas organizações. Sob a chave-valor plana isso
    // já apagou uma missão com a outra (achado da OS-46); aqui a chave primária
    // leva o escopo e o banco separa.
    const minhas = await service.missions(DONO)
    expect(minhas.map(row => row.mission_id)).toEqual(['lancar'])
    expect(minhas[0]!.objective).toBe('Colocar o site no ar')
    expect(JSON.stringify(minhas)).not.toContain('SEGREDO DO OUTRO INQUILINO')
    expect((await vizinhoService.missions(OUTRO))[0]!.objective).toBe('SEGREDO DO OUTRO INQUILINO')

    // Marcar como terminado NÃO encerra: quem confere é o encerramento, e ele
    // recusa sobre o registro que veio do banco.
    const candidata = await service.declareCandidate(DONO, 'lancar')
    expect(candidata.status).toBe('CANDIDATE_COMPLETED')
    expect(candidata.revision).toBeGreaterThan(0)
    await expect(service.complete(DONO, 'lancar')).rejects.toBeInstanceOf(MissionError)

    // Mexer num item DESFAZ a candidatura: o registro volta a andar, e quem
    // marcou terminado precisa marcar de novo depois de mexer. Isso é o produto
    // se recusando a deixar uma candidatura velha valer por um estado novo.
    const voltou = await service.recordCriterion(DONO, 'lancar', 'dominio', { state: 'BLOCKED_EXTERNAL', blockedReason: 'a empresa que registra o endereco' })
    expect(voltou.status).toBe('RUNNING')
    await service.recordCriterion(DONO, 'lancar', 'formulario', { state: 'PROVEN', evidence: 'envio gravado em 08/09' })

    // Um item PARADO POR FORA também não deixa encerrar: falta de trabalho e
    // falta de gente são coisas diferentes, e nenhuma das duas é conclusão.
    await service.declareCandidate(DONO, 'lancar')
    await expect(service.complete(DONO, 'lancar')).rejects.toBeInstanceOf(MissionError)

    // Com os dois comprovados, encerra.
    await service.recordCriterion(DONO, 'lancar', 'dominio', { state: 'PROVEN', evidence: 'apontamento conferido em 09/09' })
    await service.declareCandidate(DONO, 'lancar')
    const concluida = await service.complete(DONO, 'lancar')
    expect(concluida.status).toBe('COMPLETED')
    expect(concluida.completed_at).not.toBeNull()

    // ── a gravação condicional, com DUAS conexões ──────────────────────────
    // Duas réplicas são, do ponto de vista do banco, dois armazenamentos com
    // conexões separadas sobre o mesmo esquema. A fila em memória do serviço
    // não alcança a outra: quem alcança é a revisão dentro da instrução.
    vizinho = await PostgresTenantRecordStore.create({
      adminConnectionString: dsn!, runtimeConnectionString: runtime, schema, ssl: false, poolMax: 4,
    })
    const aqui = new TenantRecordMissionRepository(store)
    const la = new TenantRecordMissionRepository(vizinho)
    const lida = (await aqui.missions({ orgId: 'org-a', tenantId: 'tenant-a' }))[0]!
    const alterada = { ...lida, revision: lida.revision + 1, objective: 'a versao daqui' }
    const rival = { ...lida, revision: lida.revision + 1, objective: 'a versao de la' }
    const [umaGravou, outraGravou] = await Promise.all([
      aqui.putMission(alterada, lida.revision),
      la.putMission(rival, lida.revision),
    ])
    expect([umaGravou, outraGravou].filter(Boolean), 'as duas gravaram sobre a mesma revisao: a condicao nao estava no banco').toHaveLength(1)
    const depois = (await aqui.missions({ orgId: 'org-a', tenantId: 'tenant-a' }))[0]!
    expect(depois.revision).toBe(lida.revision + 1)
    expect(['a versao daqui', 'a versao de la']).toContain(depois.objective)

    // E a perdedora não pode tentar de novo com a revisão velha.
    await expect(la.putMission({ ...lida, revision: lida.revision + 1, objective: 'insistindo' }, lida.revision))
      .resolves.toBe(false)

    // Criar a mesma missão de novo também é recusado pelo banco, e não por uma
    // conferência anterior deste processo.
    await expect(aqui.putMission({ ...lida, revision: 0, objective: 'de novo' }, 'new')).resolves.toBe(false)

    // ── FALSIFICAÇÃO ────────────────────────────────────────────────────────
    // Sem isto, tudo acima provaria apenas que o nosso filtro funciona — que é
    // o que já existia ANTES da migração. Derrubando a política, o vazamento
    // tem de voltar.
    const contagem = await admin.query<{ unit: string; count: string }>(
      `SELECT unit, count(*)::text AS count FROM "${schema}"."tenant_records" GROUP BY unit`,
    )
    expect(contagem.rows.find(row => row.unit === MISSION_TENANT_UNIT)?.count).toBe('2')
    expect(contagem.rows.every(row => row.unit === MISSION_TENANT_UNIT)).toBe(true)
    await admin.query(`ALTER TABLE "${schema}"."tenant_records" DISABLE ROW LEVEL SECURITY`)

    // A leitura crua do armazenamento passa a trazer as duas linhas: é a RLS
    // que estava segurando, e não o nosso código.
    const cru = await store.list(
      { orgId: 'org-a', tenantId: 'tenant-a' }, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE,
    )
    expect(cru.length, 'a politica caiu e MESMO ASSIM nao vazou: a RLS nao era o que segurava').toBe(2)
    expect(JSON.stringify(cru)).toContain('SEGREDO DO OUTRO INQUILINO')

    // E a SEGUNDA tranca — a conferência do escopo dentro do corpo, que o
    // repositório faz na leitura — continua valendo mesmo com a política caída.
    // Ela não substitui a RLS: ela é o que sobra quando a RLS falha.
    const comPoliticaCaida = await aqui.missions({ orgId: 'org-a', tenantId: 'tenant-a' })
    expect(comPoliticaCaida).toHaveLength(1)
    expect(JSON.stringify(comPoliticaCaida)).not.toContain('SEGREDO DO OUTRO INQUILINO')

    await admin.query(`ALTER TABLE "${schema}"."tenant_records" ENABLE ROW LEVEL SECURITY`)
    expect((await store.list({ orgId: 'org-a', tenantId: 'tenant-a' }, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE))).toHaveLength(1)
  }, 60_000)
})

afterAll(async () => { for (const step of cleanup.reverse()) await step() })
