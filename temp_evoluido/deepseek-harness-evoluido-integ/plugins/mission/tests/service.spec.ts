import { describe, expect, it } from 'vitest'
import { MAX_RUNS_PER_MISSION, missionKey, missionRecordSchema, type MissionCriterion, type MissionRecord, type MissionRunUsage } from '../src/model.ts'
import {
  completionDiagnostic, MissionError, missionCompletion, missionSpend, StudioMissionService,
  type MissionActor, type MissionRepository, type MissionScope,
} from '../src/service.ts'

const ACTOR: MissionActor = { userId: 'u1', orgId: 'org-a', tenantId: 'ws-a', role: 'owner' }
const OUTRO: MissionActor = { userId: 'u2', orgId: 'org-b', tenantId: 'ws-b', role: 'owner' }
/** Leitor: le tudo, nao escreve nada. E o papel que separa ler de mexer. */
const LEITOR: MissionActor = { ...ACTOR, userId: 'u3', role: 'viewer' }

/**
 * O armazenamento de prova, chaveado COMO A PRODUÇÃO.
 *
 * Ele chaveava por `(mission_id, org_id, tenant_id)` enquanto a produção
 * chaveava só por `mission_id` — e essa diferença escondeu um defeito grave: o
 * teste "o mesmo identificador em OUTRA organização não colide" passava por
 * causa do duble, e na produção a segunda criação APAGAVA a primeira. Um duble
 * mais cuidadoso que o produto não testa o produto.
 */
class MemoryRepository implements MissionRepository {
  readonly rows = new Map<string, MissionRecord>()
  missions = async (scope: MissionScope) => [...this.rows.values()]
    .filter(row => row.org_id === scope.orgId && row.tenant_id === scope.tenantId)

  putMission = async (record: MissionRecord, expected: 'new' | number) => {
    const key = missionKey(record.org_id, record.tenant_id, record.mission_id)
    const current = this.rows.get(key)
    if (expected === 'new' ? current !== undefined : current?.revision !== expected) return false
    this.rows.set(key, record)
    return true
  }
}

function fixture(now = '2026-09-12T00:00:00.000Z') {
  const repository = new MemoryRepository()
  const service = new StudioMissionService({ repository, now: () => new Date(now) })
  return { repository, service }
}

async function comMissao(maxTotalTokens: number | null = null) {
  const f = fixture()
  await f.service.create(ACTOR, {
    missionId: 'm1', objective: 'Terminar o Studio com prova', maxTotalTokens,
    criteria: [
      { criterion_id: 'suite', statement: 'A suite raiz passa inteira' },
      { criterion_id: 'leiga', statement: 'Uma pessoa leiga consegue criar um aplicativo' },
    ],
  })
  return f
}

const criterio = (over: Partial<MissionCriterion> = {}): MissionCriterion => ({
  criterion_id: 'c1', statement: 'algo verdadeiro', state: 'UNPROVEN', evidence: null, blocked_reason: null, ...over,
})

const run = (run_id: string, tokens_used: number | null | undefined, status = 'COMPLETED'): MissionRunUsage =>
  ({ run_id, status, ...(tokens_used === undefined ? {} : { tokens_used }) })

describe('o executor NAO declara concluida: ele declara candidatura, e a prova decide', () => {
  it('concluir recusa enquanto um item nao estiver comprovado, e diz quais', async () => {
    // E o ponto inteiro deste motor. Aceitar `COMPLETED` porque quem executou
    // disse que terminou nao e verificar nada: e copiar a autoavaliacao do
    // executor para um campo e dar a ela a aparencia de fato conferido.
    const f = await comMissao()
    await f.service.declareCandidate(ACTOR, 'm1')
    await expect(f.service.complete(ACTOR, 'm1')).rejects.toThrow(/suite, leiga/u)
    expect((await f.service.mission(ACTOR, 'm1')).status).toBe('CANDIDATE_COMPLETED')
  })

  it('concluir exige ter passado pela candidatura', async () => {
    const f = await comMissao()
    await expect(f.service.complete(ACTOR, 'm1')).rejects.toBeInstanceOf(MissionError)
  })

  it('com tudo comprovado, concluir passa e registra quando', async () => {
    // Uma conferencia que recusa tudo nao e conferencia, e produto quebrado.
    const f = await comMissao()
    await f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'PROVEN', evidence: '2895 passed | 66 skipped' })
    await f.service.recordCriterion(ACTOR, 'm1', 'leiga', { state: 'PROVEN', evidence: 'sessao gravada em docs/proofs/U-04.md' })
    await f.service.declareCandidate(ACTOR, 'm1')
    const concluida = await f.service.complete(ACTOR, 'm1')
    expect(concluida.status).toBe('COMPLETED')
    expect(concluida.completed_at).toBe('2026-09-12T00:00:00.000Z')
  })

  it('mudar um item DEPOIS da candidatura derruba a candidatura', async () => {
    // Quem declarou candidatura declarou sobre OUTRO conjunto de provas. Manter
    // a candidatura de pe deixaria `complete` decidir sobre uma declaracao que
    // nunca foi feita sobre estes criterios.
    const f = await comMissao()
    await f.service.declareCandidate(ACTOR, 'm1')
    const depois = await f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'PROVEN', evidence: 'saida da suite' })
    expect(depois.status).toBe('RUNNING')
    expect(depois.candidate_at).toBeNull()
  })

  it('nenhum item nasce comprovado, nem quando o chamador MANDA que nasca', async () => {
    // Deixar o chamador escolher o estado inicial permitiria criar uma missao
    // ja concluida, que e a fraude mais barata contra este motor.
    //
    // A primeira versao deste teste so criava a missao pelo caminho normal e
    // PASSOU com o defeito de volta: o tipo de `create` ja recusa `state`, mas
    // o tipo nao acompanha um chamador que atravesse HTTP. Agora o teste manda
    // o campo proibido de proposito, como a fronteira mandaria.
    const f = fixture()
    await f.service.create(ACTOR, {
      missionId: 'm1', objective: 'Terminar o Studio com prova', maxTotalTokens: null,
      criteria: [{
        criterion_id: 'suite', statement: 'A suite raiz passa inteira',
        state: 'PROVEN', evidence: 'inventada pelo chamador', blocked_reason: null,
      } as unknown as Pick<MissionCriterion, 'criterion_id' | 'statement'>],
    })
    const gravado = (await f.service.mission(ACTOR, 'm1')).criteria[0]!
    expect(gravado.state).toBe('UNPROVEN')
    expect(gravado.evidence).toBeNull()
  })
})

describe('comprovado sem prova nao e comprovado', () => {
  it('`PROVEN` sem evidencia e recusado pelo esquema', () => {
    const semProva = missionCriterionSchemaSafe({ state: 'PROVEN', evidence: null })
    expect(semProva).toBe(false)
    expect(missionCriterionSchemaSafe({ state: 'PROVEN', evidence: 'docs/proofs/x.md' })).toBe(true)
  })

  it('bloqueio sem motivo, e motivo sem bloqueio, sao os dois recusados', () => {
    // O segundo e o que passa despercebido: um motivo que sobrou de um estado
    // anterior mente sobre o presente para quem le a linha sem olhar o estado.
    expect(missionCriterionSchemaSafe({ state: 'BLOCKED_EXTERNAL', blocked_reason: null })).toBe(false)
    expect(missionCriterionSchemaSafe({ state: 'BLOCKED_EXTERNAL', blocked_reason: 'chave de LLM real' })).toBe(true)
    expect(missionCriterionSchemaSafe({ state: 'UNPROVEN', blocked_reason: 'sobrou daqui' })).toBe(false)
  })

  it('o servico recusa gravar um item comprovado sem dizer onde esta a prova', async () => {
    const f = await comMissao()
    await expect(f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'PROVEN' })).rejects.toBeInstanceOf(MissionError)
  })
})

describe('a ordem das perguntas: refutado vem antes de nao-provado, que vem antes de bloqueado', () => {
  it('um item refutado aparece mesmo havendo bloqueio externo junto', () => {
    // Uma missao com um item REFUTADO e outro parado por falta de credencial
    // nao esta esperando credencial. Dizer que esta manda a pessoa atras da
    // credencial em vez de atras do erro.
    const verdict = missionCompletion([
      criterio({ criterion_id: 'bloqueado', state: 'BLOCKED_EXTERNAL', blocked_reason: 'aparelho fisico' }),
      criterio({ criterion_id: 'refutado', state: 'REFUTED' }),
      criterio({ criterion_id: 'aberto', state: 'UNPROVEN' }),
    ])
    expect(verdict).toEqual({ kind: 'REFUTED', criteria: ['refutado'] })
  })

  it('sem refutado, o que falta trabalho vem antes do que falta gente', () => {
    const verdict = missionCompletion([
      criterio({ criterion_id: 'bloqueado', state: 'BLOCKED_EXTERNAL', blocked_reason: 'aparelho fisico' }),
      criterio({ criterion_id: 'aberto', state: 'UNPROVEN' }),
    ])
    expect(verdict).toEqual({ kind: 'UNPROVEN', criteria: ['aberto'] })
  })

  it('so bloqueio externo e um veredito PROPRIO, com os motivos', () => {
    // Juntar bloqueio externo com falta de prova faria uma missao parada por
    // falta de credencial parecer parada por falta de esforco.
    const verdict = missionCompletion([criterio({ state: 'BLOCKED_EXTERNAL', blocked_reason: 'chave de LLM real' })])
    expect(verdict).toEqual({ kind: 'BLOCKED_EXTERNAL', criteria: ['c1'], reasons: ['chave de LLM real'] })
    expect(completionDiagnostic(verdict)).toContain('c1')
  })

  it('tudo comprovado e o unico caminho para PROVEN', () => {
    expect(missionCompletion([criterio({ state: 'PROVEN', evidence: 'x' })])).toEqual({ kind: 'PROVEN' })
  })
})

describe('o teto e da MISSAO, e ele atravessa execucoes de equipes diferentes', () => {
  const mission = { max_total_tokens: 1_000, run_ids: ['r1', 'r2'] }

  it('soma o consumo de execucoes que nao pertencem a mesma equipe', () => {
    expect(missionSpend(mission, [run('r1', 300), run('r2', 400)])).toEqual({ kind: 'WITHIN', spent: 700, committed: 0, unknownInFlight: 0, limit: 1_000 })
    expect(missionSpend(mission, [run('r1', 600), run('r2', 400)])).toEqual({ kind: 'EXCEEDED', spent: 1_000, committed: 0, unknownInFlight: 0, limit: 1_000 })
  })

  it('execucao sem consumo relatado e UNMEASURED, e nunca zero', () => {
    // Tratar nao-medido como nada gasto faz o teto parar de estourar por falta
    // de medicao em vez de por estar dentro do combinado.
    expect(missionSpend(mission, [run('r1', 900), run('r2', null)])).toEqual({ kind: 'UNMEASURED', runId: 'r2', limit: 1_000 })
    expect(missionSpend(mission, [run('r1', 900), run('r2', undefined)])).toEqual({ kind: 'UNMEASURED', runId: 'r2', limit: 1_000 })
  })

  it('execucao declarada pela missao e AUSENTE da lista tambem e UNMEASURED', () => {
    // Ignora-la faria a missao gastar sem teto justamente quando o registro
    // esta incompleto — que e o caso em que um teto mais importa.
    expect(missionSpend(mission, [run('r1', 10)])).toEqual({ kind: 'UNMEASURED', runId: 'r2', limit: 1_000 })
  })

  it('execucao em curso SEM relato nao vira zero: ela e contada como DESCONHECIDA', () => {
    // O teste dizia "nao conta, porque ainda nao relatou nada", e a primeira
    // metade da frase estava certa pelo motivo errado: nao contar e diferente
    // de somar zero em silencio. Agora o desconhecido aparece no veredito, e
    // quem admite trabalho sabe que a soma e um PISO.
    expect(missionSpend(mission, [run('r1', 300), run('r2', null, 'RUNNING')]))
      .toEqual({ kind: 'WITHIN', spent: 300, committed: 0, unknownInFlight: 1, limit: 1_000 })
    expect(missionSpend(mission, [run('r1', 300), run('r2', null, 'PENDING_APPROVAL')]))
      .toEqual({ kind: 'WITHIN', spent: 300, committed: 0, unknownInFlight: 1, limit: 1_000 })
  })

  it('execucao em voo QUE JA RELATOU conta contra o teto — o achado da revisao independente', () => {
    // Medido de fora: teto 1.000, uma execucao RUNNING com 1.200 relatados
    // devolvia WITHIN, spent 0. O teto so valia depois do gasto.
    expect(missionSpend({ max_total_tokens: 1_000, run_ids: ['r1'] }, [run('r1', 1_200, 'RUNNING')]))
      .toEqual({ kind: 'EXCEEDED', spent: 0, committed: 1_200, unknownInFlight: 0, limit: 1_000 })
    // E o consumo em voo soma COM o liquidado, sem virar a mesma parcela duas
    // vezes: os dois campos existem separados por isso.
    expect(missionSpend(mission, [run('r1', 600), run('r2', 500, 'RUNNING')]))
      .toEqual({ kind: 'EXCEEDED', spent: 600, committed: 500, unknownInFlight: 0, limit: 1_000 })
  })

  it('sem teto declarado o veredito e NO_LIMIT, e nao "cabe"', () => {
    expect(missionSpend({ max_total_tokens: null, run_ids: ['r1'] }, [])).toEqual({ kind: 'NO_LIMIT' })
  })

  it('ligar execucao confere o teto ANTES, e recusa tambem quando nao da para medir', async () => {
    const f = await comMissao(500)
    await f.service.attachRun(ACTOR, 'm1', 'r1', [run('r1', 200)])
    await expect(f.service.attachRun(ACTOR, 'm1', 'r2', [run('r1', 600), run('r2', 10)])).rejects.toThrow(/500/u)
    // E sem medicao recusa igual: seguir gastando sem conseguir medir e como o
    // teto deixa de existir sem ninguem desliga-lo.
    await expect(f.service.attachRun(ACTOR, 'm1', 'r3', [run('r1', null)])).rejects.toBeInstanceOf(MissionError)
    expect((await f.service.mission(ACTOR, 'm1')).run_ids).toEqual(['r1'])
  })

  it('ligar a mesma execucao duas vezes nao a conta duas vezes', async () => {
    const f = await comMissao(500)
    await f.service.attachRun(ACTOR, 'm1', 'r1', [run('r1', 200)])
    await f.service.attachRun(ACTOR, 'm1', 'r1', [run('r1', 200)])
    expect((await f.service.mission(ACTOR, 'm1')).run_ids).toEqual(['r1'])
  })
})

describe('escopo', () => {
  it('a missao de outra organizacao nao existe para quem pergunta', async () => {
    // O escopo entra na BUSCA e nao numa conferencia depois: procurar primeiro e
    // conferir depois responde "existe, mas nao e sua", que ja conta que existe.
    const f = await comMissao()
    await expect(f.service.mission(OUTRO, 'm1')).rejects.toBeInstanceOf(MissionError)
  })

  it('missao concluida nao aceita mais trabalho', async () => {
    const f = await comMissao()
    await f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'PROVEN', evidence: 'x' })
    await f.service.recordCriterion(ACTOR, 'm1', 'leiga', { state: 'PROVEN', evidence: 'y' })
    await f.service.declareCandidate(ACTOR, 'm1')
    await f.service.complete(ACTOR, 'm1')
    await expect(f.service.attachRun(ACTOR, 'm1', 'r9', [])).rejects.toBeInstanceOf(MissionError)
    await expect(f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'REFUTED' })).rejects.toBeInstanceOf(MissionError)
  })

  it('registro com execucao repetida ou item repetido e recusado pelo esquema', () => {
    const base = {
      mission_id: 'm', org_id: 'o', tenant_id: 'w', objective: 'algo', status: 'RUNNING',
      max_total_tokens: null, run_ids: ['r1', 'r1'], criteria: [criterio()],
      created_at: 'x', updated_at: 'x', candidate_at: null, completed_at: null, revision: 0,
    }
    expect(missionRecordSchema.safeParse(base).success).toBe(false)
    expect(missionRecordSchema.safeParse({ ...base, run_ids: ['r1'] }).success).toBe(true)
    expect(missionRecordSchema.safeParse({
      ...base, run_ids: ['r1'], criteria: [criterio(), criterio()],
    }).success).toBe(false)
  })

  it('data de conclusao e estado concluido andam juntos, nos dois sentidos', () => {
    const base = {
      mission_id: 'm', org_id: 'o', tenant_id: 'w', objective: 'algo', status: 'COMPLETED' as const,
      max_total_tokens: null, run_ids: [], criteria: [criterio({ state: 'PROVEN', evidence: 'x' })],
      created_at: 'x', updated_at: 'x', candidate_at: 'x', completed_at: null, revision: 0,
    }
    expect(missionRecordSchema.safeParse(base).success).toBe(false)
    expect(missionRecordSchema.safeParse({ ...base, completed_at: 'x' }).success).toBe(true)
    expect(missionRecordSchema.safeParse({ ...base, status: 'RUNNING', completed_at: 'x' }).success).toBe(false)
  })
})

/**
 * Valida um critério com os campos que o teste quer mexer.
 * @param over - o que sobrescrever no critério válido.
 * @returns se o esquema aceitou.
 */
function missionCriterionSchemaSafe(over: Partial<MissionCriterion>): boolean {
  return missionRecordSchema.safeParse({
    mission_id: 'm', org_id: 'o', tenant_id: 'w', objective: 'algo', status: 'RUNNING',
    max_total_tokens: null, run_ids: [], criteria: [criterio(over)],
    created_at: 'x', updated_at: 'x', candidate_at: null, completed_at: null, revision: 0,
  }).success
}

describe('as recusas que faltavam, e a frase que cada veredito produz', () => {
  it('criar duas vezes com o mesmo identificador e recusado', async () => {
    // Aceitar sobrescreveria uma missao em andamento — com as provas dela — por
    // uma nova, vazia, sem ninguem pedir isso.
    const f = await comMissao()
    await expect(f.service.create(ACTOR, {
      missionId: 'm1', objective: 'outra coisa', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })).rejects.toBeInstanceOf(MissionError)
  })

  it('o mesmo identificador em OUTRA organizacao nao colide NEM APAGA a primeira', async () => {
    // Sem o escopo na conferencia, um inquilino impediria o outro de criar uma
    // missao so por ter escolhido o mesmo nome. E sem o escopo na CHAVE DE
    // ARMAZENAMENTO — que era o caso — a criacao da segunda organizacao
    // sobrescrevia o registro da primeira: objetivo, criterios, evidencias e
    // execucoes ligadas, tudo destruido em silencio, com 201 devolvido a quem
    // apagou. A afirmacao que faltava e a ultima linha.
    const f = await comMissao()
    const outra = await f.service.create(OUTRO, {
      missionId: 'm1', objective: 'a missao da outra organizacao', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })
    expect(outra.org_id).toBe('org-b')
    expect((await f.service.mission(ACTOR, 'm1')).objective).toBe('Terminar o Studio com prova')
    expect((await f.service.mission(ACTOR, 'm1')).criteria.map(item => item.criterion_id)).toEqual(['suite', 'leiga'])
  })

  it('criar com objetivo curto demais e recusado pelo esquema, com a frase do esquema', async () => {
    const f = fixture()
    await expect(f.service.create(ACTOR, {
      missionId: 'm2', objective: 'a', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })).rejects.toBeInstanceOf(MissionError)
  })

  it('registrar resultado de um item que nao pertence a missao e recusado', async () => {
    const f = await comMissao()
    await expect(f.service.recordCriterion(ACTOR, 'm1', 'inventado', { state: 'REFUTED' }))
      .rejects.toBeInstanceOf(MissionError)
  })

  it('cada veredito tem a sua frase, e nenhuma delas repete a outra', () => {
    const frases = [
      completionDiagnostic({ kind: 'PROVEN' }),
      completionDiagnostic({ kind: 'REFUTED', criteria: ['a'] }),
      completionDiagnostic({ kind: 'UNPROVEN', criteria: ['b'] }),
      completionDiagnostic({ kind: 'BLOCKED_EXTERNAL', criteria: ['c'], reasons: ['motivo'] }),
    ]
    expect(new Set(frases).size).toBe(4)
    expect(frases.every(frase => frase.length > 0)).toBe(true)
  })
})

describe('os caminhos defensivos que faltavam', () => {
  it('declarar candidatura duas vezes e recusado', async () => {
    const f = await comMissao()
    await f.service.declareCandidate(ACTOR, 'm1')
    await expect(f.service.declareCandidate(ACTOR, 'm1')).rejects.toBeInstanceOf(MissionError)
  })

  it('um item bloqueado SEM motivo, vindo de fora do esquema, nao quebra o veredito', () => {
    // `missionCompletion` e exportada e recebe objeto cru: quem a chamar sem
    // passar pelo esquema pode mandar um bloqueio sem motivo. O veredito nao
    // pode explodir ali — ele e o que diz a pessoa o que esta faltando.
    const verdict = missionCompletion([criterio({ state: 'BLOCKED_EXTERNAL', blocked_reason: null })])
    expect(verdict).toEqual({ kind: 'BLOCKED_EXTERNAL', criteria: ['c1'], reasons: [''] })
  })

  it('sem relogio injetado, o servico usa o do sistema', async () => {
    const antes = Date.now()
    const service = new StudioMissionService({ repository: new MemoryRepository() })
    const criada = await service.create(ACTOR, {
      missionId: 'm9', objective: 'usar o relogio de verdade', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })
    // Os DOIS lados. So o piso deixaria passar um relogio que devolvesse o ano
    // 275760 — qualquer data do futuro satisfaz `toBeGreaterThanOrEqual`.
    expect(Date.parse(criada.created_at)).toBeGreaterThanOrEqual(antes)
    expect(Date.parse(criada.created_at)).toBeLessThanOrEqual(Date.now())
  })

  it('a recusa do esquema traz TODAS as frases, e nao so a primeira', async () => {
    // So a primeira faz quem consertar descobrir o segundo problema depois de
    // arrumar o primeiro, uma rodada por vez.
    const f = fixture()
    await expect(f.service.create(ACTOR, {
      missionId: '', objective: 'a', maxTotalTokens: null,
      criteria: [{ criterion_id: '', statement: 'x' }],
    })).rejects.toThrow(/.+ .+/u)
  })
})


describe('o papel confere NO SERVICO, e nao na rota', () => {
  it('leitor le a missao e a lista, e nao cria nem registra prova', async () => {
    // A conferencia mora aqui porque quem sabe o que cada operacao significa e
    // esta camada — e uma conferencia que mora na rota deixa de valer assim que
    // alguem chama o servico por outro caminho, que e exatamente o que a
    // composicao do motor de missao faz.
    const f = await comMissao()
    expect((await f.service.mission(LEITOR, 'm1')).mission_id).toBe('m1')
    expect(await f.service.missions(LEITOR)).toHaveLength(1)
    await expect(f.service.create(LEITOR, {
      missionId: 'm2', objective: 'algo novo', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })).rejects.toBeInstanceOf(MissionError)
    await expect(f.service.recordCriterion(LEITOR, 'm1', 'suite', { state: 'PROVEN', evidence: 'x' }))
      .rejects.toBeInstanceOf(MissionError)
    await expect(f.service.declareCandidate(LEITOR, 'm1')).rejects.toBeInstanceOf(MissionError)
    await expect(f.service.complete(LEITOR, 'm1')).rejects.toBeInstanceOf(MissionError)
    await expect(f.service.attachRun(LEITOR, 'm1', 'r1', [])).rejects.toBeInstanceOf(MissionError)
  })

  it('a lista so traz as missoes do proprio escopo, da mais recente para a mais antiga', async () => {
    const f = await comMissao()
    await f.service.create(OUTRO, {
      missionId: 'm-alheia', objective: 'a da outra organizacao', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })
    expect((await f.service.missions(ACTOR)).map(record => record.mission_id)).toEqual(['m1'])
    expect((await f.service.missions(OUTRO)).map(record => record.mission_id)).toEqual(['m-alheia'])
  })

  it('a ligacao vinda de uma EQUIPE APROVADA nao pede papel, mas exige escopo', async () => {
    // Aqui nao ha pessoa pedindo: a autorizacao aconteceu quando a equipe foi
    // aprovada. Exigir papel obrigaria a compor um ator falso — um `owner`
    // inventado para contornar a propria conferencia.
    const f = await comMissao(500)
    const ligada = await f.service.attachRunForApprovedTeam({ orgId: 'org-a', tenantId: 'ws-a' }, 'm1', 'r1', [])
    expect(ligada.run_ids).toEqual(['r1'])
    await expect(f.service.attachRunForApprovedTeam({ orgId: 'org-b', tenantId: 'ws-b' }, 'm1', 'r2', []))
      .rejects.toBeInstanceOf(MissionError)
  })
})

describe('ACHADO: leitura-alteracao-gravacao concorrente perdia prova e furava o teto', () => {
  // A gravacao do armazenamento e ENFILEIRADA: o registro em memoria so muda
  // depois de o disco responder. Entre a leitura de uma chamada e a
  // visibilidade da gravacao dela, o laco de eventos roda outras chamadas, que
  // leem o registro VELHO — e a ultima gravacao vence, apagando a outra em
  // silencio, com 200 devolvido aos dois lados.
  //
  // O duble abaixo imita esse atraso de proposito. Sem ele, os testes rodam
  // sobre um `put` que e visivel na hora, e a janela desaparece do teste sem
  // desaparecer do produto.
  class RepositorioLento implements MissionRepository {
    readonly rows = new Map<string, MissionRecord>()
    missions = async (scope: MissionScope) => [...this.rows.values()]
      .filter(row => row.org_id === scope.orgId && row.tenant_id === scope.tenantId)

    putMission = async (record: MissionRecord, expected: 'new' | number) => {
      await new Promise(resolve => setTimeout(resolve, 0))
      // A condicao e conferida DEPOIS da espera, de proposito: e assim que um
      // armazenamento real se comporta, e e o que torna a janela observavel.
      const key = missionKey(record.org_id, record.tenant_id, record.mission_id)
      const current = this.rows.get(key)
      if (expected === 'new' ? current !== undefined : current?.revision !== expected) return false
      this.rows.set(key, record)
      return true
    }
  }

  async function lenta(max: number | null = null) {
    const repository = new RepositorioLento()
    const service = new StudioMissionService({ repository, now: () => new Date('2026-09-12T00:00:00.000Z') })
    await service.create(ACTOR, {
      missionId: 'm1', objective: 'Terminar com prova', maxTotalTokens: max,
      criteria: [
        { criterion_id: 'c1', statement: 'A primeira coisa' },
        { criterion_id: 'c2', statement: 'A segunda coisa' },
      ],
    })
    return { service, repository }
  }

  it('concluir e refutar ao mesmo tempo NAO produz missao concluida com item refutado', async () => {
    const f = await lenta()
    await f.service.recordCriterion(ACTOR, 'm1', 'c1', { state: 'PROVEN', evidence: 'a' })
    await f.service.recordCriterion(ACTOR, 'm1', 'c2', { state: 'PROVEN', evidence: 'b' })
    await f.service.declareCandidate(ACTOR, 'm1')

    const resultados = await Promise.allSettled([
      f.service.recordCriterion(ACTOR, 'm1', 'c2', { state: 'REFUTED' }),
      f.service.complete(ACTOR, 'm1'),
    ])
    const final = (await f.service.mission(ACTOR, 'm1'))
    // O que NAO pode acontecer, em nenhuma das duas ordens: ficar concluida com
    // um criterio refutado dentro.
    const refutado = final.criteria.find(item => item.criterion_id === 'c2')!.state === 'REFUTED'
    expect(final.status === 'COMPLETED' && refutado).toBe(false)
    // E o registro final tem de ser consistente com o que cada chamada disse:
    // se `complete` venceu, o PATCH reprovou; se o PATCH venceu, a missao voltou
    // a andar.
    if (final.status === 'COMPLETED') expect(resultados[0]!.status).toBe('rejected')
    else expect(final.status).toBe('RUNNING')
  })

  it('duas equipes ligando execucao ao mesmo tempo NAO perdem uma delas', async () => {
    // Perder uma faz o gasto dela nunca mais ser somado: o teto fica
    // permanentemente subestimado, e sem sinal nenhum.
    // Sem teto: este teste e sobre NAO PERDER execucao, e nao sobre o teto —
    // com teto, a segunda ligacao recusaria por falta de medicao da primeira.
    const f = await lenta()
    await Promise.all([
      f.service.attachRunForApprovedTeam({ orgId: 'org-a', tenantId: 'ws-a' }, 'm1', 'r1', []),
      f.service.attachRunForApprovedTeam({ orgId: 'org-a', tenantId: 'ws-a' }, 'm1', 'r2', []),
      f.service.attachRunForApprovedTeam({ orgId: 'org-a', tenantId: 'ws-a' }, 'm1', 'r3', []),
    ])
    expect([...(await f.service.mission(ACTOR, 'm1')).run_ids].sort()).toEqual(['r1', 'r2', 'r3'])
  })

  it('duas provas em criterios diferentes ao mesmo tempo NAO descartam uma', async () => {
    const f = await lenta()
    await Promise.all([
      f.service.recordCriterion(ACTOR, 'm1', 'c1', { state: 'PROVEN', evidence: 'prova um' }),
      f.service.recordCriterion(ACTOR, 'm1', 'c2', { state: 'PROVEN', evidence: 'prova dois' }),
    ])
    expect((await f.service.mission(ACTOR, 'm1')).criteria.map(item => item.state)).toEqual(['PROVEN', 'PROVEN'])
  })

  it('duas criacoes concorrentes do mesmo nome: uma so passa', async () => {
    const repository = new RepositorioLento()
    const service = new StudioMissionService({ repository })
    const pedido = async () => service.create(ACTOR, {
      missionId: 'igual', objective: 'a mesma missao', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })
    const resultados = await Promise.allSettled([pedido(), pedido()])
    expect(resultados.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  })

  it('missoes diferentes nao esperam uma pela outra', async () => {
    // Uma fila global serializaria o inquilino inteiro por causa de uma missao.
    const f = await lenta()
    await f.service.create(ACTOR, {
      missionId: 'm2', objective: 'outra missao', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })
    await Promise.all([
      f.service.recordCriterion(ACTOR, 'm1', 'c1', { state: 'PROVEN', evidence: 'a' }),
      f.service.recordCriterion(ACTOR, 'm2', 'x', { state: 'PROVEN', evidence: 'b' }),
    ])
    expect((await f.service.mission(ACTOR, 'm1')).criteria[0]!.state).toBe('PROVEN')
    expect((await f.service.mission(ACTOR, 'm2')).criteria[0]!.state).toBe('PROVEN')
  })
})

describe('ACHADO: a evidencia nao tinha o par simetrico que o bloqueio tinha', () => {
  it('prova num item que NAO esta comprovado e recusada', async () => {
    // Sem isto a tela desenhava "ainda sem prova" com "Onde esta a prova: …"
    // logo abaixo: o mesmo verde artificial, entrando pela outra metade do par.
    const f = await comMissao()
    await expect(f.service.recordCriterion(ACTOR, 'm1', 'suite', {
      state: 'UNPROVEN', evidence: 'passou na semana passada',
    })).rejects.toBeInstanceOf(MissionError)
  })

  it('registrar item como nao provado LIMPA a prova anterior', async () => {
    const f = await comMissao()
    await f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'PROVEN', evidence: 'a saida' })
    const depois = await f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'UNPROVEN' })
    expect(depois.criteria.find(item => item.criterion_id === 'suite')!.evidence).toBeNull()
  })

  it('candidatura e estado andam juntos nos dois sentidos', () => {
    const base = {
      mission_id: 'm', org_id: 'o', tenant_id: 'w', objective: 'algo', status: 'RUNNING' as const,
      max_total_tokens: null, run_ids: [], criteria: [criterio()],
      created_at: 'x', updated_at: 'x', candidate_at: null as string | null, completed_at: null, revision: 0,
    }
    expect(missionRecordSchema.safeParse(base).success).toBe(true)
    expect(missionRecordSchema.safeParse({ ...base, candidate_at: 'x' }).success).toBe(false)
    expect(missionRecordSchema.safeParse({ ...base, status: 'CANDIDATE_COMPLETED' }).success).toBe(false)
    expect(missionRecordSchema.safeParse({ ...base, status: 'CANDIDATE_COMPLETED', candidate_at: 'x' }).success).toBe(true)
  })

  it('o teto de execucoes recusa com frase de catalogo, e nao com o texto do esquema', async () => {
    const f = await comMissao()
    const cheia = { ...(await f.service.mission(ACTOR, 'm1')), run_ids: Array.from({ length: MAX_RUNS_PER_MISSION }, (_, i) => `r${String(i)}`) }
    await f.repository.putMission({ ...cheia, revision: cheia.revision + 1 }, cheia.revision)
    // A afirmacao e sobre a LINGUA e sobre a origem da frase, e nao sobre o
    // numero: o texto cru do esquema tambem contem o numero, entao procurar so
    // por ele deixaria a recusa em ingles passar como se fosse a do catalogo.
    // A falsificacao que desliga a guarda pegou exatamente isso.
    await expect(f.service.attachRunForApprovedTeam({ orgId: 'org-a', tenantId: 'ws-a' }, 'm1', 'demais', []))
      .rejects.toThrow(/trabalhos, que e o maximo|trabalhos, que é o máximo/u)
  })
})

describe('ACHADO: a fila por missao nao podia crescer para sempre', () => {
  it('o mapa de filas esvazia depois que as chamadas terminam', async () => {
    // A limpeza comparava com `undefined`, que nunca era verdade: o mapa
    // ganhava uma entrada por missao tocada e nunca perdia nenhuma. Num
    // processo longo isso e memoria que so sobe.
    const f = await comMissao()
    await f.service.recordCriterion(ACTOR, 'm1', 'suite', { state: 'PROVEN', evidence: 'a' })
    await f.service.recordCriterion(ACTOR, 'm1', 'leiga', { state: 'PROVEN', evidence: 'b' })
    expect(f.service.pendingLocks).toBe(0)
  })

  it('durante uma chamada a fila existe, e some no fim — inclusive quando a chamada FALHA', async () => {
    const f = await comMissao()
    await expect(f.service.recordCriterion(ACTOR, 'm1', 'inexistente', { state: 'REFUTED' }))
      .rejects.toBeInstanceOf(MissionError)
    expect(f.service.pendingLocks).toBe(0)
  })
})

describe('ACHADO: a fila fecha a janela DENTRO do processo, e a revisão fecha ENTRE processos', () => {
  /**
   * Uma OUTRA réplica, que grava entre a leitura e a gravação desta.
   *
   * A fila em memória não a alcança: ela roda noutro processo. O que a alcança
   * é a revisão, que viaja na condição da gravação.
   */
  class RepositorioComRival implements MissionRepository {
    readonly rows = new Map<string, MissionRecord>()
    rival: (() => void) | undefined = undefined

    missions = async (scope: MissionScope) => [...this.rows.values()]
      .filter(row => row.org_id === scope.orgId && row.tenant_id === scope.tenantId)

    putMission = async (record: MissionRecord, expected: 'new' | number) => {
      const agir = this.rival
      this.rival = undefined
      agir?.()
      const key = missionKey(record.org_id, record.tenant_id, record.mission_id)
      const current = this.rows.get(key)
      if (expected === 'new' ? current !== undefined : current?.revision !== expected) return false
      this.rows.set(key, record)
      return true
    }
  }

  async function comRival() {
    const repository = new RepositorioComRival()
    const service = new StudioMissionService({ repository, now: () => new Date('2026-09-12T00:00:00.000Z') })
    await service.create(ACTOR, {
      missionId: 'm1', objective: 'Terminar com prova', maxTotalTokens: null,
      criteria: [{ criterion_id: 'c1', statement: 'A primeira coisa' }],
    })
    return { repository, service }
  }

  it('a revisão SOBE a cada gravação, e não fica parada', async () => {
    // Sem isto a condição vira decorativa: gravar sempre com a mesma revisão
    // faz toda gravação passar, inclusive a que devia perder a corrida.
    const f = await comRival()
    expect((await f.service.mission(ACTOR, 'm1')).revision).toBe(0)
    await f.service.recordCriterion(ACTOR, 'm1', 'c1', { state: 'PROVEN', evidence: 'a' })
    expect((await f.service.mission(ACTOR, 'm1')).revision).toBe(1)
    await f.service.recordCriterion(ACTOR, 'm1', 'c1', { state: 'UNPROVEN' })
    expect((await f.service.mission(ACTOR, 'm1')).revision).toBe(2)
  })

  it('outra réplica gravando no meio faz ESTA gravação recusar, e não passar por cima', async () => {
    const f = await comRival()
    const key = missionKey('org-a', 'ws-a', 'm1')
    // A outra réplica comprova `c1` enquanto esta chamada está entre a leitura
    // e a gravação. Sem a condição, a gravação desta apagaria a prova dela.
    f.repository.rival = () => {
      const atual = f.repository.rows.get(key)!
      f.repository.rows.set(key, {
        ...atual, revision: atual.revision + 1,
        criteria: atual.criteria.map(item => ({ ...item, state: 'PROVEN' as const, evidence: 'prova da outra replica' })),
      })
    }
    await expect(f.service.recordCriterion(ACTOR, 'm1', 'c1', { state: 'REFUTED' }))
      .rejects.toThrow(/mudou enquanto|mudou enquanto a alteração/u)
    // E a prova da outra réplica continua lá.
    const final = await f.service.mission(ACTOR, 'm1')
    expect(final.criteria[0]!.state).toBe('PROVEN')
    expect(final.criteria[0]!.evidence).toBe('prova da outra replica')
  })
})
