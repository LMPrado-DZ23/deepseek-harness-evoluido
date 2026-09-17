import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { registerPromptToAppWorkspaceHttpExtension } from '@dz23-studio/prompt-to-app'
import { createBusinessHttpExtension } from './http.js'
import {
  studioBusinessDomainSpec,
  studioBusinessPlansDomainSpec,
  type BusinessKey,
  studioBusinessTasksDomainSpec,
  type Empresa,
  type RegistroDePlano,
  type VinculoDeTarefa,
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
    private readonly linkTable: KvTable<BusinessKey, VinculoDeTarefa>,
  ) {}

  businesses = (): readonly Empresa[] => [...this.businessTable.entries()].map(([, valor]) => valor)
  plans = (): readonly RegistroDePlano[] => [...this.planTable.entries()].map(([, valor]) => valor)

  putBusiness = async (value: Empresa): Promise<void> => {
    await this.businessTable.put(value.business_id as BusinessKey, value)
  }

  putPlan = async (value: RegistroDePlano): Promise<void> => {
    await this.planTable.put(value.plan_id as BusinessKey, value)
  }

  links = (): readonly VinculoDeTarefa[] => [...this.linkTable.entries()].map(([, valor]) => valor)

  /*
    A chave é o PROJECT_ID, e não o `link_id`.

    Uma tarefa pertence a no máximo uma empresa, e é a tabela que garante isso:
    com o `link_id` na chave, dois vínculos para o mesmo projeto conviveriam, e
    a pergunta "de quem é esta tarefa?" teria duas respostas.
  */
  putLink = async (value: VinculoDeTarefa): Promise<void> => {
    await this.linkTable.put(value.project_id as BusinessKey, value)
  }
}

export async function apply(ctx: Context): Promise<void> {
  const businesses: Domain<typeof studioBusinessDomainSpec> = await ctx.storageDomain.open(studioBusinessDomainSpec)
  ctx.effect(() => () => businesses.close(), 'studio-business.domainClose')
  const plans: Domain<typeof studioBusinessPlansDomainSpec> = await ctx.storageDomain.open(studioBusinessPlansDomainSpec)
  ctx.effect(() => () => plans.close(), 'studio-business.plansDomainClose')
  const tasks: Domain<typeof studioBusinessTasksDomainSpec> = await ctx.storageDomain.open(studioBusinessTasksDomainSpec)
  ctx.effect(() => () => tasks.close(), 'studio-business.tasksDomainClose')
  const repository = new DomainBusinessRepository(businesses.table('businesses'), plans.table('plans'), tasks.table('links'))
  /*
    A porta de tarefas é resolvida NO MOMENTO DO USO, e não guardada aqui.

    Guardar a referência no `apply` deixaria a criação de tarefa morta para
    qualquer perfil que montasse o `prompt-to-app` depois deste — o mesmo erro
    que já matou o portão T3 uma vez neste repositório. E o serviço trata a
    ausência em palavras, em vez de o Studio inteiro deixar de subir.
  */
  const service = new BusinessService({
    repository,
    tarefas: {
      criar: async (actor, input, requestKey) => {
        const promptToApp = ctx.get('studioPromptToApp')
        if (promptToApp === undefined) throw new Error('studioPromptToApp ausente')
        return promptToApp.service.createProject(actor, input, requestKey)
      },
    },
  })
  const unregister = registerPromptToAppWorkspaceHttpExtension(createBusinessHttpExtension(service))
  ctx.effect(() => unregister, 'studio-business.httpExtension')
  ctx.provide('studioBusiness', { service })
}
