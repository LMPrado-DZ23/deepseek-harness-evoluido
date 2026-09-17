import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { t } from './i18n.js'
import type { Empresa, PlanoDeNegocio, RegistroDePlano } from './model.js'
import { planoNormalizado, planoVigente, proximaVersao, recusaDePlano, textoNormalizado } from './regras.js'

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
}

export interface BusinessServiceOptions {
  readonly repository: BusinessRepository
  readonly now?: () => Date
  readonly createId?: () => string
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

  constructor(options: BusinessServiceOptions) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID())
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
