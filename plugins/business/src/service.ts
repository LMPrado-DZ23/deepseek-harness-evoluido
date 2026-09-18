import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import type { StudioProject } from '@dz23-studio/prompt-to-app'
import { t } from './i18n.js'
import type { Empresa, Oferta, PlanoDeNegocio, RegistroDeOferta, RegistroDePlano, VinculoDeTarefa } from './model.js'
import { briefingDaEmpresa, nomeDaTarefa, planoNormalizado, planoVigente, proximaVersao, recusaDePlano, textoNormalizado } from './regras.js'
import { catalogoVigente, proximaVersaoDaOferta, recusaDeAprovacao, recusaDeOferta } from './oferta.js'

/** Quem age. O escopo vem daqui, e nunca do corpo do pedido. */
export interface BusinessActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
}

export class BusinessError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT',
    message: string,
  ) { super(message) }
}

export interface BusinessRepository {
  businesses(): readonly Empresa[]
  putBusiness(value: Empresa): Promise<void>
  plans(): readonly RegistroDePlano[]
  putPlan(value: RegistroDePlano): Promise<void>
  links(): readonly VinculoDeTarefa[]
  putLink(value: VinculoDeTarefa): Promise<void>
  offers(): readonly RegistroDeOferta[]
  putOffer(value: RegistroDeOferta): Promise<void>
}

/** Uma tarefa, no pouco que o Modo Empresa precisa saber sobre ela. */
export interface TarefaCriada {
  readonly project_id: string
  readonly name: string
  readonly state: string
}

/**
 * Quem sabe criar tarefa.
 *
 * É uma PORTA, e não uma importação do serviço de tarefas, por duas razões que
 * já custaram caro aqui. A primeira é de autoridade: a tarefa continua sendo do
 * `prompt-to-app`, com a identidade de envio, a reserva durável e a contagem de
 * tentativas que ele já tem — este serviço não abre uma segunda contabilidade
 * de criação. A segunda é de prova: com a porta, a ordem das duas escritas é
 * exercitável por teste sem montar o produto inteiro.
 */
export interface TarefasPort {
  criar(
    actor: BusinessActor,
    input: Pick<StudioProject, 'name' | 'original_brief' | 'category' | 'privacy'>,
    requestKey: string | undefined,
  ): Promise<TarefaCriada>
}

/** A categoria e a privacidade da tarefa, como o domínio dela as declara. */
export type CategoriaDaTarefa = StudioProject['category']
export type PrivacidadeDaTarefa = StudioProject['privacy']

export interface BusinessServiceOptions {
  readonly repository: BusinessRepository
  readonly now?: () => Date
  readonly createId?: () => string
  /**
   * OPCIONAL de propósito: um perfil que monte o Modo Empresa sem o
   * `prompt-to-app` continua listando e revisando empresas, e a rota de criar
   * tarefa recusa em palavras em vez de o Studio inteiro deixar de subir.
   */
  readonly tarefas?: TarefasPort
}

/**
 * As empresas que este Studio opera — `BUS-01`.
 *
 * ## O isolamento é o que já existe
 *
 * Toda leitura filtra por `org_id` e `tenant_id` do ATOR, e nenhuma delas
 * aceita escopo vindo do pedido. Não há autoridade de isolamento nova: a
 * empresa mora dentro do inquilino que o Studio já separa, e criar uma segunda
 * seria a segunda verdade mais cara que este repositório já produziu.
 *
 * ## O que o serviço NÃO faz
 *
 * - **não confere identidade jurídica.** CNPJ e contrato social são fatos do
 *   mundo; o campo guarda o que a pessoa DECLAROU, e o nome dele diz isso;
 * - **não apaga empresa.** Arquivar tira das listas e fecha para plano novo;
 *   apagar dado é ação destrutiva e exige decisão explícita do dono;
 * - **não publica nada.** Criar a empresa aqui não cria conta, domínio,
 *   pagamento nem site em lugar nenhum.
 */
export class BusinessService {
  readonly #repository: BusinessRepository
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #tarefas: TarefasPort | undefined

  constructor(options: BusinessServiceOptions) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID())
    this.#tarefas = options.tarefas
  }

  #autorizar(actor: BusinessActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new BusinessError('FORBIDDEN', t('errors.forbidden'))
  }

  #noEscopo(actor: BusinessActor, valor: { readonly org_id: string; readonly tenant_id: string }): boolean {
    return valor.org_id === actor.orgId && valor.tenant_id === actor.tenantId
  }

  /**
   * As empresas deste escopo, da mais recente para a mais antiga.
   *
   * Arquivadas ficam de fora: elas não sumiram, mas também não são o que a
   * pessoa está procurando quando abre a lista.
   * @param actor - quem lê.
   * @returns as empresas ativas.
   */
  list(actor: BusinessActor): readonly Empresa[] {
    this.#autorizar(actor, 'project.read')
    return this.#repository.businesses()
      .filter(empresa => this.#noEscopo(actor, empresa) && empresa.archived_at === null)
      .sort((esquerda, direita) => direita.created_at.localeCompare(esquerda.created_at))
  }

  /**
   * Uma empresa, reautorizada.
   * @param actor - quem lê.
   * @param businessId - a empresa.
   * @returns a empresa.
   */
  get(actor: BusinessActor, businessId: string): Empresa {
    this.#autorizar(actor, 'project.read')
    const empresa = this.#repository.businesses().find(valor => valor.business_id === businessId)
    // Fora do escopo responde NÃO ENCONTRADA, e não "proibida": dizer
    // "proibida" confirmaria para quem perguntou que a empresa existe.
    if (empresa === undefined || !this.#noEscopo(actor, empresa)) throw new BusinessError('NOT_FOUND', t('errors.businessNotFound'))
    return empresa
  }

  /**
   * Cria — ou vincula — uma empresa, com a primeira versão do plano.
   *
   * As duas coisas acontecem juntas de propósito: uma empresa sem objetivo e
   * sem público não é operável, e deixar o plano para depois produziria uma
   * lista de empresas vazias que ninguém sabe para que servem.
   * @param actor - quem cria.
   * @param entrada - o nome, a origem, a declaração jurídica e o plano.
   * @returns a empresa e a primeira versão do plano.
   */
  async create(
    actor: BusinessActor,
    entrada: {
      readonly nome: string
      readonly origem: Empresa['origem']
      readonly identidade_juridica_declarada?: string | null | undefined
      readonly plano: PlanoDeNegocio
    },
  ): Promise<{ readonly empresa: Empresa; readonly plano: RegistroDePlano }> {
    this.#autorizar(actor, 'project.write')
    const nome = textoNormalizado(entrada.nome)
    if (nome.length < 2) throw new BusinessError('INVALID', t('errors.nameRequired'))
    const agora = this.#now().toISOString()
    const empresa: Empresa = {
      business_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      nome, origem: entrada.origem,
      identidade_juridica_declarada: entrada.identidade_juridica_declarada === undefined || entrada.identidade_juridica_declarada === null
        ? null
        : textoNormalizado(entrada.identidade_juridica_declarada),
      created_by: actor.userId, created_at: agora, updated_at: agora, archived_at: null,
    }
    // A EMPRESA PRIMEIRO, e o plano depois. A ordem é a mesma lição das outras
    // gravações em par deste repositório: com o plano gravado antes, uma queda
    // no meio deixaria um plano apontando para uma empresa que não existe.
    await this.#repository.putBusiness(empresa)
    const plano = await this.#gravarPlano(actor, empresa, entrada.plano)
    return { empresa, plano }
  }

  /**
   * As versões do plano desta empresa, da mais nova para a mais antiga.
   * @param actor - quem lê.
   * @param businessId - a empresa.
   * @returns as versões.
   */
  planos(actor: BusinessActor, businessId: string): readonly RegistroDePlano[] {
    this.get(actor, businessId)
    return this.#repository.plans()
      .filter(registro => registro.business_id === businessId && this.#noEscopo(actor, registro))
      .sort((esquerda, direita) => direita.version - esquerda.version)
  }

  /**
   * Grava uma versão NOVA do plano.
   *
   * O plano nunca é editado no lugar: uma decisão tomada sobre o plano de
   * ontem precisa continuar legível depois de ele virar outro.
   * @param actor - quem escreve.
   * @param businessId - a empresa.
   * @param plano - o plano proposto.
   * @returns a versão gravada.
   */
  async revisarPlano(actor: BusinessActor, businessId: string, plano: PlanoDeNegocio): Promise<RegistroDePlano> {
    this.#autorizar(actor, 'project.write')
    const empresa = this.get(actor, businessId)
    return this.#gravarPlano(actor, empresa, plano)
  }

  /**
   * Arquiva a empresa: ela sai das listas e não recebe plano novo.
   *
   * Arquivar NÃO é apagar. O histórico continua inteiro, e é por isso que esta
   * é a operação que existe — apagar dado é destrutivo e exige decisão
   * explícita do dono do produto.
   * @param actor - quem arquiva.
   * @param businessId - a empresa.
   * @returns a empresa arquivada.
   */
  async arquivar(actor: BusinessActor, businessId: string): Promise<Empresa> {
    this.#autorizar(actor, 'project.write')
    const empresa = this.get(actor, businessId)
    if (empresa.archived_at !== null) return empresa
    const agora = this.#now().toISOString()
    const arquivada: Empresa = { ...empresa, archived_at: agora, updated_at: agora }
    await this.#repository.putBusiness(arquivada)
    return arquivada
  }

  /**
   * As tarefas criadas para esta empresa, da mais recente para a mais antiga.
   * @param actor - quem lê.
   * @param businessId - a empresa.
   * @returns os vínculos.
   */
  tarefas(actor: BusinessActor, businessId: string): readonly VinculoDeTarefa[] {
    this.get(actor, businessId)
    return this.#repository.links()
      .filter(vinculo => vinculo.business_id === businessId && this.#noEscopo(actor, vinculo))
      .sort((esquerda, direita) => direita.created_at.localeCompare(esquerda.created_at))
  }

  /**
   * Cria uma tarefa PARA esta empresa, com o plano dela dentro do briefing.
   *
   * Esta é a operação que fecha `empresa → objetivo → plano → tarefa`: sem ela,
   * o vínculo seria um rótulo e o gerador receberia o mesmo pedido genérico de
   * sempre, sem saber para quem é nem o que a empresa não faz.
   *
   * A TAREFA PRIMEIRO, e o vínculo depois. A ordem é a mesma das outras
   * gravações em par deste repositório: com o vínculo gravado antes, uma queda
   * no meio deixaria um vínculo apontando para uma tarefa que não existe — e a
   * empresa listaria uma tarefa que ninguém consegue abrir. Na ordem certa, a
   * queda deixa uma tarefa sem vínculo, que é visível, reversível e honesta.
   *
   * A identidade de envio NÃO é refeita aqui: `requestKey` atravessa inteiro
   * para quem já sabe tratá-la. Uma segunda contabilidade de criação seria a
   * segunda verdade mais cara que este plugin poderia produzir.
   * @param actor - quem cria.
   * @param businessId - a empresa.
   * @param entrada - o pedido da pessoa e as escolhas de categoria e privacidade.
   * @param requestKey - a identidade da intenção de envio, repassada inteira.
   * @returns a tarefa criada e o vínculo gravado.
   */
  async criarTarefa(
    actor: BusinessActor,
    businessId: string,
    entrada: { readonly pedido: string; readonly category: CategoriaDaTarefa; readonly privacy: PrivacidadeDaTarefa },
    requestKey?: string,
  ): Promise<{ readonly tarefa: TarefaCriada; readonly vinculo: VinculoDeTarefa }> {
    this.#autorizar(actor, 'project.write')
    const empresa = this.get(actor, businessId)
    // Uma empresa arquivada não recebe plano novo; criar tarefa nova para ela
    // seria a mesma contradição por outra porta.
    if (empresa.archived_at !== null) throw new BusinessError('CONFLICT', t('errors.businessArchived'))
    if (this.#tarefas === undefined) throw new BusinessError('CONFLICT', t('errors.tasksUnavailable'))
    const vigente = planoVigente(this.#repository.plans()
      .filter(registro => registro.business_id === businessId && this.#noEscopo(actor, registro)))
    if (vigente === undefined) throw new BusinessError('CONFLICT', t('errors.planMissing'))
    const pedido = textoNormalizado(entrada.pedido)
    if (pedido.length < 3) throw new BusinessError('INVALID', t('errors.requestRequired'))
    const tarefa = await this.#tarefas.criar(actor, {
      name: nomeDaTarefa(pedido, empresa.nome),
      original_brief: briefingDaEmpresa(empresa, vigente.plano, pedido),
      category: entrada.category,
      privacy: entrada.privacy,
    }, requestKey)
    const jaVinculada = this.#repository.links().find(vinculo => vinculo.project_id === tarefa.project_id)
    // Reenvio com a MESMA chave devolve a MESMA tarefa: gravar um segundo
    // vínculo para ela faria a empresa listar a mesma tarefa duas vezes.
    if (jaVinculada !== undefined) return { tarefa, vinculo: jaVinculada }
    const vinculo: VinculoDeTarefa = {
      link_id: this.#createId(), business_id: businessId, project_id: tarefa.project_id,
      org_id: actor.orgId, tenant_id: actor.tenantId,
      plan_version: vigente.version, created_by: actor.userId,
      created_at: this.#now().toISOString(),
    }
    await this.#repository.putLink(vinculo)
    return { tarefa, vinculo }
  }

  /**
   * O CATÁLOGO da empresa: a versão que vale de cada oferta — `BUS-03`.
   *
   * Vale a versão de maior número, aprovada ou não. Mostrar só as aprovadas
   * faria uma revisão em andamento sumir da tela de quem a escreveu, e quem
   * precisa da distinção lê `approved_at`, que vem junto.
   * @param actor - quem lê.
   * @param businessId - a empresa.
   * @returns uma entrada por oferta, em ordem alfabética.
   */
  catalogo(actor: BusinessActor, businessId: string): readonly RegistroDeOferta[] {
    this.get(actor, businessId)
    return catalogoVigente(this.#ofertasDaEmpresa(actor, businessId))
  }

  /**
   * Todas as versões de UMA oferta, da mais nova para a mais antiga.
   * @param actor - quem lê.
   * @param businessId - a empresa.
   * @param offerKey - a oferta.
   * @returns as versões.
   */
  versoesDaOferta(actor: BusinessActor, businessId: string, offerKey: string): readonly RegistroDeOferta[] {
    this.get(actor, businessId)
    return this.#ofertasDaEmpresa(actor, businessId)
      .filter(registro => registro.offer_key === offerKey)
      .sort((esquerda, direita) => direita.version - esquerda.version)
  }

  /**
   * Cria uma oferta NOVA no catálogo — sempre na versão 1, sempre rascunho.
   *
   * Ela nasce NÃO APROVADA mesmo quando chega completa. Aprovar é um ato de
   * quem responde pela empresa, e fazê-lo acontecer junto da criação tiraria
   * dessa pessoa a única decisão que o aceite pede que seja dela.
   * @param actor - quem cria.
   * @param businessId - a empresa.
   * @param oferta - a oferta proposta.
   * @returns a primeira versão.
   */
  async criarOferta(actor: BusinessActor, businessId: string, oferta: Oferta): Promise<RegistroDeOferta> {
    this.#autorizar(actor, 'project.write')
    const empresa = this.get(actor, businessId)
    if (empresa.archived_at !== null) throw new BusinessError('CONFLICT', t('errors.businessArchived'))
    return this.#gravarOferta(actor, empresa, this.#createId(), oferta)
  }

  /**
   * Grava uma versão NOVA de uma oferta que já existe.
   *
   * A oferta nunca é editada no lugar, pela mesma razão do plano: um pedido
   * aceito sob as condições de ontem precisa continuar legível depois de as
   * condições virarem outras.
   * @param actor - quem escreve.
   * @param businessId - a empresa.
   * @param offerKey - a oferta.
   * @param oferta - a versão proposta.
   * @returns a versão gravada.
   */
  async revisarOferta(actor: BusinessActor, businessId: string, offerKey: string, oferta: Oferta): Promise<RegistroDeOferta> {
    this.#autorizar(actor, 'project.write')
    const empresa = this.get(actor, businessId)
    const existe = this.#ofertasDaEmpresa(actor, businessId).some(registro => registro.offer_key === offerKey)
    if (!existe) throw new BusinessError('NOT_FOUND', t('errors.offerNotFound'))
    return this.#gravarOferta(actor, empresa, offerKey, oferta)
  }

  /**
   * APROVA uma versão da oferta.
   *
   * A aprovação fica na versão, e é isso que "condições aprovadas" quer dizer:
   * as condições que estavam escritas quando alguém aprovou. Ela NÃO publica
   * nada — não cria página, catálogo público, cobrança nem anúncio em lugar
   * nenhum, e o aceite de `BUS-03` é explícito sobre isso.
   * @param actor - quem aprova.
   * @param businessId - a empresa.
   * @param offerVersionId - a versão.
   * @returns a versão aprovada.
   */
  async aprovarOferta(actor: BusinessActor, businessId: string, offerVersionId: string): Promise<RegistroDeOferta> {
    this.#autorizar(actor, 'project.write')
    const empresa = this.get(actor, businessId)
    if (empresa.archived_at !== null) throw new BusinessError('CONFLICT', t('errors.businessArchived'))
    const registro = this.#ofertasDaEmpresa(actor, businessId).find(valor => valor.offer_version_id === offerVersionId)
    if (registro === undefined) throw new BusinessError('NOT_FOUND', t('errors.offerNotFound'))
    const recusa = recusaDeAprovacao(registro)
    // As chaves ficam LITERAIS, e não montadas: uma chave interpolada não é
    // encontrável por busca e `gate:i18n` não consegue segui-la.
    if (recusa === 'ja-aprovada') throw new BusinessError('CONFLICT', t('errors.offerAlreadyApproved'))
    if (recusa === 'sem-preco') throw new BusinessError('CONFLICT', t('errors.offerPriceRequired'))
    if (recusa === 'sem-capacidade') throw new BusinessError('CONFLICT', t('errors.offerCapacityRequired'))
    if (recusa === 'sem-condicoes') throw new BusinessError('CONFLICT', t('errors.offerTermsRequired'))
    const aprovada: RegistroDeOferta = {
      ...registro,
      approved_at: this.#now().toISOString(),
      approved_by: actor.userId,
    }
    await this.#repository.putOffer(aprovada)
    return aprovada
  }

  #ofertasDaEmpresa(actor: BusinessActor, businessId: string): readonly RegistroDeOferta[] {
    return this.#repository.offers()
      .filter(registro => registro.business_id === businessId && this.#noEscopo(actor, registro))
  }

  async #gravarOferta(actor: BusinessActor, empresa: Empresa, offerKey: string, proposta: Oferta): Promise<RegistroDeOferta> {
    const anteriores = this.#ofertasDaEmpresa(actor, empresa.business_id)
    const vigente = catalogoVigente(anteriores).find(registro => registro.offer_key === offerKey)
    const recusa = recusaDeOferta(empresa, vigente, proposta)
    if (recusa === 'arquivada') throw new BusinessError('CONFLICT', t('errors.businessArchived'))
    if (recusa !== null) throw new BusinessError('CONFLICT', t('errors.offerUnchanged'))
    const registro: RegistroDeOferta = {
      offer_version_id: this.#createId(), offer_key: offerKey,
      business_id: empresa.business_id, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: proximaVersaoDaOferta(anteriores, offerKey), oferta: proposta,
      created_by: actor.userId, created_at: this.#now().toISOString(),
      // Nasce SEMPRE em rascunho, inclusive a revisão de uma oferta aprovada:
      // herdar a aprovação faria condições que ninguém leu virarem "condições
      // aprovadas", que é exatamente o que o aceite proíbe.
      approved_at: null, approved_by: null,
    }
    await this.#repository.putOffer(registro)
    return registro
  }

  async #gravarPlano(actor: BusinessActor, empresa: Empresa, proposto: PlanoDeNegocio): Promise<RegistroDePlano> {
    const normalizado = planoNormalizado(proposto)
    const anteriores = this.#repository.plans()
      .filter(registro => registro.business_id === empresa.business_id && this.#noEscopo(actor, registro))
    const recusa = recusaDePlano(empresa, planoVigente(anteriores)?.plano, normalizado)
    // As duas chaves ficam LITERAIS: uma montada com interpolação não é
    // encontrável por busca, e o portão de i18n — que confere se todo texto
    // exibido tem catálogo — não tem como segui-la.
    if (recusa === 'arquivada') throw new BusinessError('CONFLICT', t('errors.businessArchived'))
    if (recusa !== null) throw new BusinessError('CONFLICT', t('errors.planUnchanged'))
    const registro: RegistroDePlano = {
      plan_id: this.#createId(), business_id: empresa.business_id,
      org_id: actor.orgId, tenant_id: actor.tenantId,
      version: proximaVersao(anteriores), plano: normalizado,
      created_by: actor.userId, created_at: this.#now().toISOString(),
    }
    await this.#repository.putPlan(registro)
    return registro
  }
}
