import { roleAllows, type StudioPermission, type StudioRole } from '@dz23-studio/policy'
import { t } from './i18n.js'
import { MAX_RUNS_PER_MISSION, missionRecordSchema, type MissionCriterion, type MissionRecord, type MissionRunUsage } from './model.js'

export class MissionError extends Error {
  constructor(readonly code: 'INVALID' | 'NOT_FOUND' | 'INVALID_STATE' | 'BUDGET_EXCEEDED' | 'FORBIDDEN', message: string) {
    super(message)
  }
}

/**
 * Quanto a missão já gastou, e se dá para provar.
 *
 * É o irmão de escopo amplo do teto por equipe: aqui a soma atravessa
 * execuções de projetos e equipes diferentes, que é o que faltava para o teto
 * de MISSÃO existir.
 *
 * `UNMEASURED` NÃO é zero, pela mesma razão que vale no teto por equipe: tratar
 * não-medido como nada gasto faz o teto parar de estourar por falta de medição
 * em vez de por estar dentro do combinado, e um teto que só vale quando dá para
 * medir não é um teto.
 */
export type MissionSpendVerdict =
  | { readonly kind: 'NO_LIMIT' }
  | { readonly kind: 'WITHIN'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'EXCEEDED'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'UNMEASURED'; readonly runId: string; readonly limit: number }

/** As execuções que ainda não relataram consumo porque não terminaram. */
const RUNNING_STATUSES = new Set(['RUNNING', 'PENDING_APPROVAL'])

/**
 * Soma o consumo das execuções desta missão e decide se cabe mais trabalho.
 *
 * Conta as TERMINADAS: uma em curso ainda não relatou consumo, e contá-la como
 * zero seria a mesma mentira que `UNMEASURED` existe para não contar.
 *
 * Uma execução declarada pela missão que não aparece na lista de execuções
 * conhecidas devolve `UNMEASURED`, e não é ignorada. Ignorá-la faria a missão
 * gastar sem teto justamente quando o registro está incompleto — e registro
 * incompleto é o caso em que um teto mais importa.
 * @param mission - a missão, com o teto que ela declarou.
 * @param runs - as execuções conhecidas.
 * @returns o veredito.
 */
export function missionSpend(
  mission: Pick<MissionRecord, 'max_total_tokens' | 'run_ids'>,
  runs: readonly MissionRunUsage[],
): MissionSpendVerdict {
  const limit = mission.max_total_tokens
  if (limit === null) return { kind: 'NO_LIMIT' }
  const byId = new Map(runs.map(run => [run.run_id, run]))
  let spent = 0
  for (const runId of mission.run_ids) {
    const run = byId.get(runId)
    if (run === undefined) return { kind: 'UNMEASURED', runId, limit }
    if (RUNNING_STATUSES.has(run.status)) continue
    const used = run.tokens_used
    if (used === null || used === undefined) return { kind: 'UNMEASURED', runId, limit }
    spent += used
  }
  return spent >= limit ? { kind: 'EXCEEDED', spent, limit } : { kind: 'WITHIN', spent, limit }
}

/**
 * O que falta para a missão poder ser dada como concluída.
 *
 * `PROVEN` é o único estado que conta como feito. `BLOCKED_EXTERNAL` aparece
 * separado de `UNPROVEN` porque a ação é outra — um pede trabalho, o outro pede
 * outra pessoa — e `REFUTED` aparece primeiro porque uma missão com critério
 * refutado não está no meio do caminho, está no caminho errado.
 */
export type MissionCompletion =
  | { readonly kind: 'PROVEN' }
  | { readonly kind: 'REFUTED'; readonly criteria: readonly string[] }
  | { readonly kind: 'UNPROVEN'; readonly criteria: readonly string[] }
  | { readonly kind: 'BLOCKED_EXTERNAL'; readonly criteria: readonly string[]; readonly reasons: readonly string[] }

/**
 * Confere os critérios de aceite e diz se a missão pode ser dada como concluída.
 *
 * A ordem das perguntas é a que importa, e é a mesma razão de `taskReadiness`:
 * refutado vem antes de não-provado, e não-provado vem antes de bloqueado por
 * fora. Uma missão com um critério REFUTADO e outro bloqueado por falta de
 * credencial não está esperando credencial — dizer que está manda a pessoa
 * atrás da credencial em vez de atrás do erro.
 * @param criteria - os critérios de aceite da missão.
 * @returns o veredito, com os identificadores que o justificam.
 */
export function missionCompletion(criteria: readonly MissionCriterion[]): MissionCompletion {
  const refuted = criteria.filter(item => item.state === 'REFUTED')
  if (refuted.length > 0) return { kind: 'REFUTED', criteria: refuted.map(item => item.criterion_id) }
  const unproven = criteria.filter(item => item.state === 'UNPROVEN')
  if (unproven.length > 0) return { kind: 'UNPROVEN', criteria: unproven.map(item => item.criterion_id) }
  const blocked = criteria.filter(item => item.state === 'BLOCKED_EXTERNAL')
  if (blocked.length > 0) {
    return {
      kind: 'BLOCKED_EXTERNAL',
      criteria: blocked.map(item => item.criterion_id),
      reasons: blocked.map(item => item.blocked_reason ?? ''),
    }
  }
  return { kind: 'PROVEN' }
}

/** A frase que explica o veredito a quem não escreveu a missão. */
export function completionDiagnostic(verdict: MissionCompletion): string {
  switch (verdict.kind) {
    case 'PROVEN': return t('completion.provada')
    case 'REFUTED': return t('completion.refutada', { criterios: verdict.criteria.join(', ') })
    case 'UNPROVEN': return t('completion.semProva', { criterios: verdict.criteria.join(', ') })
    case 'BLOCKED_EXTERNAL': return t('completion.bloqueada', { criterios: verdict.criteria.join(', ') })
  }
}

/** Organização e inquilino, do jeito que o armazenamento por inquilino recebe. */
export interface MissionScope {
  readonly orgId: string
  readonly tenantId: string
}

export interface MissionRepository {
  /**
   * As missões DESTE escopo.
   *
   * O escopo entra na consulta, e não num filtro depois: sob armazenamento com
   * isolamento por linha é o banco que separa os inquilinos, e não um `if`
   * deste processo.
   * @param scope - organização e inquilino.
   * @returns as missões.
   */
  missions(scope: MissionScope): Promise<readonly MissionRecord[]>
  /**
   * Grava, SE o registro ainda estiver na revisão que quem escreve leu.
   *
   * `'new'` exige que ele não exista. Um número exige que a revisão atual seja
   * exatamente aquela. Falhar devolve `false` — e não lança —, porque perder a
   * corrida é um desfecho normal e quem chamou decide o que dizer.
   * @param record - o registro a gravar, já com a revisão NOVA.
   * @param expected - `'new'`, ou a revisão lida.
   * @returns se gravou.
   */
  putMission(record: MissionRecord, expected: 'new' | number): Promise<boolean>
}

export interface MissionActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  /**
   * O papel de quem pede, resolvido pelo SERVIDOR.
   *
   * A permissão é conferida aqui, e não na rota: quem sabe o que cada operação
   * significa é esta camada, e uma conferência que mora na rota deixa de valer
   * assim que alguém chama o serviço por outro caminho — que é exatamente o que
   * a composição do motor de missão faz.
   */
  readonly role: StudioRole
}

/**
 * O motor de missão: escopo amplo, prova antes de conclusão.
 *
 * O que ele acrescenta ao que já existia não é guardar mais um registro. É que
 * o checkpoint do Studio cobria UMA geração de UM projeto: nada dizia o que se
 * está tentando alcançar ao longo de várias execuções, quanto isso já custou no
 * total, nem o que impede de dar por encerrado. O estado da missão vivia num
 * markdown escrito à mão.
 */
export class StudioMissionService {
  readonly #repository: MissionRepository
  readonly #now: () => Date
  /**
   * Uma fila por missão, e o motivo é concreto.
   *
   * Ler é síncrono, gravar é `await`. A gravação do seam de armazenamento é
   * ENFILEIRADA: o registro em memória só muda depois de o disco responder.
   * Entre a leitura de uma chamada e a visibilidade da gravação dela, o laço de
   * eventos roda outras chamadas, que leem o registro VELHO — e a última
   * gravação vence, apagando a outra em silêncio, com 200 devolvido aos dois
   * lados.
   *
   * O que isso produzia: (1) `complete` decidindo sobre uma cópia velha e
   * concluindo a missão com um critério que acabou de ser REFUTADO — que é
   * exatamente o que a candidatura existe para impedir; (2) duas equipes
   * ligando execuções ao mesmo tempo e uma delas sumindo de `run_ids`, de modo
   * que o gasto dela nunca mais é somado e o teto fica permanentemente
   * subestimado, sem sinal nenhum; (3) duas provas registradas em critérios
   * diferentes, com uma descartada.
   *
   * A fila é por `mission_id` dentro do escopo: duas missões diferentes não se
   * esperam.
   */
  readonly #locks = new Map<string, Promise<unknown>>()

  /** Quantas missões estão com fila aberta agora. Existe para o teste ver o mapa esvaziar. */
  get pendingLocks(): number { return this.#locks.size }

  constructor(dependencies: { readonly repository: MissionRepository; readonly now?: () => Date }) {
    this.#repository = dependencies.repository
    this.#now = dependencies.now ?? (() => new Date())
  }

  /**
   * A missão daquele identificador, dentro do escopo de quem pede.
   *
   * O escopo entra na BUSCA e não numa conferência depois: procurar primeiro e
   * conferir depois responde "existe, mas não é sua", que já conta que existe.
   * @param actor - quem pede.
   * @param missionId - o identificador.
   * @returns a missão.
   */
  async mission(actor: MissionActor, missionId: string): Promise<MissionRecord> {
    this.#authorize(actor, 'project.read')
    return this.#inScope({ orgId: actor.orgId, tenantId: actor.tenantId }, missionId)
  }

  async #inScope(scope: MissionScope, missionId: string): Promise<MissionRecord> {
    // A conferência de escopo continua aqui MESMO com o banco separando por
    // linha: se um dia uma linha for gravada com o escopo errado no corpo, ela
    // some da leitura em vez de aparecer como se fosse de quem perguntou.
    const found = (await this.#repository.missions(scope)).find(record => record.mission_id === missionId
      && record.org_id === scope.orgId && record.tenant_id === scope.tenantId)
    if (found === undefined) throw new MissionError('NOT_FOUND', t('errors.naoEncontrada'))
    return found
  }

  /**
   * Registra uma missão nova.
   * @param actor - quem cria.
   * @param input - objetivo, teto e critérios de aceite.
   * @returns a missão registrada.
   */
  async create(actor: MissionActor, input: {
    readonly missionId: string
    readonly objective: string
    readonly maxTotalTokens: number | null
    readonly criteria: readonly Pick<MissionCriterion, 'criterion_id' | 'statement'>[]
  }): Promise<MissionRecord> {
    this.#authorize(actor, 'project.write')
    const now = this.#now().toISOString()
    // Todo critério nasce SEM PROVA. Deixar o chamador escolher o estado inicial
    // permitiria criar uma missão já concluída, que é a fraude mais barata
    // contra este motor inteiro.
    const parsed = missionRecordSchema.safeParse({
      mission_id: input.missionId, org_id: actor.orgId, tenant_id: actor.tenantId,
      objective: input.objective, status: 'RUNNING', max_total_tokens: input.maxTotalTokens,
      // Campo a campo, e nao por espalhamento: com `{ ...item, state: 'UNPROVEN' }`
      // a garantia depende da ORDEM das chaves, e inverter a ordem num conserto
      // futuro reabriria o buraco sem que nada parecesse ter mudado. Aqui nada
      // que o chamador mande alem de `criterion_id` e `statement` chega ao
      // registro — e o chamador que atravessa HTTP nao e conferido pelo tipo.
      run_ids: [],
      criteria: input.criteria.map(item => ({
        criterion_id: item.criterion_id, statement: item.statement,
        state: 'UNPROVEN', evidence: null, blocked_reason: null,
      })),
      created_at: now, updated_at: now, candidate_at: null, completed_at: null, revision: 0,
    })
    if (!parsed.success) throw new MissionError('INVALID', issueMessage(parsed.error))
    return this.#serialize(actor, input.missionId, async () => {
      // A conferência de repetido é do ARMAZENAMENTO, e não deste processo: a
      // fila serializa aqui dentro, e a condição `'new'` fecha o caso de outra
      // réplica criando o mesmo nome ao mesmo tempo.
      if (!await this.#repository.putMission(parsed.data, 'new')) {
        throw new MissionError('INVALID', t('errors.jaExiste'))
      }
      return parsed.data
    })
  }

  /**
   * Liga uma execução à missão, conferindo o teto ANTES de deixar entrar.
   *
   * Conferir depois só descobriria o estouro tendo gasto. E `UNMEASURED` recusa
   * junto com `EXCEEDED`: seguir gastando sem conseguir medir é como o teto
   * deixa de existir sem ninguém desligá-lo.
   * @param actor - quem pede.
   * @param missionId - a missão.
   * @param runId - a execução.
   * @param runs - as execuções conhecidas, para o teto.
   * @returns a missão atualizada.
   */
  async attachRun(actor: MissionActor, missionId: string, runId: string, runs: readonly MissionRunUsage[]): Promise<MissionRecord> {
    this.#authorize(actor, 'project.write')
    return this.attachRunForApprovedTeam({ orgId: actor.orgId, tenantId: actor.tenantId }, missionId, runId, runs)
  }

  /**
   * Liga à missão uma execução que uma EQUIPE JÁ APROVADA acabou de iniciar.
   *
   * Não confere permissão, e isso é deliberado: aqui não há pessoa pedindo. A
   * autorização aconteceu quando a equipe foi aprovada — com nível T2 ou T3 e
   * confirmação humana — e exigir de novo um papel aqui obrigaria a compor um
   * ator falso, que é pior: um `owner` inventado para contornar a própria
   * conferência é uma concessão silenciosa de privilégio.
   *
   * O ESCOPO continua obrigatório, e é o da equipe: sem ele a execução de uma
   * organização entraria na missão de outra que tenha escolhido o mesmo
   * identificador.
   * @param scope - a organização e o inquilino da equipe.
   * @param missionId - a missão.
   * @param runId - a execução.
   * @param runs - as execuções conhecidas, para o teto.
   * @returns a missão atualizada.
   */
  async attachRunForApprovedTeam(
    scope: { readonly orgId: string; readonly tenantId: string },
    missionId: string, runId: string, runs: readonly MissionRunUsage[],
  ): Promise<MissionRecord> {
    return this.#serialize(scope, missionId, async () => this.#attach(scope, missionId, runId, runs))
  }

  async #attach(
    scope: { readonly orgId: string; readonly tenantId: string },
    missionId: string, runId: string, runs: readonly MissionRunUsage[],
  ): Promise<MissionRecord> {
    const mission = await this.#inScope(scope, missionId)
    if (mission.status !== 'RUNNING') throw new MissionError('INVALID_STATE', t('errors.estadoNaoAceitaTrabalho'))
    // O teto de execuções é conferido AQUI, com frase de catálogo. Deixar o
    // esquema recusar depois produzia a frase crua do Zod, em inglês, dentro de
    // um `MissionError` — que passa pelo filtro de erro da rota e chega ao
    // cliente e ao diagnóstico da tarefa.
    if (mission.run_ids.length >= MAX_RUNS_PER_MISSION) {
      throw new MissionError('INVALID', t('errors.execucoesDemais', { teto: String(MAX_RUNS_PER_MISSION) }))
    }
    if (mission.run_ids.includes(runId)) return mission
    const verdict = missionSpend(mission, runs)
    if (verdict.kind === 'EXCEEDED') {
      throw new MissionError('BUDGET_EXCEEDED', t('errors.tetoEstourado', { gasto: String(verdict.spent), teto: String(verdict.limit) }))
    }
    if (verdict.kind === 'UNMEASURED') {
      throw new MissionError('BUDGET_EXCEEDED', t('errors.semMedicao', { execucao: verdict.runId }))
    }
    return this.#save({ ...mission, run_ids: [...mission.run_ids, runId] })
  }

  /**
   * Registra o resultado de um critério de aceite.
   * @param actor - quem pede.
   * @param missionId - a missão.
   * @param criterionId - o critério.
   * @param outcome - o novo estado, com a prova ou o motivo do bloqueio.
   * @returns a missão atualizada.
   */
  async recordCriterion(actor: MissionActor, missionId: string, criterionId: string, outcome: {
    readonly state: MissionCriterion['state']
    readonly evidence?: string | null
    readonly blockedReason?: string | null
  }): Promise<MissionRecord> {
    this.#authorize(actor, 'project.write')
    return this.#serialize(actor, missionId, async () => this.#recordCriterion(actor, missionId, criterionId, outcome))
  }

  async #recordCriterion(actor: MissionActor, missionId: string, criterionId: string, outcome: {
    readonly state: MissionCriterion['state']
    readonly evidence?: string | null
    readonly blockedReason?: string | null
  }): Promise<MissionRecord> {
    const mission = await this.mission(actor, missionId)
    if (mission.status === 'COMPLETED') {
      throw new MissionError('INVALID_STATE', t('errors.estadoNaoAceitaTrabalho'))
    }
    if (!mission.criteria.some(item => item.criterion_id === criterionId)) {
      throw new MissionError('NOT_FOUND', t('errors.criterioNaoEncontrado'))
    }
    const criteria = mission.criteria.map(item => item.criterion_id === criterionId
      ? { ...item, state: outcome.state, evidence: outcome.evidence ?? null, blocked_reason: outcome.blockedReason ?? null }
      : item)
    // A missão VOLTA a andar, sempre. Manter `CANDIDATE_COMPLETED` de pé seria
    // mentira depois de um critério mudar: quem declarou candidatura declarou
    // sobre OUTRO conjunto de provas, e `complete` decidiria sobre uma
    // declaração que nunca foi feita sobre estes critérios. Os dois estados que
    // não voltam — concluída e abandonada — já foram recusados acima.
    return this.#save({ ...mission, criteria, status: 'RUNNING', candidate_at: null })
  }

  /**
   * O executor declara que acredita ter terminado.
   *
   * Não conclui nada: é o degrau que separa "terminei" de "está provado".
   * @param actor - quem declara.
   * @param missionId - a missão.
   * @returns a missão em candidatura.
   */
  async declareCandidate(actor: MissionActor, missionId: string): Promise<MissionRecord> {
    this.#authorize(actor, 'project.write')
    return this.#serialize(actor, missionId, async () => {
      const mission = await this.mission(actor, missionId)
      if (mission.status !== 'RUNNING') throw new MissionError('INVALID_STATE', t('errors.estadoNaoAceitaCandidatura'))
      return this.#save({ ...mission, status: 'CANDIDATE_COMPLETED', candidate_at: this.#now().toISOString() })
    })
  }

  /**
   * Conclui a missão — e recusa quando a prova não está lá.
   *
   * A recusa é o ponto inteiro deste método. Um motor que aceitasse `COMPLETED`
   * porque quem executou disse que terminou não estaria verificando nada; ele
   * estaria copiando a autoavaliação do executor para um campo de banco e
   * dando a ela a aparência de fato conferido.
   * @param actor - quem conclui.
   * @param missionId - a missão.
   * @returns a missão concluída.
   */
  async complete(actor: MissionActor, missionId: string): Promise<MissionRecord> {
    this.#authorize(actor, 'project.write')
    return this.#serialize(actor, missionId, async () => {
      const mission = await this.mission(actor, missionId)
      if (mission.status !== 'CANDIDATE_COMPLETED') throw new MissionError('INVALID_STATE', t('errors.concluirExigeCandidatura'))
      const verdict = missionCompletion(mission.criteria)
      if (verdict.kind !== 'PROVEN') throw new MissionError('INVALID_STATE', completionDiagnostic(verdict))
      return this.#save({ ...mission, status: 'COMPLETED', completed_at: this.#now().toISOString() })
    })
  }

  /**
   * Confere a permissão do papel, ou recusa.
   * @param actor - quem pede.
   * @param permission - a permissão exigida.
   */
  #authorize(actor: MissionActor, permission: StudioPermission): void {
    if (!roleAllows(actor.role, permission)) throw new MissionError('FORBIDDEN', t('errors.papelNaoPode'))
  }

  /** As missões deste escopo, da mais recente para a mais antiga. */
  async missions(actor: MissionActor): Promise<readonly MissionRecord[]> {
    this.#authorize(actor, 'project.read')
    return (await this.#repository.missions({ orgId: actor.orgId, tenantId: actor.tenantId }))
      .filter(record => record.org_id === actor.orgId && record.tenant_id === actor.tenantId)
      // Desempate pelo identificador, que e unico dentro do escopo: sem ele a
      // ordem de duas missoes do mesmo instante dependeria da ordem de leitura
      // do armazenamento, e a tela mudaria de ordem sozinha entre dois
      // carregamentos. Nao ha terceiro ramo porque nao ha dois registros com o
      // mesmo identificador aqui — `create` recusa o repetido.
      .sort((left, right) => right.created_at.localeCompare(left.created_at)
        || (left.mission_id < right.mission_id ? -1 : 1))
  }

  /**
   * Serializa uma leitura-alteração-gravação sobre UMA missão.
   *
   * Fecha a janela DENTRO deste processo. Entre processos ela continua aberta —
   * fechar lá exige gravação condicional no armazenamento, que o seam não
   * oferece por esta porta, e está registrado assim no livro mestre em vez de
   * ser afirmado como resolvido.
   * @param scope - organização e inquilino.
   * @param missionId - a missão.
   * @param operation - o que fazer com ela.
   * @returns o que a operação devolver.
   */
  async #serialize<T>(
    scope: { readonly orgId: string; readonly tenantId: string },
    missionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = [scope.orgId, scope.tenantId, missionId].join(String.fromCharCode(0))
    const previous = this.#locks.get(key) ?? Promise.resolve()
    // `catch` engolido DE PROPOSITO: a falha de quem veio antes e problema de
    // quem a pediu. Deixa-la propagar aqui faria a proxima chamada falhar por
    // um erro que nao e dela.
    const mine = previous.catch(() => undefined).then(operation)
    // A entrada guardada e a versao que NUNCA rejeita: uma rejeicao guardada
    // aqui viraria rejeicao nao tratada quando a proxima chamada apenas a
    // encadeasse.
    const guardada = mine.catch(() => undefined)
    this.#locks.set(key, guardada)
    try {
      return await mine
    } finally {
      // So limpa se a entrada ainda for a MINHA: se alguem entrou na fila
      // depois, apagar aqui desfaria a serializacao dele. A comparacao e por
      // IDENTIDADE — a versao anterior comparava com `undefined`, que nunca era
      // verdade, e o mapa crescia uma entrada por missao tocada, para sempre.
      if (this.#locks.get(key) === guardada) this.#locks.delete(key)
    }
  }

  /**
   * Grava a mudança, pinada na revisão que foi lida.
   *
   * `record` é o registro LIDO, já com as alterações; a revisão nova é a dele
   * mais um, e a condição é a dele. Se outra réplica gravou nesse meio-tempo, a
   * escrita não acontece e o chamador recebe uma recusa em vez de passar por
   * cima do trabalho alheio.
   * @param record - o registro lido, já alterado.
   * @returns o registro gravado.
   */
  async #save(record: MissionRecord): Promise<MissionRecord> {
    const parsed = missionRecordSchema.safeParse({
      ...record, updated_at: this.#now().toISOString(), revision: record.revision + 1,
    })
    if (!parsed.success) throw new MissionError('INVALID', issueMessage(parsed.error))
    if (!await this.#repository.putMission(parsed.data, record.revision)) {
      throw new MissionError('INVALID_STATE', t('errors.mudouEnquantoGravava'))
    }
    return parsed.data
  }
}

/**
 * Todas as frases de uma recusa do esquema, e não só a primeira.
 *
 * Devolver só a primeira faz quem consertar descobrir o segundo problema
 * depois de arrumar o primeiro, uma rodada por vez. E a alternativa comum —
 * `issues[0]?.message ?? 'algo deu errado'` — carrega um caminho que nunca
 * executa, porque uma recusa do esquema sempre traz pelo menos uma frase.
 * @param error - a recusa do esquema.
 * @returns as frases juntas.
 */
function issueMessage(error: { readonly issues: readonly { readonly message: string }[] }): string {
  return error.issues.map(issue => issue.message).join(' ')
}
