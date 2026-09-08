import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { StudioIdentityRuntime } from '@dz23-studio/identity'
import { registerPromptToAppWorkspaceHttpExtension } from '@dz23-studio/prompt-to-app'
import { createEmergencyStopHttpExtension } from './http.js'
import { t } from './i18n.js'
import {
  studioEmergencyStopDomainSpec,
  type EmergencyStopKey,
  type EmergencyStopRecord,
} from './model.js'
import {
  StudioEmergencyStopService,
  type EmergencyScope,
  type EmergencyStopRepository,
  type StopSurface,
  type StopSurfaceOutcome,
} from './service.js'

export * from './http.js'
export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-emergency-stop'
/**
 * `inject` lista SÓ o que este plugin não sabe viver sem.
 *
 * Os consumidores - prompt-to-app, agentes, integrações - ficam de fora de
 * propósito, e cada um é resolvido com `ctx.get(...)` no momento do uso. Listar
 * um plugin opcional aqui faria o Studio inteiro deixar de subir em qualquer
 * perfil que não o tivesse; guardar a referência no `apply` deixaria o botão
 * morto para tudo que montasse depois. Esse erro já matou o portão T3 uma vez
 * neste repositório, e o botão de emergência é o último lugar onde ele pode
 * voltar.
 */
export const inject = ['storageDomain', 'studioIdentity']

export interface StudioEmergencyStopRuntime {
  readonly service: StudioEmergencyStopService
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioEmergencyStop: StudioEmergencyStopRuntime }
}

class DomainEmergencyStopRepository implements EmergencyStopRepository {
  constructor(private readonly table: KvTable<EmergencyStopKey, EmergencyStopRecord>) {}
  stops(): readonly EmergencyStopRecord[] { return [...this.table.entries()].map(([, value]) => value) }
  putStop(record: EmergencyStopRecord): Promise<void> { return this.table.put(record.scope_id as EmergencyStopKey, record) }
}

/**
 * As partes do Studio que têm trabalho em voo, resolvidas na hora do aperto.
 *
 * Cada uma devolve o que conseguiu interromper E o que não conseguiu provar
 * morto. Um plugin ausente do perfil não é "não consegui": é nada rodando ali,
 * e anunciá-lo como pendência encheria a tela de ruído justamente quando ela
 * precisa ser lida em segundos.
 * @param ctx - o contexto, consultado a cada uso.
 * @returns as superfícies presentes NESTE instante.
 */
export function emergencyStopSurfaces(ctx: Context): readonly StopSurface[] {
  return [
    {
      id: t('surfaces.promptToApp'),
      async cancel(scope: EmergencyScope): Promise<StopSurfaceOutcome> {
        const runtime = ctx.get('studioPromptToApp')
        if (runtime?.jobs === undefined) return { surface: t('surfaces.promptToApp'), cancelled: 0, unproven: [] }
        const outcome = runtime.jobs.cancelScope(scope)
        return { surface: t('surfaces.promptToApp'), cancelled: outcome.requested, unproven: [] }
      },
    },
    {
      id: t('surfaces.agents'),
      async cancel(scope: EmergencyScope): Promise<StopSurfaceOutcome> {
        const runtime = ctx.get('studioAgents')
        if (runtime?.service?.cancelScope === undefined) return { surface: t('surfaces.agents'), cancelled: 0, unproven: [] }
        const outcome = runtime.service.cancelScope(scope)
        return {
          surface: t('surfaces.agents'),
          cancelled: outcome.cancelled,
          // Um `codex` ou um `claude-code` é processo do sistema operacional com
          // vida própria: o Studio pede que ele pare e NÃO consegue provar que
          // parou. Dizer isto na resposta é a única alternativa honesta a
          // fingir que a parada alcançou tudo.
          unproven: outcome.unproven.map((item: { readonly runId: string; readonly provider: string }) => ({ what: item.runId, why: t('surfaces.externalAgent', { provider: item.provider }) })),
        }
      },
    },
    {
      id: t('surfaces.integrations'),
      async cancel(scope: EmergencyScope): Promise<StopSurfaceOutcome> {
        const runtime = ctx.get('studioIntegrationHub')
        if (runtime?.service?.cancelScope === undefined) return { surface: t('surfaces.integrations'), cancelled: 0, unproven: [] }
        const abandoned = runtime.service.cancelScope(scope)
        return {
          surface: t('surfaces.integrations'),
          // Zero de propósito: a desistência foi PEDIDA a cada chamada, e o
          // Studio não fala com o outro lado da rede. Contá-las como canceladas
          // seria a mentira que este campo existe para não contar.
          cancelled: 0,
          unproven: abandoned.map((integrationId: string) => ({ what: integrationId, why: t('surfaces.integrationInFlight') })),
        }
      },
    },
  ]
}

export async function apply(ctx: Context): Promise<void> {
  const domain: Domain<typeof studioEmergencyStopDomainSpec> = await ctx.storageDomain.open(studioEmergencyStopDomainSpec)
  ctx.effect(() => () => domain.close(), 'studio-emergency-stop.domainClose')
  const repository = new DomainEmergencyStopRepository(domain.table('stops'))
  const service = new StudioEmergencyStopService({
    repository,
    identity: {
      strongIdentityVerified(sessionId) {
        return (ctx.studioIdentity as StudioIdentityRuntime).service.strongIdentityForSession(sessionId)
      },
    },
    surfaces: () => emergencyStopSurfaces(ctx),
  })
  const unregister = registerPromptToAppWorkspaceHttpExtension(createEmergencyStopHttpExtension(service))
  ctx.effect(() => unregister, 'studio-emergency-stop.httpExtension')
  ctx.provide('studioEmergencyStop', { service })
}
