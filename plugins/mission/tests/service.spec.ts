import { describe, expect, it } from 'vitest'
import { missionRecordSchema, type MissionCriterion, type MissionRecord, type MissionRunUsage } from '../src/model.ts'
import {
  completionDiagnostic, MissionError, missionCompletion, missionSpend, StudioMissionService,
  type MissionActor, type MissionRepository,
} from '../src/service.ts'

const ACTOR: MissionActor = { userId: 'u1', orgId: 'org-a', tenantId: 'ws-a' }
const OUTRO: MissionActor = { userId: 'u2', orgId: 'org-b', tenantId: 'ws-b' }

class MemoryRepository implements MissionRepository {
  rows: MissionRecord[] = []
  missions = () => this.rows
  putMission = async (record: MissionRecord) => {
    this.rows = [...this.rows.filter(row => row.mission_id !== record.mission_id
      || row.org_id !== record.org_id || row.tenant_id !== record.tenant_id), record]
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
    expect(f.service.mission(ACTOR, 'm1').status).toBe('CANDIDATE_COMPLETED')
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
    const gravado = f.service.mission(ACTOR, 'm1').criteria[0]!
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
    expect(missionSpend(mission, [run('r1', 300), run('r2', 400)])).toEqual({ kind: 'WITHIN', spent: 700, limit: 1_000 })
    expect(missionSpend(mission, [run('r1', 600), run('r2', 400)])).toEqual({ kind: 'EXCEEDED', spent: 1_000, limit: 1_000 })
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

  it('execucao em curso nao conta, porque ainda nao relatou nada', () => {
    expect(missionSpend(mission, [run('r1', 300), run('r2', null, 'RUNNING')])).toEqual({ kind: 'WITHIN', spent: 300, limit: 1_000 })
    expect(missionSpend(mission, [run('r1', 300), run('r2', null, 'PENDING_APPROVAL')])).toEqual({ kind: 'WITHIN', spent: 300, limit: 1_000 })
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
    expect(f.service.mission(ACTOR, 'm1').run_ids).toEqual(['r1'])
  })

  it('ligar a mesma execucao duas vezes nao a conta duas vezes', async () => {
    const f = await comMissao(500)
    await f.service.attachRun(ACTOR, 'm1', 'r1', [run('r1', 200)])
    await f.service.attachRun(ACTOR, 'm1', 'r1', [run('r1', 200)])
    expect(f.service.mission(ACTOR, 'm1').run_ids).toEqual(['r1'])
  })
})

describe('escopo', () => {
  it('a missao de outra organizacao nao existe para quem pergunta', async () => {
    // O escopo entra na BUSCA e nao numa conferencia depois: procurar primeiro e
    // conferir depois responde "existe, mas nao e sua", que ja conta que existe.
    const f = await comMissao()
    expect(() => f.service.mission(OUTRO, 'm1')).toThrow(MissionError)
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
      created_at: 'x', updated_at: 'x', candidate_at: null, completed_at: null,
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
      created_at: 'x', updated_at: 'x', candidate_at: 'x', completed_at: null,
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
    created_at: 'x', updated_at: 'x', candidate_at: null, completed_at: null,
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

  it('o mesmo identificador em OUTRA organizacao nao colide', async () => {
    // Sem o escopo na conferencia, um inquilino impediria o outro de criar uma
    // missao so por ter escolhido o mesmo nome.
    const f = await comMissao()
    const outra = await f.service.create(OUTRO, {
      missionId: 'm1', objective: 'a missao da outra organizacao', maxTotalTokens: null,
      criteria: [{ criterion_id: 'x', statement: 'algo' }],
    })
    expect(outra.org_id).toBe('org-b')
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
    expect(Date.parse(criada.created_at)).toBeGreaterThanOrEqual(antes)
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
