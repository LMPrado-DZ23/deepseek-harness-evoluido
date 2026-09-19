import { createHash, randomUUID } from 'node:crypto'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { routePrivacyProfile, type RoutePrivacy } from '@dz23-studio/route-health'
import { appSpecHash, type AppSpecV1 } from './appspec.js'
import { createDesignSpec, designSpecHash, designSpecV1Schema, type DesignLogo, type DesignSelection, type DesignSpecV1 } from './design.js'
import type {
  PromptToAppKey, ProjectState, StudioApproval, StudioAppSpecRecord, StudioEvidence,
  StudioCreationKey,
  StudioDesignSpecRecord, StudioIntakeTurn, StudioPlan, StudioPlanSlice, StudioProject, StudioProjectCategory, StudioRun,
} from './model.js'
import { assertProjectTransition, assertRevisionTransition, assertUndoTransition, RevisionNotAvailableError } from './state.js'
import { especificacaoRevisada, RevisionError } from './revision.js'
import { appendPlanSlice, applyPlanEdit, planRevision, PlanEditError, type PlanEdit } from './plan-edit.js'
import { listIntakeTurns, putIntakeTurn, type IntakeTurnRecordStore } from './intake-turn-store.js'
import { listDesignSpecs, putDesignSpec, type DesignSpecRecordStore } from './design-spec-store.js'
import { listAppSpecs, putAppSpec, type AppSpecRecordStore } from './app-spec-store.js'
import { listPlans, putPlanRecord, type PlanRecordStore } from './plan-store.js'
import { listEvidence, putEvidenceRecord, type EvidenceRecordStore } from './evidence-store.js'
import {
  chaveAceitavel, chaveArmazenada, desfechoDaChave, desfechoDoEnvio, impressaoDaCriacao,
  impressaoDoEnvio, reservaDoEscopo, type TipoDeEnvio,
} from './creation-key.js'
import { latestGreenCheckpoint, noGreenReason, runCheckpoints, type CheckpointBlocker, type RunCheckpoint, NO_ATTEMPT } from './checkpoint.js'
import { PERGUNTA_QUESTION_ID, MAX_PERGUNTA, MIN_PERGUNTA, perguntaNormalizada, respostaEmTexto, respostaSobreATarefa } from './pergunta.js'
import { t } from './i18n.js'

export interface PromptToAppActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId?: string
}

/** O espaço de trabalho inteiro, como a exportação o devolve. */
export interface StudioWorkspaceExport {
  readonly exported_at: string
  readonly org_id: string
  readonly tenant_id: string
  readonly exported_by: string
  readonly projects: readonly {
    readonly project: StudioProject
    readonly intake_turns: readonly StudioIntakeTurn[]
    /** `null` quando a tarefa não chegou a ter este registro. */
    readonly spec: StudioAppSpecRecord | null
    readonly design: StudioDesignSpecRecord | null
    readonly plan: StudioPlan | null
    readonly runs: readonly StudioRun[]
    readonly evidence: readonly StudioEvidence[]
  }[]
}

export interface PromptToAppRepository {
  projects(): readonly StudioProject[]
  putProject(value: StudioProject): Promise<void>
  specs(): readonly StudioAppSpecRecord[]
  putSpec(value: StudioAppSpecRecord): Promise<void>
  designs(): readonly StudioDesignSpecRecord[]
  putDesign(value: StudioDesignSpecRecord): Promise<void>
  turns(): readonly StudioIntakeTurn[]
  putTurn(value: StudioIntakeTurn): Promise<void>
  plans(): readonly StudioPlan[]
  putPlan(value: StudioPlan): Promise<void>
  runs(): readonly StudioRun[]
  putRun(value: StudioRun): Promise<void>
  evidence(): readonly StudioEvidence[]
  putEvidence(value: StudioEvidence): Promise<void>
  approvals(): readonly StudioApproval[]
  putApproval(value: StudioApproval): Promise<void>
  /**
   * As reservas de criacao. Opcionais no seam por uma razao pratica: uma
   * instalacao antiga que ainda nao abriu este dominio continua lendo e
   * escrevendo tudo o mais, e a criacao cai no caminho SEM reserva — que e o
   * comportamento de antes, nao um comportamento novo e pior.
   */
  creationKeys?(): readonly StudioCreationKey[]
  putCreationKey?(value: StudioCreationKey): Promise<void>
}

export class PromptToAppError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'REPLAY' | 'CAPACITY' | 'CONFLICT', message: string) { super(message) }
}

export interface PromptToAppServiceOptions {
  readonly repository: PromptToAppRepository
  readonly now?: () => Date
  readonly createId?: () => string
  /**
   * O armazenamento por inquilino das RESPOSTAS do intake, quando existir.
   *
   * Ausente é o padrão, e ausente quer dizer chave-valor — o mesmo caminho de
   * sempre. Uma instalação que já roda NÃO pode mudar de autoridade de
   * armazenamento porque atualizou: isso é decisão de quem opera, e ela é
   * tomada na configuração do plugin.
   *
   * Só este domínio por enquanto, e de propósito: é o primeiro passo do plano
   * do `S-08`, escolhido por ser o de menor superfície (dois pontos no serviço
   * inteiro) e por não participar da geração.
   */
  readonly intakeTurnStore?: IntakeTurnRecordStore
  /**
   * O armazenamento por inquilino das ESCOLHAS DE VISUAL, quando existir.
   *
   * Segundo domínio do plano do `S-08`. Mesmas regras do primeiro: ausente é o
   * padrão e significa chave-valor, e quem opera é quem decide.
   */
  readonly designSpecStore?: DesignSpecRecordStore
  /** O mesmo, para a ESPECIFICAÇÃO do aplicativo. Ausente = chave-valor. */
  readonly appSpecStore?: AppSpecRecordStore
  /** O mesmo, para o PLANO aprovado. Ausente = chave-valor. */
  readonly planStore?: PlanRecordStore
  /** O mesmo, para as EVIDÊNCIAS da execução. Ausente = chave-valor. */
  readonly evidenceStore?: EvidenceRecordStore
}

/**
 * Serialização por chave dentro do processo, do mesmo feitio da que o portão de
 * aprovações usa: o seam de domínio deste projeto expõe `put(chave, valor)`,
 * sem "grave só se ainda for X".
 */
class CreationMutex {
  readonly #tails = new Map<string, Promise<void>>()
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.#tails.set(key, tail)
    await previous
    try { return await work() } finally {
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

export class PromptToAppService {
  readonly #repository: PromptToAppRepository
  readonly #now: () => Date
  readonly #createId: () => string
  /**
   * Serializa por chave de criação DENTRO do processo.
   *
   * Não protege contra dois processos — para isso seria preciso trava durável,
   * e isso está declarado como limitação, não como resolvido. O que sobrevive
   * ao reinício é a RESERVA, e é ela que impede a tarefa duplicada; o mutex
   * fecha a janela curta entre ler "não há reserva" e gravá-la.
   */
  readonly #creationMutex = new CreationMutex()
  readonly #intakeTurnStore: IntakeTurnRecordStore | undefined
  readonly #designSpecStore: DesignSpecRecordStore | undefined
  readonly #appSpecStore: AppSpecRecordStore | undefined
  readonly #planStore: PlanRecordStore | undefined
  readonly #evidenceStore: EvidenceRecordStore | undefined
  constructor(options: PromptToAppServiceOptions) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#intakeTurnStore = options.intakeTurnStore
    this.#designSpecStore = options.designSpecStore
    this.#appSpecStore = options.appSpecStore
    this.#planStore = options.planStore
    this.#evidenceStore = options.evidenceStore
  }

  assertAuthorized(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    this.#authorize(actor, permission)
  }

  listProjects(actor: PromptToAppActor): readonly StudioProject[] {
    this.#authorize(actor, 'project.read')
    return this.#repository.projects().filter(value => this.#sameScope(actor, value) && value.archived_at === null)
  }

  project(actor: PromptToAppActor, projectId: string): StudioProject {
    this.#authorize(actor, 'project.read')
    const value = this.#repository.projects().find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.notFound'))
    return value
  }

  /**
   * Cria a tarefa — UMA vez por intenção, mesmo que o pedido chegue várias.
   *
   * O caminho com `requestKey` é uma máquina de três desfechos, e cada um
   * existe por um cenário medido:
   *
   * - **CRIAR**: não há reserva. Grava a RESERVA primeiro, com o `project_id`
   *   já escolhido, e só depois a tarefa. A ordem é o requisito: gravar a
   *   tarefa antes deixaria uma janela em que uma queda perde a chave e o
   *   reenvio cria a segunda tarefa.
   * - **REUSAR**: a reserva existe com a mesma impressão. Devolve a tarefa
   *   daquele `project_id` — e se ela não existir (queda entre as duas
   *   escritas), TERMINA a criação com o mesmo identificador. É isso que
   *   impede tanto a tarefa duplicada quanto a tarefa impossível de retomar.
   * - **CONFLITO**: a reserva existe com impressão diferente. Recusa, e recusa
   *   alto. Devolver a tarefa antiga para um pedido novo seria ignorar o que a
   *   pessoa escreveu sem ela nunca saber.
   *
   * O mutex serializa a janela DENTRO do processo; a reserva é o que sobrevive
   * ao reinício. Um sozinho não resolve: o mutex morre com o processo, e a
   * reserva sem serialização deixa duas chamadas simultâneas lerem "não há
   * reserva" ao mesmo tempo.
   *
   * Sem `requestKey` o comportamento é o de sempre — cria. Isso é para a
   * instalação que ainda não abriu o domínio das reservas, e não uma porta de
   * fuga: o cliente do produto manda a chave sempre.
   * @param actor - quem pede; o escopo sai daqui, nunca do corpo do pedido.
   * @param input - o pedido validado.
   * @param requestKey - o identificador da INTENÇÃO de envio.
   * @returns a tarefa criada, ou a mesma tarefa de uma tentativa anterior.
   */
  async createProject(
    actor: PromptToAppActor,
    input: Pick<StudioProject, 'name' | 'original_brief' | 'category' | 'privacy'>,
    requestKey?: string,
  ): Promise<StudioProject> {
    this.#authorize(actor, 'project.write')
    if (requestKey === undefined || this.#repository.creationKeys === undefined || this.#repository.putCreationKey === undefined) {
      return this.#insertProject(actor, input, this.#createId())
    }
    if (!chaveAceitavel(requestKey)) throw new PromptToAppError('INVALID', t('errors.creationKeyFormat'))
    const escopo = { orgId: actor.orgId, tenantId: actor.tenantId, userId: actor.userId }
    const fingerprint = impressaoDaCriacao({ ...input })
    return this.#creationMutex.run(chaveArmazenada(escopo, requestKey), async () => {
      const reserva = this.#repository.creationKeys!().find(
        registro => registro.request_key === requestKey && reservaDoEscopo(registro, escopo),
      )
      const desfecho = desfechoDaChave(reserva, fingerprint)
      if (desfecho.kind === 'CONFLITO') throw new PromptToAppError('CONFLICT', t('errors.creationKeyConflict'))
      if (desfecho.kind === 'REUSAR') {
        // A releitura passa pelo MESMO `project()`, que reautoriza: uma chave
        // não é credencial, e recuperar a resposta não pode virar um atalho
        // para ler tarefa de outra pessoa.
        const existente = this.#repository.projects().find(value => value.project_id === desfecho.projectId)
        if (existente !== undefined) return this.project(actor, desfecho.projectId)
        // A reserva ficou e a tarefa não: o processo caiu entre as duas
        // escritas. Termina a criação com o MESMO identificador.
        return this.#insertProject(actor, input, desfecho.projectId)
      }
      const projectId = this.#createId()
      await this.#repository.putCreationKey!({
        request_key: requestKey, org_id: actor.orgId, tenant_id: actor.tenantId, user_id: actor.userId,
        fingerprint, project_id: projectId, created_at: this.#now().toISOString(),
      })
      return this.#insertProject(actor, input, projectId)
    })
  }

  /**
   * A identidade de UM ENVIO dentro de uma tarefa já aberta.
   *
   * É o mesmo mecanismo da criação — reserva DURÁVEL gravada ANTES do efeito,
   * serializada pelo mutex, com três desfechos — e não um segundo mecanismo.
   * Duas contabilidades de intenção discordariam no primeiro conserto de uma
   * delas, e a que diverge em silêncio é sempre a que alguém lê.
   *
   * O que ele garante, e o teste confere um por um:
   *
   * - mesma chave e mesmo texto devolvem o MESMO efeito, sem produzir outro;
   * - mesma chave e texto diferente é `CONFLITO`, e não o efeito antigo
   *   devolvido para um pedido que ninguém fez;
   * - a reserva é do ESCOPO de quem pede: chave não é credencial;
   * - se o processo cair entre a reserva e o efeito, o envio seguinte termina
   *   o efeito com o MESMO identificador, em vez de criar um segundo.
   *
   * Sem `requestKey` o comportamento é o de sempre — envia. Isso é para a
   * pessoa que usa a API direto, e não uma porta de fuga da tela.
   * @param actor - quem envia.
   * @param projectId - a tarefa.
   * @param tipo - pergunta ou pedido de alteração.
   * @param texto - o texto JÁ normalizado, que é o que entra na impressão.
   * @param requestKey - o identificador da intenção, quando houver.
   * @param executar - produz o efeito e devolve o identificador dele.
   * @param reler - devolve o efeito já produzido, ou `undefined` se ele sumiu.
   * @returns o efeito.
   */
  async #comChaveDeEnvio<T>(
    actor: PromptToAppActor,
    projectId: string,
    tipo: TipoDeEnvio,
    texto: string,
    requestKey: string | undefined,
    executar: (idReservado: string | undefined) => Promise<{ readonly id: string, readonly valor: T }>,
    reler: (resultId: string) => Promise<T | undefined>,
  ): Promise<T> {
    if (requestKey === undefined || this.#repository.creationKeys === undefined || this.#repository.putCreationKey === undefined) {
      return (await executar(undefined)).valor
    }
    if (!chaveAceitavel(requestKey)) throw new PromptToAppError('INVALID', t('errors.creationKeyFormat'))
    const escopo = { orgId: actor.orgId, tenantId: actor.tenantId, userId: actor.userId }
    const fingerprint = impressaoDoEnvio({ tipo, projectId, texto })
    return this.#creationMutex.run(chaveArmazenada(escopo, requestKey), async () => {
      const reserva = this.#repository.creationKeys!().find(
        registro => registro.request_key === requestKey && reservaDoEscopo(registro, escopo),
      )
      const desfecho = desfechoDoEnvio(reserva, fingerprint)
      if (desfecho.kind === 'CONFLITO') throw new PromptToAppError('CONFLICT', t('errors.creationKeyConflict'))
      if (desfecho.kind === 'REUSAR' && desfecho.resultId !== undefined) {
        // A releitura passa pela MESMA autorização: recuperar a resposta não
        // pode virar atalho para ler o que é de outra pessoa.
        const existente = await reler(desfecho.resultId)
        if (existente !== undefined) return existente
        // A reserva ficou e o efeito não: o processo caiu entre as duas
        // escritas. Termina com o MESMO identificador.
        return (await executar(desfecho.resultId)).valor
      }
      const idReservado = this.#createId()
      await this.#repository.putCreationKey!({
        request_key: requestKey, org_id: actor.orgId, tenant_id: actor.tenantId, user_id: actor.userId,
        fingerprint, project_id: projectId, kind: tipo, result_id: idReservado,
        created_at: this.#now().toISOString(),
      })
      return (await executar(idReservado)).valor
    })
  }

  async #insertProject(actor: PromptToAppActor, input: Pick<StudioProject, 'name' | 'original_brief' | 'category' | 'privacy'>, projectId: string): Promise<StudioProject> {
    const now = this.#now().toISOString()
    const value: StudioProject = {
      project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      ...input,
      // Gravação nova sai SEMPRE com o nome do perfil, nunca com o valor
      // binário antigo: o antigo continua sendo lido porque já está em disco,
      // não porque ainda vale a pena escrever mais um.
      privacy: routePrivacyProfile(input.privacy),
      state: 'DRAFT', created_by: actor.userId, created_at: now, updated_at: now, archived_at: null,
    }
    await this.#repository.putProject(value)
    return value
  }

  /**
   * As respostas do intake deste projeto.
   *
   * ASSÍNCRONA desde setembro/2026, e ela ainda lê a mesma chave-valor de
   * sempre. A troca de forma veio PRIMEIRO, de propósito: é o passo do plano do
   * `S-08` que não muda armazenamento nenhum e por isso não pode quebrar nada
   * que os testes não apanhem na hora — o `tsc` aponta cada ponto que precisa
   * esperar, um por um.
   *
   * Uma leitura com RLS é assíncrona e recebe o ator; esta já é as duas coisas.
   * Quando o repositório por inquilino entrar, o que muda é de onde os dados
   * vêm — e não a assinatura de quem os pede, que é o tipo de mudança que
   * costuma arrastar meia base de código de uma vez só.
   * @param actor - quem lê; o escopo sai daqui.
   * @param projectId - o projeto.
   * @returns as respostas, na ordem em que foram gravadas.
   */
  async intakeTurns(actor: PromptToAppActor, projectId: string): Promise<readonly StudioIntakeTurn[]> {
    this.project(actor, projectId)
    // O filtro de escopo do produto continua AQUI, com ou sem RLS. Trocar uma
    // guarda pela outra seria andar de lado: a RLS protege do dia em que
    // alguém escrever uma consulta nova e esquecer o `where`, e o filtro
    // protege do dia em que a política do banco não estiver onde se pensava.
    const rows = this.#intakeTurnStore === undefined
      ? this.#repository.turns()
      : await listIntakeTurns(this.#intakeTurnStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    return rows.filter(value => value.project_id === projectId && this.#sameScope(actor, value))
  }

  async recordTurn(
    actor: PromptToAppActor,
    projectId: string,
    input: Pick<StudioIntakeTurn, 'question_id' | 'question' | 'answer' | 'recommended' | 'route' | 'model'>,
    /*
      O identificador JÁ RESERVADO, quando o envio tem chave de intenção.

      Ele existe para o caso em que o processo cai entre gravar a reserva e
      gravar o turno: o reenvio termina o efeito com o MESMO identificador, em
      vez de deixar a reserva apontando para um turno que nunca existiu e criar
      um segundo. Ausente, o identificador nasce aqui, como sempre.
    */
    turnId?: string,
  ): Promise<StudioIntakeTurn> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const value: StudioIntakeTurn = {
      turn_id: turnId ?? this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      ...input, created_at: this.#now().toISOString(),
    }
    if (this.#intakeTurnStore === undefined) await this.#repository.putTurn(value)
    else await putIntakeTurn(this.#intakeTurnStore, value)
    return value
  }

  /**
   * A PERGUNTA da pessoa sobre a tarefa — que não mexe em nada.
   *
   * O dono do produto apontou o defeito e ele era real: depois de um
   * resultado, todo envio virava critério de aceite permanente na
   * especificação, e uma pergunta custava uma tentativa. Aqui a pergunta é um
   * lance da conversa e mais nada.
   *
   * O QUE ESTE MÉTODO NÃO PODE FAZER, e o teste confere um por um: não grava
   * especificação, não propõe nem aprova plano, não muda o estado do projeto e
   * não inicia execução. É uma escrita só, no mesmo lugar onde a conversa já
   * mora — sem conversa nova, sem journal paralelo, sem segundo armazenamento.
   *
   * A permissão é `project.write` e não `project.read` de propósito: isto
   * ESCREVE na conversa da tarefa, e quem só pode ler não escreve nela.
   * @param actor - quem pergunta.
   * @param projectId - a tarefa.
   * @param pergunta - o texto, como a pessoa escreveu.
   * @returns o lance gravado, com a resposta já dentro.
   */
  /**
   * Grava UMA resposta do intake, com identidade de intenção de envio.
   *
   * Esta é a rota que mais precisava disto, e a que menos parecia precisar: ela
   * não duplicava efeito VISÍVEL, porque a próxima pergunta já teria mudado
   * quando o reenvio chegasse. O que ela duplicava era CUSTO — responder com
   * `recomendar` CHAMA modelo, e o reenvio depois de a resposta se perder
   * chamava de novo, cobrava de novo, e gravava um segundo turno com um texto
   * que a pessoa não escolheu.
   *
   * `produzir` é passado de fora porque quem sabe falar com o modelo é o
   * motor de intake, e ele não mora aqui. O importante é a ORDEM: com chave,
   * `produzir` só é chamado quando o envio é novo.
   *
   * A impressão é feita SÓ do que o cliente mandou: a resposta digitada, ou a
   * marca de recomendação quando é o modelo que vai escrever.
   *
   * A PERGUNTA ficou de fora, e a primeira versão desta função a incluía — o
   * e2e provou que estava errado, e a razão vale ser escrita. A pergunta é
   * calculada pelo SERVIDOR a partir do que já foi respondido, então o próprio
   * primeiro envio a muda: quando o reenvio chega, a pergunta corrente já é
   * outra, a impressão dá diferente e a reserva vira CONFLITO. Ou seja,
   * incluí-la quebrava exatamente o caso para o qual a chave existe.
   *
   * O que se perde com isso é estreito e conhecido: duas perguntas respondidas
   * com o MESMO texto e a MESMA chave seriam a mesma intenção. Só que a chave
   * nasce por envio no cliente, e reusá-la entre duas perguntas é defeito de
   * cliente — enquanto o reenvio depois de perder a resposta é o caminho
   * normal de quem tem rede ruim.
   *
   * A marca de recomendação continua entrando: sem ela a impressão dependeria
   * do que o modelo fosse devolver, e dois modelos diferentes fariam a mesma
   * intenção ter duas impressões.
   * @param actor - quem responde.
   * @param projectId - a tarefa.
   * @param entrada - a pergunta, se a resposta é recomendada, e a digitada.
   * @param produzir - o que produz a resposta final (chama o modelo, ou não).
   * @param requestKey - a identidade da intenção.
   * @returns o turno gravado.
   */
  /**
   * TUDO o que este espaço de trabalho guardou, para a pessoa levar consigo.
   *
   * É a operação de "Controles de dados" que as Preferências declaravam faltar,
   * e ela é uma LEITURA: nada é apagado, nada é movido, nada sai do escopo de
   * quem pediu.
   *
   * ## O escopo é o do ATOR, tarefa por tarefa
   *
   * A exportação não abre um caminho privilegiado de leitura. Ela percorre as
   * tarefas que `listProjects` já devolve — que já filtra por organização e
   * inquilino — e, para cada uma, chama os MESMOS leitores autorizados que as
   * telas usam. Um leitor novo que varresse o repositório inteiro seria a porta
   * pela qual o vizinho apareceria, e ela não existe aqui.
   *
   * ## O que NÃO vai junto
   *
   * Segredo nenhum: este serviço não guarda credencial, e o que ele guarda de
   * integração é referência de cofre, que mora em outro plugin e não é lido
   * aqui. O código gerado também fica de fora — ele é arquivo em disco, e a
   * Biblioteca é a porta dele, com resumo criptográfico e download próprio.
   * Enfiá-lo num JSON faria uma segunda cópia sem recibo.
   * @param actor - quem leva.
   * @returns o espaço inteiro que este serviço conhece.
   */
  async exportWorkspace(actor: PromptToAppActor): Promise<StudioWorkspaceExport> {
    /*
      SABOTAGEM QUE SOBREVIVE, DE PROPÓSITO: remover esta linha não quebra teste
      nenhum, e não quebra porque não PODE — `listProjects`, logo abaixo, faz a
      mesma conferência, e os quatro papéis deste produto (`owner`, `admin`,
      `builder`, `viewer`) têm `project.read`. Não existe ator que a linha
      recusasse e o resto deixasse passar, então um teste que a "cobrisse"
      precisaria de um papel que o produto não tem — cobertura fingida.

      Ela fica porque é o contrato escrito no alto do método: quem lê daqui a
      um ano vê em uma linha que a exportação é autorizada, em vez de ter de
      descer até a chamada que a carrega.
    */
    this.#authorize(actor, 'project.read')
    const projetos = this.listProjects(actor)
    const tarefas = await Promise.all(projetos.map(async projeto => ({
      project: projeto,
      intake_turns: await this.intakeTurns(actor, projeto.project_id),
      // Cada leitura que pode não existir vira AUSÊNCIA explícita, e não um
      // objeto vazio: "esta tarefa não tem plano" é diferente de "o plano dela
      // é vazio", e quem receber o arquivo precisa dessa diferença.
      spec: await this.latestSpec(actor, projeto.project_id).catch(() => null),
      design: await this.latestDesign(actor, projeto.project_id).catch(() => null),
      plan: await this.plan(actor, projeto.project_id).catch(() => null),
      runs: this.runs(actor, projeto.project_id),
      evidence: await this.evidence(actor, projeto.project_id),
    })))
    return {
      exported_at: this.#now().toISOString(),
      org_id: actor.orgId,
      tenant_id: actor.tenantId,
      exported_by: actor.userId,
      projects: tarefas,
    }
  }

  async answerIntakeTurn(
    actor: PromptToAppActor,
    projectId: string,
    entrada: { readonly questionId: StudioIntakeTurn['question_id']; readonly question: string; readonly recommended: boolean; readonly digitada: string },
    produzir: () => Promise<Pick<StudioIntakeTurn, 'answer' | 'route' | 'model'>>,
    requestKey?: string,
  ): Promise<StudioIntakeTurn> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const marca = entrada.recommended ? '@recomendado' : entrada.digitada
    return this.#comChaveDeEnvio(
      actor, projectId, 'resposta', marca, requestKey,
      async idReservado => {
        const produzida = await produzir()
        const turno = await this.recordTurn(actor, projectId, {
          question_id: entrada.questionId, question: entrada.question,
          recommended: entrada.recommended, ...produzida,
        }, idReservado)
        return { id: turno.turn_id, valor: turno }
      },
      async resultId => (await this.intakeTurns(actor, projectId)).find(turno => turno.turn_id === resultId),
    )
  }

  /**
   * CORRIGE uma resposta do questionário, sem recomeçar o questionário.
   *
   * A correção é um turno novo para a MESMA pergunta: as respostas valem pela
   * mais recente (`respostasDoQuestionario`), então só a decisão afetada muda
   * e as outras ficam como estavam. Nada é apagado — a resposta anterior
   * continua na conversa, que é o histórico.
   *
   * ## Até quando dá para corrigir
   *
   * Enquanto NÃO existir plano. Depois do plano, a especificação pode ter
   * recebido pedidos de mudança (`origin: 'edit'`), e refazê-la a partir do
   * questionário apagaria esses pedidos em silêncio. Ali o caminho é o pedido
   * de mudança, que já existe e é revisável.
   * @param actor - quem corrige.
   * @param projectId - a tarefa.
   * @param questionId - a pergunta corrigida.
   * @param answer - a resposta nova, como a pessoa escreveu.
   * @param requestKey - a identidade de intenção do envio.
   * @returns o turno gravado.
   */
  async correctIntakeAnswer(
    actor: PromptToAppActor, projectId: string, questionId: 'audience' | 'goal' | 'content', answer: string, requestKey?: string,
  ): Promise<StudioIntakeTurn> {
    this.#authorize(actor, 'project.write')
    const project = this.project(actor, projectId)
    const texto = answer.trim()
    if (texto === '') throw new PromptToAppError('INVALID', t('errors.answerRequired'))
    if (project.state !== 'DRAFT' && project.state !== 'SPEC_READY') throw new PromptToAppError('INVALID', t('errors.correcaoForaDeHora'))
    try {
      await this.plan(actor, projectId)
      throw new PromptToAppError('INVALID', t('errors.correcaoForaDeHora'))
    } catch (erro) {
      if (!(erro instanceof PromptToAppError) || erro.code !== 'NOT_FOUND') throw erro
    }
    const anterior = [...await this.intakeTurns(actor, projectId)].reverse().find(turno => turno.question_id === questionId)
    if (anterior === undefined) throw new PromptToAppError('INVALID', t('errors.correcaoSemResposta'))
    return this.answerIntakeTurn(
      actor, projectId,
      { questionId, question: anterior.question, recommended: false, digitada: ['correcao', questionId, texto].join('|') },
      async () => ({ answer: texto, route: null, model: null }),
      requestKey,
    )
  }

  async askAboutProject(actor: PromptToAppActor, projectId: string, pergunta: string, requestKey?: string): Promise<StudioIntakeTurn> {
    this.#authorize(actor, 'project.write')
    const project = this.project(actor, projectId)
    const texto = perguntaNormalizada(pergunta)
    if (texto === null) throw new PromptToAppError('INVALID', t('errors.perguntaInvalida', { min: MIN_PERGUNTA, max: MAX_PERGUNTA }))
    return this.#comChaveDeEnvio(
      actor, projectId, 'pergunta', texto, requestKey,
      async idReservado => {
        const turno = await this.#perguntar(actor, project, projectId, texto, idReservado)
        return { id: turno.turn_id, valor: turno }
      },
      async resultId => (await this.intakeTurns(actor, projectId)).find(turno => turno.turn_id === resultId),
    )
  }

  /**
   * A gravação da pergunta, já sem nenhuma decisão de identidade dentro.
   * @param actor - quem pergunta.
   * @param project - a tarefa, já autorizada.
   * @param projectId - o identificador dela.
   * @param texto - a pergunta normalizada.
   * @param turnId - o identificador reservado, quando há chave de envio.
   * @returns o lance gravado.
   */
  async #perguntar(
    actor: PromptToAppActor, project: StudioProject, projectId: string, texto: string, turnId: string | undefined,
  ): Promise<StudioIntakeTurn> {
    const execucoes = this.runs(actor, projectId)
    const corrente = [...execucoes].sort((esquerda, direita) =>
      direita.started_at.localeCompare(esquerda.started_at) || direita.attempt - esquerda.attempt)[0] ?? null
    // Tarefa sem plano ainda é tarefa, e perguntar sobre ela tem de funcionar:
    // `NOT_FOUND` aqui quer dizer "ainda não há plano", e não erro.
    let criterios = 0
    try {
      const plano = await this.plan(actor, projectId)
      criterios = plano.slices.reduce((soma, fatia) => soma + fatia.acceptance_criteria.length, 0)
    } catch (erro) {
      if (!(erro instanceof PromptToAppError) || erro.code !== 'NOT_FOUND') throw erro
    }
    const resposta = respostaSobreATarefa({
      estado: project.state,
      tentativasFeitas: execucoes.length,
      tentativa: corrente?.attempt ?? null,
      etapa: corrente?.stage ?? null,
      estadoDaTentativa: corrente?.state ?? null,
      criterios,
      provas: (await this.evidence(actor, projectId)).length,
      // Ausente é ausente: `?? null` e nunca `?? 0`.
      custoEstimadoUsd: corrente?.estimated_cost_usd ?? null,
    })
    return this.recordTurn(actor, projectId, {
      question_id: PERGUNTA_QUESTION_ID,
      question: texto,
      answer: respostaEmTexto(resposta),
      recommended: false,
      // Nenhum modelo foi chamado. Preencher rota ou modelo aqui seria dizer
      // que houve uma chamada que não houve — e o adendo de uso e custos do
      // dono trata exatamente disso.
      route: null,
      model: null,
    }, turnId)
  }

  async saveSpec(
    actor: PromptToAppActor, projectId: string, spec: AppSpecV1, origin: 'intake' | 'edit',
    /** O identificador JÁ RESERVADO, quando o envio tem chave. Ver `recordTurn`. */
    specId?: string,
  ): Promise<StudioAppSpecRecord> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const rows = this.#appSpecStore === undefined
      ? this.#repository.specs()
      : await listAppSpecs(this.#appSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const previous = rows.filter(value => value.project_id === projectId && this.#sameScope(actor, value))
    const value: StudioAppSpecRecord = {
      spec_id: specId ?? this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: previous.length + 1, app_spec: spec, sha256: appSpecHash(spec), origin, created_at: this.#now().toISOString(),
    }
    if (this.#appSpecStore === undefined) await this.#repository.putSpec(value)
    else await putAppSpec(this.#appSpecStore, value)
    const project = this.project(actor, projectId)
    if (project.state === 'DRAFT') await this.transition(actor, projectId, 'SPEC_READY')
    return value
  }

  async latestSpec(actor: PromptToAppActor, projectId: string): Promise<StudioAppSpecRecord> {
    this.project(actor, projectId)
    const rows = this.#appSpecStore === undefined
      ? [...this.#repository.specs()].sort((left, right) => right.version - left.version)
      : await listAppSpecs(this.#appSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const value = rows.find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.specNotFound'))
    return value
  }

  /**
   * TODAS as especificações desta tarefa, da mais antiga para a mais recente.
   *
   * `latestSpec` responde "qual vale agora"; esta responde "por onde ela
   * passou", que é outra pergunta — e é a que a conversa faz para mostrar os
   * pedidos de mudança da pessoa.
   * @param actor - quem pergunta.
   * @param projectId - a tarefa.
   * @returns as especificações, ordenadas pela versão.
   */
  async specs(actor: PromptToAppActor, projectId: string): Promise<readonly StudioAppSpecRecord[]> {
    this.project(actor, projectId)
    const rows = this.#appSpecStore === undefined
      ? this.#repository.specs()
      : await listAppSpecs(this.#appSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    return rows
      .filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
      .sort((left, right) => left.version - right.version)
  }

  async saveDesign(actor: PromptToAppActor, projectId: string, input: DesignSelection): Promise<StudioDesignSpecRecord> {
    return this.#saveDesign(actor, projectId, createDesignSpec(input))
  }

  async attachLogo(actor: PromptToAppActor, projectId: string, logo: DesignLogo): Promise<StudioDesignSpecRecord> {
    const current = await this.designOrDefault(actor, projectId)
    return this.#saveDesign(actor, projectId, designSpecV1Schema.parse({ ...current, logo }))
  }

  async latestDesign(actor: PromptToAppActor, projectId: string): Promise<StudioDesignSpecRecord> {
    this.project(actor, projectId)
    // O filtro de escopo do produto continua aqui, com ou sem RLS: as duas
    // guardas juntas é que valem alguma coisa.
    const rows = this.#designSpecStore === undefined
      ? [...this.#repository.designs()].sort((left, right) => right.version - left.version)
      : await listDesignSpecs(this.#designSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const value = rows.find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.designNotFound'))
    return value
  }

  async designOrDefault(actor: PromptToAppActor, projectId: string): Promise<DesignSpecV1> {
    this.project(actor, projectId)
    try { return (await this.latestDesign(actor, projectId)).design_spec } catch (error) {
      if (!(error instanceof PromptToAppError) || error.code !== 'NOT_FOUND') throw error
      return createDesignSpec({ preset: 'modern' })
    }
  }

  async proposePlan(actor: PromptToAppActor, projectId: string, slices: StudioPlan['slices']): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const spec = await this.latestSpec(actor, projectId); const now = this.#now().toISOString()
    const project = this.project(actor, projectId)
    const allPlans = this.#planStore === undefined
      ? this.#repository.plans()
      : await listPlans(this.#planStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const existing = allPlans.filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    const previous = [...existing].sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))[0]
    const revising = project.state === 'PLAN_PROPOSED' && previous?.status === 'CHANGE_REQUESTED'
    if (project.state !== 'SPEC_READY' && !revising) throw new PromptToAppError('INVALID', t('errors.planOrder'))
    const value: StudioPlan = {
      plan_id: this.#createId(), spec_id: spec.spec_id, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      revision: existing.length + 1, slices, status: 'PROPOSED', created_at: now, updated_at: now,
    }
    await this.#putPlan(value)
    if (!revising) await this.transition(actor, projectId, 'PLAN_PROPOSED')
    return value
  }

  async plan(actor: PromptToAppActor, projectId: string): Promise<StudioPlan> {
    this.project(actor, projectId)
    const rows = this.#planStore === undefined
      ? [...this.#repository.plans()].sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))
      : await listPlans(this.#planStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const value = rows.find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.planNotFound'))
    return value
  }

  /** Grava o plano onde a autoridade de armazenamento manda. */
  async #putPlan(value: StudioPlan): Promise<void> {
    if (this.#planStore === undefined) await this.#repository.putPlan(value)
    else await putPlanRecord(this.#planStore, value)
  }

  async approvePlan(actor: PromptToAppActor, projectId: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write'); const value = await this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', t('errors.planUnavailable'))
    const updated = { ...value, status: 'APPROVED' as const, updated_at: this.#now().toISOString() }
    await this.#putPlan(updated)
    await this.#approval(actor, projectId, 'plan', value.plan_id, 'T1', false)
    await this.transition(actor, projectId, 'PLAN_APPROVED')
    return updated
  }

  async requestPlanChange(actor: PromptToAppActor, projectId: string, reason: string, requestKey?: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const texto = reason.trim()
    if (texto.length < 3 || texto.length > 2_000) throw new PromptToAppError('INVALID', t('errors.planChangeLength'))
    /*
      O pedido de alteração NÃO duplicava efeito antes disto: a guarda de estado
      já barrava o segundo. O que ele fazia era pior de explicar para quem usa —
      devolvia um ERRO de repetição para quem só tinha reenviado o mesmo pedido
      depois de perder a resposta, e a pessoa via "não dá mais" para um pedido
      que tinha dado certo.

      Não há segunda contabilidade: é a MESMA reserva durável dos outros envios.
      A releitura não tem identificador próprio porque o plano é um por tarefa —
      ela confere o ESTADO: o plano ainda está em alteração pedida, e o pedido
      gravado é este. Se outra pessoa mudou o plano no meio, a releitura não
      reconhece, e o envio segue para a guarda de estado, que recusa com a
      verdade de agora.
    */
    return this.#comChaveDeEnvio(
      actor, projectId, 'mudanca', texto, requestKey,
      async () => ({ id: projectId, valor: await this.#pedirAlteracao(actor, projectId, texto) }),
      async () => {
        const atual = await this.plan(actor, projectId).catch(() => undefined)
        return atual !== undefined && atual.status === 'CHANGE_REQUESTED' && atual.change_request === texto ? atual : undefined
      },
    )
  }

  async #pedirAlteracao(actor: PromptToAppActor, projectId: string, texto: string): Promise<StudioPlan> {
    const value = await this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', t('errors.planChangeUnavailable'))
    const updated = { ...value, status: 'CHANGE_REQUESTED' as const, change_request: texto, updated_at: this.#now().toISOString() }
    await this.#putPlan(updated)
    return updated
  }

  /**
   * O plano depois da edição feita pela PESSOA (E-03).
   *
   * A regra inteira mora em `applyPlanEdit`, que é função pura; aqui só entram
   * as três coisas que dependem do serviço: quem pode escrever, qual plano é o
   * corrente, e a tradução do erro do módulo para o erro do serviço.
   *
   * A edição NÃO gera aprovação do plano: aprovar continua sendo um ato
   * separado, feito depois de ver o resultado da própria edição. O que ela
   * gera é o REGISTRO da edição, na mesma trilha auditável que as transições
   * já usam — sem ele o repositório sabia que o plano tinha mudado
   * (`revision`) e nunca por quem.
   * @param actor - quem edita.
   * @param projectId - o projeto.
   * @param edit - as mudanças, já validadas pelo schema.
   * @returns o plano gravado, uma revisão à frente.
   */
  async editPlan(actor: PromptToAppActor, projectId: string, edit: PlanEdit): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const value = await this.plan(actor, projectId)
    let updated: StudioPlan
    try {
      updated = applyPlanEdit(value, edit, this.#now().toISOString())
    } catch (error) {
      if (!(error instanceof PlanEditError)) throw error
      // `STALE` e `UNAVAILABLE` viram REPLAY, que a camada HTTP responde como 409:
      // as duas são "o mundo mudou embaixo de você", e não "seu pedido está errado".
      const code = error.code === 'STALE' || error.code === 'UNAVAILABLE' ? 'REPLAY' as const
        : error.code === 'NOT_FOUND' ? 'NOT_FOUND' as const : 'INVALID' as const
      throw new PromptToAppError(code, error.message)
    }
    await this.#putPlan(updated)
    // O REGISTRO da edição. Não é uma aprovação — aprovar continua sendo um ato
    // separado, feito depois de ver o resultado da própria edição —, e sim a
    // mesma trilha auditável que `transition` já usa: um ato de uma pessoa,
    // num nível, com data e autor.
    //
    // Sem ele o plano podia ser reescrito e o repositório só sabia QUE tinha
    // mudado (`revision`), nunca por QUEM. Num produto multiempresa, com papéis
    // e organizações, "alguém com permissão de escrita mudou o que vai ser
    // construído" não é um registro: é a ausência de um.
    //
    // T1 porque editar um plano ainda PROPOSTO não constrói nada nem toca
    // dado sensível. O que constrói é aprovar, e essa aprovação já é gravada.
    await this.#approval(actor, projectId, 'plan', `${updated.plan_id}:r${String(planRevision(updated))}`, 'T1', false)
    return updated
  }

  /**
   * Acrescenta ao plano uma etapa que a pessoa descreveu em português.
   *
   * A edição do plano não conseguia acrescentar NADA: quem quisesse algo fora
   * do plano pedia mudança em texto livre e recebia uma revisão inteira,
   * perdendo junto todos os títulos e critérios que já tinha ajustado à mão.
   *
   * Quem escreve a etapa é o PLANEJADOR, não a pessoa — `planned_files` é a
   * autorização de escrita do gerador, e digitar caminhos à mão seria decidir
   * onde o modelo pode mexer sem ter como saber o que isso significa.
   *
   * @param actor - quem pediu.
   * @param projectId - o projeto.
   * @param request - o que falta, nas palavras da pessoa.
   * @param planner - quem transforma o pedido em etapa.
   * @param privacy - o perfil de rota do projeto.
   * @returns o plano com a etapa nova no fim.
   */
  async addPlanSlice(
    actor: PromptToAppActor,
    projectId: string,
    request: string,
    planner: { slice(scope: { orgId: string; tenantId: string }, privacy: RoutePrivacy, spec: AppSpecV1, existing: readonly { readonly title: string; readonly planned_files: readonly string[] }[], request: string, category: StudioProjectCategory): Promise<{ readonly slice: StudioPlanSlice }> },
    privacy: RoutePrivacy,
  ): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const text = request.trim()
    // O mesmo teto do pedido de mudança: uma frase curta demais não descreve
    // etapa nenhuma, e uma parede de texto vira um plano que ninguém revisa.
    if (text.length < 3 || text.length > 2_000) throw new PromptToAppError('INVALID', t('errors.sliceUnusable'))
    const project = this.project(actor, projectId)
    const plan = await this.plan(actor, projectId)
    const spec = (await this.latestSpec(actor, projectId)).app_spec
    const { slice } = await planner.slice(
      { orgId: actor.orgId, tenantId: actor.tenantId }, privacy, spec,
      plan.slices.map(existing => ({ title: existing.title, planned_files: existing.planned_files })),
      text, project.category,
    )
    let updated: StudioPlan
    try { updated = appendPlanSlice(plan, slice, this.#now().toISOString()) }
    catch (error) {
      if (!(error instanceof PlanEditError)) throw error
      throw new PromptToAppError(error.code === 'UNAVAILABLE' ? 'REPLAY' : 'INVALID', error.message)
    }
    await this.#putPlan(updated)
    await this.#approval(actor, projectId, 'plan', `${updated.plan_id}:r${String(planRevision(updated))}`, 'T1', false)
    return updated
  }

  /**
   * Pede uma alteração numa tarefa que já produziu um resultado.
   *
   * O pedido entra na especificação como critério de aceite (a regra inteira
   * está em `revision.ts`, que é função pura) e o projeto volta a `SPEC_READY`
   * pelo mapa de revisão — que é SEPARADO do mapa normal, pelo mesmo motivo
   * que o mapa de desfazer é.
   *
   * O que ele NÃO faz, e a ausência é o requisito: não propõe plano, não
   * aprova e não inicia tentativa. Depois daqui a pessoa vê o plano novo e o
   * aprova, como sempre. Uma revisão que gerasse sozinha seria gasto sem
   * ninguém olhar.
   * @param actor - quem pede.
   * @param projectId - a tarefa, que continua sendo a mesma.
   * @param pedido - o texto escrito no compositor da conversa.
   * @returns o projeto de volta em `SPEC_READY` e a especificação nova.
   */
  async reviseProject(
    actor: PromptToAppActor, projectId: string, pedido: string, requestKey?: string,
  ): Promise<{ readonly project: StudioProject; readonly spec: StudioAppSpecRecord }> {
    this.#authorize(actor, 'project.write')
    this.project(actor, projectId)
    return this.#comChaveDeEnvio(
      actor, projectId, 'revisao', pedido.trim().replace(/\s+/gu, ' '), requestKey,
      async idReservado => {
        const feito = await this.#revisar(actor, projectId, pedido, idReservado)
        return { id: feito.spec.spec_id, valor: feito }
      },
      async resultId => {
        // A releitura devolve a MESMA revisão, reautorizada: a especificação
        // gravada com aquele identificador, e o estado da tarefa agora.
        const spec = (await this.specs(actor, projectId)).find(registro => registro.spec_id === resultId)
        return spec === undefined ? undefined : { project: this.project(actor, projectId), spec }
      },
    )
  }

  /**
   * A revisão em si, já sem nenhuma decisão de identidade dentro.
   * @param actor - quem pede.
   * @param projectId - a tarefa.
   * @param pedido - o que a pessoa escreveu.
   * @param specId - o identificador reservado, quando há chave de envio.
   * @returns a tarefa e a especificação nova.
   */
  async #revisar(
    actor: PromptToAppActor, projectId: string, pedido: string, specId?: string,
  ): Promise<{ readonly project: StudioProject; readonly spec: StudioAppSpecRecord }> {
    const project = this.project(actor, projectId)
    // Os dois erros do módulo viram erro DESTE serviço aqui, e não na camada
    // HTTP: quem chama o serviço direto — o assistente, um teste de domínio —
    // recebe a mesma recusa que a rota, com o mesmo código.
    let revisada: AppSpecV1
    try {
      assertRevisionTransition(project.state)
      const anterior = await this.latestSpec(actor, projectId)
      revisada = especificacaoRevisada(anterior.app_spec, pedido)
    } catch (error) {
      // Repetido e fora de hora são os dois "o mundo não está como você
      // pensou" — 409, e não 400: quem escreveu não errou nada.
      if (error instanceof RevisionNotAvailableError) throw new PromptToAppError('REPLAY', error.message)
      if (error instanceof RevisionError) throw new PromptToAppError(error.code === 'DUPLICATE' ? 'REPLAY' : 'INVALID', error.message)
      throw error
    }
    // A especificação é gravada ANTES da transição, e a ordem é a mesma lição
    // da reserva de criação: com o estado mudado primeiro, uma queda no meio
    // deixaria a tarefa aberta para planejar sem que o pedido tivesse entrado.
    const spec = await this.saveSpec(actor, projectId, revisada, 'edit', specId)
    const atual = this.project(actor, projectId)
    const updated: StudioProject = { ...atual, state: 'SPEC_READY', updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated)
    await this.#approval(actor, projectId, 'transition', `revise:${spec.spec_id}`, 'T1', false, project.state, 'SPEC_READY')
    return { project: updated, spec }
  }

  async transition(actor: PromptToAppActor, projectId: string, to: ProjectState): Promise<StudioProject> {
    this.#authorize(actor, 'project.write'); const value = this.project(actor, projectId)
    assertProjectTransition(value.state, to)
    const updated = { ...value, state: to, updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated)
    await this.#approval(actor, projectId, 'transition', `${value.state}:${to}`, 'T1', false, value.state, to)
    return updated
  }

  async putRun(actor: PromptToAppActor, value: StudioRun): Promise<void> {
    this.#authorize(actor, 'project.write'); this.#assertOwned(actor, value); await this.#repository.putRun(value)
  }
  async putEvidence(actor: PromptToAppActor, value: StudioEvidence): Promise<void> {
    this.#authorize(actor, 'project.write'); this.#assertOwned(actor, value)
    if (this.#evidenceStore === undefined) await this.#repository.putEvidence(value)
    else await putEvidenceRecord(this.#evidenceStore, value)
  }
  /**
   * Os pontos aos quais a pessoa pode voltar, e por que não há nenhum quando não há.
   *
   * Lê o MESMO registro de execução que a tela do relatório lê - não existe uma
   * segunda fonte de verdade sobre o que foi conservado, que é como duas telas
   * passariam a discordar sobre o que aconteceu.
   * @param actor - quem pergunta.
   * @param projectId - o projeto.
   * @returns os pontos, qual deles é seguro, e para onde a pessoa está olhando.
   */
  checkpoints(actor: PromptToAppActor, projectId: string): {
    readonly checkpoints: readonly RunCheckpoint[]
    readonly green_run_id: string | null
    readonly reason: CheckpointBlocker | typeof NO_ATTEMPT | null
    readonly current_run_id: string | null
  } {
    const project = this.project(actor, projectId)
    const checkpoints = runCheckpoints(this.runs(actor, projectId))
    const green = latestGreenCheckpoint(checkpoints)
    return {
      checkpoints,
      green_run_id: green?.run_id ?? null,
      reason: noGreenReason(checkpoints),
      current_run_id: project.current_run_id ?? null,
    }
  }

  /**
   * Volta o projeto para um ponto seguro, sem apagar NADA.
   *
   * Desfazer aqui é navegação, não destruição: nenhum diretório de execução,
   * nenhuma evidência e nenhum registro de tentativa é removido ou reescrito. O
   * que muda é o estado do projeto e qual tentativa é a corrente - isto é, para
   * onde a pessoa está olhando. Um reset destrutivo é proibição explícita do
   * produto, e por isso este método não tem sequer acesso a disco.
   *
   * A recusa é dupla e as duas metades importam: a tentativa precisa ser um
   * ponto PROVADO (`checkpoint.ts`), e o estado atual precisa permitir a volta
   * (`UNDO_TRANSITIONS`). Sem a primeira, qualquer falha viraria um verde; sem a
   * segunda, daria para desfazer no meio de uma criação em andamento.
   * @param actor - quem desfaz.
   * @param projectId - o projeto.
   * @param runId - a tentativa para a qual voltar.
   * @returns o projeto atualizado e o ponto para onde ele voltou.
   */
  async undoToCheckpoint(actor: PromptToAppActor, projectId: string, runId: string): Promise<{ readonly project: StudioProject; readonly checkpoint: RunCheckpoint }> {
    this.#authorize(actor, 'project.write')
    const project = this.project(actor, projectId)
    // `runs` já filtra por org e tenant: uma tentativa de OUTRO escopo não é
    // "recusada depois", ela simplesmente não existe para quem pergunta.
    const checkpoint = runCheckpoints(this.runs(actor, projectId)).find(candidate => candidate.run_id === runId)
    if (checkpoint === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.checkpointNotFound'))
    if (!checkpoint.green) throw new PromptToAppError('INVALID', t('errors.checkpointNotGreen'))
    assertUndoTransition(project.state, 'VERIFIED_PROTOTYPE')
    const updated: StudioProject = {
      ...project, state: 'VERIFIED_PROTOTYPE', current_run_id: checkpoint.run_id,
      updated_at: this.#now().toISOString(),
    }
    await this.#repository.putProject(updated)
    await this.#approval(actor, projectId, 'transition', `undo:${checkpoint.run_id}`, 'T1', false, project.state, 'VERIFIED_PROTOTYPE')
    return { project: updated, checkpoint }
  }

  runs(actor: PromptToAppActor, projectId: string) { this.project(actor, projectId); return this.#repository.runs().filter(value => value.project_id === projectId && this.#sameScope(actor, value)) }

  /**
   * TODAS as execuções deste espaço de trabalho, numa leitura só.
   *
   * MEDIDO, e não suposto. Quem quer o histórico inteiro fazia um laço sobre os
   * projetos chamando {@link runs} para cada um — e `runs` lê o repositório
   * INTEIRO e filtra. O resultado é quadrático: cada projeto relê todas as
   * execuções de todos os projetos.
   *
   * | projetos × execuções | por projeto | numa leitura |
   * | --- | --- | --- |
   * | 50 × 50 | 1,7 ms | 0,5 ms |
   * | 200 × 50 | 17,2 ms | 2,6 ms |
   * | 500 × 100 | **188 ms** | 10,6 ms |
   *
   * Cento e oitenta e oito milissegundos de CPU pura, num endereço de saúde que
   * uma tela consulta de tempos em tempos, não é detalhe — e dobrar o número de
   * projetos QUADRUPLICA o número.
   *
   * A visibilidade é a MESMA de antes: só projetos do escopo e não arquivados,
   * que é o que o laço sobre `listProjects` já garantia. Um atalho que passasse
   * a enxergar o arquivado seria ganhar desempenho mudando a resposta.
   *
   * O `#sameScope` na EXECUÇÃO parece redundante — a lista de projetos visíveis
   * já filtrou o escopo —, e seria, enquanto nenhum identificador de projeto
   * colidisse entre inquilinos. Ele fica, e há teste que lhe dá peso: para
   * isolamento entre inquilinos, a resposta certa a uma guarda redundante não é
   * removê-la, é escrever o caso em que ela decide.
   *
   * O NÚMERO acima não é conferido por teste. Um teste de tempo em máquina
   * compartilhada mede a máquina, e passaria a falhar por motivo nenhum. O que
   * garante a leitura única é a ausência de laço sobre projetos aqui — e uma
   * sabotagem que reintroduza esse laço SOBREVIVE de propósito, porque ela
   * devolve a mesma resposta, só mais devagar.
   * @param actor - quem lê.
   * @returns as execuções, com o projeto de cada uma.
   */
  runsInScope(actor: PromptToAppActor): readonly StudioRun[] {
    const visible = new Set(this.listProjects(actor).map(project => project.project_id))
    return this.#repository.runs().filter(value => visible.has(value.project_id) && this.#sameScope(actor, value))
  }
  async evidence(actor: PromptToAppActor, projectId: string): Promise<readonly StudioEvidence[]> {
    this.project(actor, projectId)
    const rows = this.#evidenceStore === undefined
      ? this.#repository.evidence()
      : await listEvidence(this.#evidenceStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    return rows.filter(value => value.project_id === projectId && this.#sameScope(actor, value))
  }

  async reconcileInterruptedExecutions(): Promise<{ readonly runs: number; readonly projects: number }> {
    const now = this.#now().toISOString()
    let recoveredRuns = 0
    let recoveredProjects = 0
    for (const run of this.#repository.runs().filter(value => value.state === 'PENDING' || value.state === 'RUNNING')) {
      await this.#repository.putRun({
        ...run, state: 'FAILED', finished_at: now, artifact_sha256: null,
        failure_code: 'STUDIO_RESTARTED_DURING_RUN',
      })
      recoveredRuns++
    }
    for (const project of this.#repository.projects()) {
      if (project.state !== 'GENERATING' && project.state !== 'BUILD_OK' && project.state !== 'TESTS_OK') continue
      const projectRuns = this.#repository.runs().filter(run => run.project_id === project.project_id && run.org_id === project.org_id && run.tenant_id === project.tenant_id)
      const latest = [...projectRuns].sort((left, right) => right.started_at.localeCompare(left.started_at))[0]
      const operationId = latest?.operation_id ?? `recovery-${project.project_id}`
      const markerId = recoveryId('run', project, operationId)
      if (!projectRuns.some(run => run.failure_code === 'STUDIO_RESTARTED_DURING_RUN' && run.operation_id === operationId)) {
        await this.#repository.putRun({
          run_id: markerId, operation_id: operationId, owner_session_id: 'studio-system-recovery',
          plan_id: latest?.plan_id ?? 'recovery-unavailable', project_id: project.project_id,
          org_id: project.org_id, tenant_id: project.tenant_id, stage: latest?.stage ?? 'verify',
          attempt: latest?.attempt ?? 1, state: 'FAILED', started_at: latest?.started_at ?? now, finished_at: now,
          sandbox: latest?.sandbox ?? 'unavailable', route: latest?.route ?? null, model: latest?.model ?? null,
          input_tokens: latest?.input_tokens ?? null, output_tokens: latest?.output_tokens ?? null,
          estimated_cost_usd: latest?.estimated_cost_usd ?? null, run_directory: latest?.run_directory ?? 'not-created',
          artifact_sha256: null, failure_code: 'STUDIO_RESTARTED_DURING_RUN', acceptance_checks: latest?.acceptance_checks ?? [],
        })
        recoveredRuns++
      }
      await this.#repository.putApproval({
        approval_id: recoveryId('transition', project, operationId),
        project_id: project.project_id, org_id: project.org_id, tenant_id: project.tenant_id,
        subject: 'transition', subject_id: `${project.state}:INTERRUPTED:${operationId}`,
        approved_by: 'studio-system-recovery', approved_at: now, tier: 'T1', strong_identity: false,
        from_state: project.state, to_state: 'INTERRUPTED',
      })
      await this.#repository.putProject({ ...project, state: 'INTERRUPTED', updated_at: now })
      recoveredProjects++
    }
    return { runs: recoveredRuns, projects: recoveredProjects }
  }

  async archive(actor: PromptToAppActor, projectId: string): Promise<StudioProject> {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new PromptToAppError('FORBIDDEN', t('errors.archiveForbidden'))
    const value = this.project(actor, projectId); const updated = { ...value, archived_at: this.#now().toISOString(), updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated); return updated
  }

  async #saveDesign(actor: PromptToAppActor, projectId: string, designSpec: DesignSpecV1): Promise<StudioDesignSpecRecord> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const rows = this.#designSpecStore === undefined
      ? this.#repository.designs()
      : await listDesignSpecs(this.#designSpecStore, { orgId: actor.orgId, tenantId: actor.tenantId })
    const previous = rows.filter(value => value.project_id === projectId && this.#sameScope(actor, value))
    const value: StudioDesignSpecRecord = {
      design_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: previous.length + 1, design_spec: designSpecV1Schema.parse(designSpec), sha256: designSpecHash(designSpec),
      created_by: actor.userId, created_at: this.#now().toISOString(),
    }
    if (this.#designSpecStore === undefined) await this.#repository.putDesign(value)
    else await putDesignSpec(this.#designSpecStore, value)
    return value
  }

  #authorize(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new PromptToAppError('FORBIDDEN', t('errors.forbidden'))
  }
  #sameScope(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): boolean { return value.org_id === actor.orgId && value.tenant_id === actor.tenantId }
  #assertOwned(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): void { if (!this.#sameScope(actor, value)) throw new PromptToAppError('FORBIDDEN', t('errors.crossTenant')) }
  async #approval(actor: PromptToAppActor, projectId: string, subject: StudioApproval['subject'], subjectId: string, tier: StudioApproval['tier'], strong: boolean, from: ProjectState | null = null, to: ProjectState | null = null) {
    const approval: StudioApproval = {
      approval_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      subject, subject_id: subjectId, approved_by: actor.userId, approved_at: this.#now().toISOString(), tier,
      strong_identity: strong, from_state: from, to_state: to,
    }
    await this.#repository.putApproval(approval)
  }
}

export function values<T>(table: { entries(): IterableIterator<[PromptToAppKey, T]> }): T[] { return [...table.entries()].map(([, value]) => value) }

function recoveryId(kind: 'run' | 'transition', project: Pick<StudioProject, 'org_id' | 'tenant_id' | 'project_id'>, operationId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([kind, project.org_id, project.tenant_id, project.project_id, operationId])).digest('hex')
  return `recovery-${kind}-${digest}`
}
