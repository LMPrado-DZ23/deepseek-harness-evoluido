import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { registerPromptToAppWorkspaceHttpExtension } from '@dz23-studio/prompt-to-app'
import { createBusinessHttpExtension } from './http.js'
import {
  studioBusinessDomainSpec,
  studioBusinessPlansDomainSpec,
  type BusinessKey,
  type Empresa,
  type RegistroDePlano,
} from './model.js'
import { BusinessService, type BusinessRepository } from './service.js'

export * from './http.js'
export * from './model.js'
export * from './regras.js'
export * from './service.js'

export const name = 'dz23-studio-business'

/**
 * `inject` lista SÓ o que este plugin não sabe viver sem.
 *
 * `prompt-to-app` entra porque a extensão HTTP é registrada no manipulador de
 * workspace dele — sem ele, as rotas da empresa não existem em lugar nenhum, e
 * um plugin que sobe sem rota é exatamente o defeito que `gate:profile-mounts`
 * nasceu para pegar.
 */
export const inject = ['storageDomain', 'promptToApp']

export interface StudioBusinessRuntime {
  readonly service: BusinessService
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioBusiness: StudioBusinessRuntime }
}

/**
 * O repositório sobre as duas tabelas do domínio.
 *
 * Exportado para que a LEITURA possa ser provada contra ESTA implementação, e
 * não só contra o dublê de memória do serviço: com os testes do serviço usando
 * repositório próprio, trocar o filtro daqui não quebraria teste nenhum.
 *
 * Não há cópia em memória aqui de propósito. A leitura de `KvTable` já é
 * síncrona sobre o estado autoritativo, e um cache ao lado dele seria a segunda
 * verdade mais barata de escrever e mais cara de consertar deste plugin: bastaria
 * uma escrita por outro caminho para a lista da tela divergir do que está gravado.
 */
export class DomainBusinessRepository implements BusinessRepository {
  constructor(
    private readonly businessTable: KvTable<BusinessKey, Empresa>,
    private readonly planTable: KvTable<BusinessKey, RegistroDePlano>,
  ) {}

  businesses = (): readonly Empresa[] => [...this.businessTable.entries()].map(([, valor]) => valor)
  plans = (): readonly RegistroDePlano[] => [...this.planTable.entries()].map(([, valor]) => valor)

  putBusiness = async (value: Empresa): Promise<void> => {
    await this.businessTable.put(value.business_id as BusinessKey, value)
  }

  putPlan = async (value: RegistroDePlano): Promise<void> => {
    await this.planTable.put(value.plan_id as BusinessKey, value)
  }
}

export async function apply(ctx: Context): Promise<void> {
  const businesses: Domain<typeof studioBusinessDomainSpec> = await ctx.storageDomain.open(studioBusinessDomainSpec)
  ctx.effect(() => () => businesses.close(), 'studio-business.domainClose')
  const plans: Domain<typeof studioBusinessPlansDomainSpec> = await ctx.storageDomain.open(studioBusinessPlansDomainSpec)
  ctx.effect(() => () => plans.close(), 'studio-business.plansDomainClose')
  const repository = new DomainBusinessRepository(businesses.table('businesses'), plans.table('plans'))
  const service = new BusinessService({ repository })
  const unregister = registerPromptToAppWorkspaceHttpExtension(createBusinessHttpExtension(service))
  ctx.effect(() => unregister, 'studio-business.httpExtension')
  ctx.provide('studioBusiness', { service })
}
