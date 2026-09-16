import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/identity'
import type {} from '@dz23-studio/tenancy'
import { missionBudgetPort, missionNoteRun } from './budget-port.js'
import { createMissionHttpHandler } from './http.js'
import { missionKey, studioMissionsDomainSpec, type MissionKey, type MissionRecord } from './model.js'
import { TenantRecordMissionRepository, type MissionTenantRecordStore } from './tenant-repository.js'
import { StudioMissionService, type MissionRepository, type MissionScope } from './service.js'

export * from './price-table.js'
export * from './budget-port.js'
export * from './tenant-repository.js'
export * from './http.js'
export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-mission'
/**
 * `studioAgentTeams` é injetado porque a DEPENDÊNCIA É INVERTIDA: quem sabe o
 * que é uma missão é este plugin, e é ele que se apresenta ao serviço de
 * equipes. O caminho oposto — `agent-team` injetar `studioMission` — exigiria
 * injeção opcional, que esta versão do cordis não tem; torná-la obrigatória
 * faria toda instalação sem motor de missão deixar de carregar equipes, que é
 * o oposto do que se quer.
 */
export const inject = ['storageDomain', 'studioAgentTeams', 'studioAgents', 'studioIdentity', 'studioTenancy', 'webServer']

export interface StudioMissionRuntime {
  readonly service: StudioMissionService
  missions(scope: MissionScope): Promise<readonly MissionRecord[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioMission: StudioMissionRuntime
  }
}

/**
 * As missões na chave-valor do seam de domínio.
 *
 * Continua existindo porque nem toda instalação monta o armazenamento por
 * inquilino. O que ela NÃO tem é gravação condicional durável: a condição é
 * conferida neste processo, e com réplicas duas leituras concorrentes veem a
 * mesma revisão. A fila do serviço fecha o caso de instância única, e a
 * diferença está dita em vez de escondida.
 */
export class DomainMissionRepository implements MissionRepository {
  constructor(private readonly table: KvTable<MissionKey, MissionRecord>) {}

  async missions(scope: MissionScope) {
    // O filtro é DESTE processo aqui, ao contrário do caminho com RLS: a tabela
    // é um mapa plano e não sabe de escopo.
    return [...this.table.entries()]
      .map(([, value]) => value)
      .filter(record => record.org_id === scope.orgId && record.tenant_id === scope.tenantId)
  }

  // A chave leva o ESCOPO. Ver `missionKey`: a tabela e um mapa plano, e
  // chavear so pelo `mission_id` deixava uma organizacao apagar a de outra.
  async putMission(record: MissionRecord, expected: 'new' | number) {
    const key = missionKey(record.org_id, record.tenant_id, record.mission_id)
    const current = this.table.get(key)
    if (expected === 'new') {
      if (current !== undefined) return false
    } else if (current === undefined || current.revision !== expected) {
      return false
    }
    await this.table.put(key, record)
    return true
  }
}

export interface Config {
  /**
   * Onde as missões são guardadas.
   *
   * `kv` é o armazenamento por chave-valor, e continua sendo o padrão: trocar
   * isso sozinho migraria dados de gente sem ninguém pedir. `rls` usa a tabela
   * por inquilino com isolamento por linha, e exige `storage-postgres` montado
   * com a segunda credencial.
   *
   * Trocar a chave NÃO copia nada. `studio_missions` é novo e ainda não tem
   * dado de ninguém, então aqui a troca é barata — mas dizer isso e deixar a
   * troca copiar dados em silêncio são coisas diferentes, e esta é a segunda.
   */
  readonly storageAuthority?: 'kv' | 'rls'
}

/**
 * Escolhe onde as missões moram.
 *
 * Falha ALTO quando `rls` é pedido e o armazenamento por inquilino não está
 * montado. Cair de volta para a chave-valor em silêncio seria o pior desfecho:
 * quem pediu isolamento no banco acharia que o tem, e a instalação continuaria
 * escrevendo na unidade opaca.
 * @param ctx - o contexto, consultado na montagem.
 * @param config - a configuração do plugin.
 * @param domain - o domínio chave-valor já aberto.
 * @returns o repositório.
 */
export function missionRepository(
  ctx: Pick<Context, 'get'>,
  config: Config,
  domain: Domain<typeof studioMissionsDomainSpec>,
): MissionRepository {
  if ((config.storageAuthority ?? 'kv') === 'kv') {
    return new DomainMissionRepository(domain.table('missions'))
  }
  const records = ctx.get('studioTenantStorage')?.records as MissionTenantRecordStore | undefined
  if (records === undefined) throw new Error('MISSION_TENANT_STORAGE_UNAVAILABLE')
  return new TenantRecordMissionRepository(records)
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const domain: Domain<typeof studioMissionsDomainSpec> = await ctx.storageDomain.open(studioMissionsDomainSpec)
  ctx.effect(() => async () => { await domain.close() }, 'studio-mission.domainClose')
  const repository = missionRepository(ctx, config, domain)
  const service = new StudioMissionService({ repository })

  ctx.studioAgentTeams.service.setMissionBudget(missionBudgetPort(
    repository,
    () => ctx.studioAgents.runs(),
    missionNoteRun(repository, service, () => ctx.studioAgents.runs()),
  ))

  ctx.provide('studioMission', { service, missions: async scope => repository.missions(scope) })

  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${String(port)}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/studio/missions',
    handler: createMissionHttpHandler({
      service,
      identity: ctx.studioIdentity.service,
      tenancy: ctx.studioTenancy.service,
      allowedHosts: [defaultHost, `localhost:${String(port)}`],
      allowedOrigins: [`http://localhost:${String(port)}`, `http://${defaultHost}`],
      runs: () => ctx.studioAgents.runs(),
    }),
  }), 'dz23-studio-mission.http')
}
