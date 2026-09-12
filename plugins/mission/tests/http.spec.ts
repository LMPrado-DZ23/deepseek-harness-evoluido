import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import { createMissionHttpHandler, MISSION_ROUTE_CONTRACTS } from '../src/http.ts'
import { missionKey, type MissionRecord, type MissionRunUsage } from '../src/model.ts'
import { StudioMissionService, type MissionRepository } from '../src/service.ts'

const session = { session_id: 's1', user_id: 'u1', org_id: 'org-a', tenant_id: 'ws-a' } as SessionRecord

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))))

/** Chaveado como a produção: escopo mais identificador. */
class MemoryRepository implements MissionRepository {
  readonly rows = new Map<string, MissionRecord>()
  missions = () => [...this.rows.values()]
  putMission = async (record: MissionRecord) => {
    this.rows.set(missionKey(record.org_id, record.tenant_id, record.mission_id), record)
  }
}

interface Options {
  readonly role?: 'owner' | 'admin' | 'builder' | 'viewer'
  readonly noMembership?: boolean
  readonly runs?: readonly MissionRunUsage[]
}

async function fixture(options: Options = {}) {
  const repository = new MemoryRepository()
  const service = new StudioMissionService({ repository, now: () => new Date('2026-09-12T00:00:00.000Z') })
  const identity = {
    authenticate: vi.fn(() => Promise.resolve(session)),
    validateCsrfToken: vi.fn(),
    cookiesAreSecure: false,
    assertRequestTrust: vi.fn(),
  }
  const tenancy = {
    authorizationFor: vi.fn(() => options.noMembership === true
      ? undefined
      : { userId: 'u1', orgId: 'org-a', tenantId: 'ws-a', role: options.role ?? 'owner' }),
  }
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const server = createServer(createMissionHttpHandler({
    service,
    identity: identity as unknown as StudioIdentityService,
    tenancy: tenancy as unknown as StudioTenancyService,
    allowedHosts, allowedOrigins,
    runs: () => options.runs ?? [],
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${String(port)}`
  const origin = `http://${host}`
  allowedHosts.push(host)
  allowedOrigins.push(origin)
  const headers = {
    host, origin, 'content-type': 'application/json',
    cookie: `${SESSION_COOKIE}=session-token; ${CSRF_COOKIE}=csrf-token`,
    'x-dz23-csrf': 'csrf-token',
  }
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}/api/studio/missions${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const criar = () => request('/missions', {
    method: 'POST',
    body: JSON.stringify({
      mission_id: 'm1', objective: 'Terminar o Studio com prova', max_total_tokens: 1_000,
      criteria: [{ criterion_id: 'suite', statement: 'A suite raiz passa inteira' }],
    }),
  })
  return { request, criar, repository, identity, tenancy, service }
}

describe('o contrato das rotas de missao', () => {
  it('toda rota e autorizada, com permissao e escopo do SERVIDOR', () => {
    // A mesma guarda que o hub tem: uma rota `public` ou `authenticated` aqui
    // seria uma porta sem papel, e um escopo diferente de espaco de trabalho
    // faria a conferencia acontecer contra outra fronteira.
    expect(MISSION_ROUTE_CONTRACTS).toHaveLength(6)
    for (const contract of MISSION_ROUTE_CONTRACTS) {
      expect(contract.access).toBe('authorized')
      expect(contract.permission).not.toBeNull()
      expect(contract.scope).toBe('workspace')
    }
  })

  it('ler pede `project.read` e mexer pede `project.write`', () => {
    const leitura = MISSION_ROUTE_CONTRACTS.filter(contract => contract.method === 'GET')
    expect(leitura.every(contract => contract.permission === 'project.read')).toBe(true)
    expect(MISSION_ROUTE_CONTRACTS.filter(contract => contract.method !== 'GET')
      .every(contract => contract.permission === 'project.write')).toBe(true)
  })
})

describe('a jornada inteira pela rota', () => {
  it('criar, registrar prova, declarar candidatura e concluir', async () => {
    const f = await fixture()
    const criada = await f.criar()
    expect(criada.status).toBe(201)
    const corpo = await criada.json() as { mission: { criteria: readonly { state: string }[]; completion: { kind: string } } }
    // Nasce sem prova, e o veredito derivado ja diz isso.
    expect(corpo.mission.criteria[0]!.state).toBe('UNPROVEN')
    expect(corpo.mission.completion.kind).toBe('UNPROVEN')

    // Concluir antes de provar e recusado, e o status diz que e conflito de
    // ESTADO, nao pedido malformado.
    expect((await f.request('/missions/m1/candidate', { method: 'POST' })).status).toBe(200)
    const cedo = await f.request('/missions/m1/complete', { method: 'POST' })
    expect(cedo.status).toBe(409)
    expect(await cedo.json()).toMatchObject({ error: expect.stringContaining('suite') })

    // Registrar a prova derruba a candidatura: a declaracao foi feita sobre
    // outro conjunto de provas.
    const provado = await f.request('/missions/m1/criteria/suite', {
      method: 'PATCH', body: JSON.stringify({ state: 'PROVEN', evidence: '2943 aprovados' }),
    })
    expect(provado.status).toBe(200)
    expect(await provado.json()).toMatchObject({ mission: { status: 'RUNNING', completion: { kind: 'PROVEN' } } })

    expect((await f.request('/missions/m1/candidate', { method: 'POST' })).status).toBe(200)
    const concluida = await f.request('/missions/m1/complete', { method: 'POST' })
    expect(concluida.status).toBe(200)
    expect(await concluida.json()).toMatchObject({ mission: { status: 'COMPLETED' } })
  })

  it('a listagem traz o gasto DERIVADO, que nao esta gravado', async () => {
    // `spend` e funcao do estado atual das execucoes: grava-lo criaria uma
    // segunda verdade que diverge no primeiro conserto.
    const f = await fixture({ runs: [{ run_id: 'r1', status: 'COMPLETED', tokens_used: 300 }] })
    await f.criar()
    await f.request('/missions/m1/criteria/suite', { method: 'PATCH', body: JSON.stringify({ state: 'UNPROVEN' }) })
    const lista = await (await f.request('/missions')).json() as { missions: readonly { spend: unknown }[] }
    expect(lista.missions[0]!.spend).toEqual({ kind: 'WITHIN', spent: 0, limit: 1_000 })
    expect([...f.repository.rows.values()][0]).not.toHaveProperty('spend')
  })

  it('um item comprovado SEM prova e recusado com 400, e a frase e do catalogo', async () => {
    const f = await fixture()
    await f.criar()
    const semProva = await f.request('/missions/m1/criteria/suite', {
      method: 'PATCH', body: JSON.stringify({ state: 'PROVEN' }),
    })
    expect(semProva.status).toBe(400)
    expect(await semProva.json()).toMatchObject({ error: expect.stringContaining('prova') })
  })
})

describe('quem pode o que', () => {
  it('leitor le e nao mexe', async () => {
    const dono = await fixture()
    await dono.criar()
    const leitor = await fixture({ role: 'viewer' })
    // Cada fixture tem o proprio armazenamento; aqui basta ver que a escrita e
    // recusada com 403 e a leitura passa com 200.
    expect((await leitor.request('/missions')).status).toBe(200)
    expect((await leitor.criar()).status).toBe(403)
  })

  it('sem matricula, nem ler', async () => {
    // Seguir sem papel obrigaria a inventar um.
    const f = await fixture({ noMembership: true })
    expect((await f.request('/missions')).status).toBe(403)
  })

  it('sessao invalida responde 401, e a frase e a da identidade', async () => {
    const f = await fixture()
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'Entre para continuar.'))
    const resposta = await f.request('/missions')
    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toEqual({ error: 'Entre para continuar.' })
  })
})

describe('o que a rota recusa', () => {
  it('endereco desconhecido responde 404', async () => {
    const f = await fixture()
    expect((await f.request('/inventado')).status).toBe(404)
  })

  it('missao inexistente responde 404', async () => {
    const f = await fixture()
    expect((await f.request('/missions/nao-existe')).status).toBe(404)
  })

  it('um identificador NAO atravessa barra', async () => {
    // Sem as ancoras da expressao, `/missions/a/b` casaria com a rota de uma
    // missao so e entregaria `a/b` como identificador.
    const f = await fixture()
    expect((await f.request('/missions/a/b')).status).toBe(404)
  })

  it('corpo que nao e JSON e recusado, e sem contar o que houve no servidor', async () => {
    const f = await fixture()
    const texto = await f.request('/missions', {
      method: 'POST', body: 'nao e json', headers: { 'content-type': 'text/plain' },
    })
    expect(texto.status).toBe(400)
    const corpo = await texto.json() as { error: string }
    expect(corpo.error).not.toContain('/home')
    expect(corpo.error.length).toBeGreaterThan(0)
  })

  it('campo desconhecido no corpo e recusado, com frase de catalogo', async () => {
    const f = await fixture()
    const extra = await f.request('/missions', {
      method: 'POST',
      body: JSON.stringify({
        mission_id: 'm2', objective: 'algo', max_total_tokens: null,
        criteria: [{ criterion_id: 'x', statement: 'algo' }], inventado: true,
      }),
    })
    expect(extra.status).toBe(400)
    // ZodError NAO chega ao cliente: ele carrega o JSON das issues.
    expect(await extra.json()).toMatchObject({ error: expect.not.stringContaining('unrecognized') })
  })

  it('criar duas vezes o mesmo identificador responde 400', async () => {
    const f = await fixture()
    expect((await f.criar()).status).toBe(201)
    expect((await f.criar()).status).toBe(400)
  })
})

describe('os caminhos que faltavam cobrir', () => {
  it('duas missoes criadas no MESMO instante saem em ordem estavel', async () => {
    // O relogio da fixture e fixo de proposito: sem o desempate por
    // identificador, a ordem de duas missoes do mesmo instante dependeria da
    // ordem de leitura do armazenamento, e a tela mudaria de ordem sozinha
    // entre dois carregamentos.
    const f = await fixture()
    await f.criar()
    await f.request('/missions', {
      method: 'POST',
      body: JSON.stringify({
        mission_id: 'a-primeira', objective: 'outra missao', max_total_tokens: null,
        criteria: [{ criterion_id: 'x', statement: 'algo' }],
      }),
    })
    const lista = await (await f.request('/missions')).json() as { missions: readonly { mission_id: string }[] }
    expect(lista.missions.map(item => item.mission_id)).toEqual(['a-primeira', 'm1'])
  })

  it('bloqueio externo registra o motivo, e o veredito muda de nome', async () => {
    const f = await fixture()
    await f.criar()
    const bloqueado = await f.request('/missions/m1/criteria/suite', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'BLOCKED_EXTERNAL', blocked_reason: 'aparelho Android fisico' }),
    })
    expect(bloqueado.status).toBe(200)
    expect(await bloqueado.json()).toMatchObject({
      mission: { completion: { kind: 'BLOCKED_EXTERNAL', reasons: ['aparelho Android fisico'] } },
    })
  })

  it('conta trancada responde 429, e nao 401', async () => {
    // A diferenca importa para quem esta do outro lado: 401 pede para entrar de
    // novo, 429 pede para esperar.
    const f = await fixture()
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('locked', 'Muitas tentativas.'))
    expect((await f.request('/missions')).status).toBe(429)
  })

  it('corpo grande demais e recusado antes de ser interpretado', async () => {
    const f = await fixture()
    const grande = await f.request('/missions', { method: 'POST', body: `{"objective":"${'a'.repeat(80 * 1024)}"}` })
    expect(grande.status).toBe(400)
  })
})

describe('ACHADO: a resposta levava o registro INTEIRO', () => {
  it('a missao devolvida tem exatamente os campos que a tela usa', async () => {
    // `{ ...record }` mandava `org_id`, `tenant_id` e a lista COMPLETA de
    // `run_ids` — identificadores internos e as execucoes de equipes e projetos
    // diferentes do inquilino — a qualquer pessoa com `project.read`, inclusive
    // quem so pode ler. A tela precisa de QUANTAS execucoes existem, nao de
    // quais.
    const f = await fixture()
    const corpo = await (await f.criar()).json() as { mission: Record<string, unknown> }
    expect(Object.keys(corpo.mission).sort()).toEqual([
      'completion', 'created_at', 'criteria', 'max_total_tokens',
      'mission_id', 'objective', 'run_count', 'spend', 'status', 'updated_at',
    ])
    expect(JSON.stringify(corpo.mission)).not.toContain('org-a')
    expect(JSON.stringify(corpo.mission)).not.toContain('ws-a')
  })

  it('a listagem tambem, e a contagem de trabalhos vem no lugar da lista', async () => {
    const f = await fixture()
    await f.criar()
    const lista = await (await f.request('/missions')).json() as { missions: readonly Record<string, unknown>[] }
    expect(lista.missions[0]).not.toHaveProperty('run_ids')
    expect(lista.missions[0]!.run_count).toBe(0)
  })
})
