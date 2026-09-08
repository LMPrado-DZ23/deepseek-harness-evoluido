import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-user-approval'
import { principalForAgent, type AgentLineageNode, type AgentLookup } from '@dz23-studio/identity'
import { randomUUID } from 'node:crypto'
import { answerHarnessApproval } from './answerer.js'
import { studioActionApprovalsDomainSpec, type ApprovalKey } from './domain.js'
import { assertValidApproval, type ApprovalRecord } from './model.js'
import { ApprovalConflictError, inScope, type ActionApprovalRepository, type ApprovalTenantScope } from './repository.js'
import { APPROVAL_TTL_MS, StudioActionApprovalService, type ApprovalStrongIdentityPort } from './service.js'
import { TenantRecordActionApprovalRepository, type ApprovalTenantRecordStore } from './tenant-repository.js'

export const name = 'dz23-studio-action-approval'
export const inject = ['agents', 'storageDomain', 'studioIdentity']

export interface StudioActionApprovalRuntime {
  readonly service: StudioActionApprovalService
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioActionApproval: StudioActionApprovalRuntime
  }
}

/**
 * Persistência durável sobre o seam real de domínio. O seam oferece apenas
 * `put(chave, valor)`: NÃO existe escrita condicional. Por isso o estado
 * esperado é conferido aqui, sob o mutex do serviço, e uma divergência vira
 * conflito - nunca uma sobrescrita silenciosa de uma confirmação alheia.
 */
export class DomainActionApprovalRepository implements ActionApprovalRepository {
  constructor(private readonly table: KvTable<ApprovalKey, ApprovalRecord>) {}

  async get(scope: ApprovalTenantScope, approvalId: string): Promise<ApprovalRecord | undefined> {
    const row = await this.table.get(approvalId as ApprovalKey)
    if (row === undefined) return undefined
    // Fora do escopo é o MESMO "não existe" de um id inventado: a chave-valor
    // não separa inquilinos, então a separação é feita aqui.
    if (row.org_id !== scope.orgId || row.tenant_id !== scope.tenantId) return undefined
    // Uma linha corrompida é recusada na leitura: corrupção não pode virar
    // uma aprovação silenciosa.
    assertValidApproval(row)
    return row
  }

  async listForActor(scope: {
    readonly userId: string
    readonly orgId: string
    readonly tenantId: string
    readonly sessionId: string
  }): Promise<readonly ApprovalRecord[]> {
    const rows: ApprovalRecord[] = []
    for (const [, row] of this.table.entries()) {
      if (!inScope(row, scope)) continue
      // Uma linha corrompida recusa a listagem inteira: melhor a pessoa ver um
      // erro do que uma lista que silenciosamente esconde um pedido.
      assertValidApproval(row)
      rows.push(row)
    }
    return await Promise.resolve(rows)
  }

  async put(record: ApprovalRecord, expectedState: ApprovalRecord['state'] | 'new'): Promise<void> {
    assertValidApproval(record)
    const current = await this.table.get(record.approval_id as ApprovalKey)
    if (expectedState === 'new') {
      if (current !== undefined) throw new ApprovalConflictError('approval already exists')
    } else if (current === undefined || current.state !== expectedState) {
      throw new ApprovalConflictError('approval state moved under the write')
    }
    await this.table.put(record.approval_id as ApprovalKey, record)
  }
}

export interface Config {
  /**
   * Onde a autoridade das confirmações GUARDA os pedidos.
   *
   * `kv` é o armazenamento por chave-valor opaco, e continua sendo o padrão:
   * é o que toda instalação existente já usa, e trocar isso sozinho migraria
   * dados de gente sem ninguém pedir. `rls` usa a tabela por inquilino com
   * isolamento por linha, e exige que `storage-postgres` esteja montado com a
   * segunda credencial (`tenantRuntimeDsnRef`).
   *
   * Trocar para `rls` NÃO copia nada: o backfill é um passo explícito,
   * verificado, com rollback — `scripts/migrate-approvals-to-rls.ts`. Ligar a
   * chave sem migrar faria a tela ficar vazia e os pedidos antigos sumirem de
   * vista, que é o pior desfecho possível para uma autoridade de confirmação.
   */
  readonly storageAuthority?: 'kv' | 'rls'
  /** Prazo de vida do pedido de confirmação, em milissegundos. */
  readonly ttlMs?: number
  /**
   * Responder às perguntas de permissão do Harness com a autoridade do Studio.
   * Desligado, o seam do Harness continua caindo no `'unavailable'` fechado.
   */
  readonly answerHarnessApprovals?: boolean
  /** Nível exigido para uma pergunta do Harness. Escalada de permissão é T3. */
  readonly harnessTier?: 'T2' | 'T3'
  /** De quanto em quanto tempo reler a decisão da pessoa. */
  readonly harnessPollIntervalMs?: number
  /** Quanto tempo o Harness espera antes de fechar por falta de resposta. */
  readonly harnessMaxWaitMs?: number
}

/** Espera cancelável usada pelo respondedor; `false` quando foi interrompida. */
function cancellableWait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const domain: Domain<typeof studioActionApprovalsDomainSpec> = await ctx.storageDomain.open(studioActionApprovalsDomainSpec)
  ctx.effect(() => async () => { await domain.close() }, 'dz23-studio-action-approval.domainClose')

  const identity: ApprovalStrongIdentityPort = {
    // Falha fechada por construção: sem chave de acesso recente NA MESMA
    // sessão, `confirm` de um pedido T3 recusa.
    strongIdentityVerified: sessionId => ctx.studioIdentity.service.strongIdentityForSession(sessionId),
  }
  const service = new StudioActionApprovalService({
    repository: approvalRepository(ctx, config, domain),
    identity,
    ...(config.ttlMs === undefined ? {} : { ttlMs: config.ttlMs }),
  })
  ctx.provide('studioActionApproval', { service })

  if (config.answerHarnessApprovals !== true) return
  type RegistrySessionId = Parameters<typeof ctx.agents.get>[0]
  const agentLookup: AgentLookup = {
    getBySessionId: sessionId => ctx.agents.get(sessionId as RegistrySessionId),
  }
  const tier = config.harnessTier ?? 'T3'
  const pollIntervalMs = config.harnessPollIntervalMs ?? 1_000
  const maxWaitMs = config.harnessMaxWaitMs ?? (config.ttlMs ?? APPROVAL_TTL_MS)
  ctx.effect(() => ctx.on('approval/request', (req, next) => answerHarnessApproval({
    toolName: req.toolName,
    ...(req.callId === undefined ? {} : { callId: String(req.callId) }),
    ...(req.reason === undefined ? {} : { reason: req.reason }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  }, next, {
    authority: service,
    // A identidade sai da linhagem durável do agente, nunca do que o modelo diz.
    actor: principalForAgent(ctx.studioIdentity.service, agentLookup, req.agent as unknown as AgentLineageNode),
    tier,
    // O Harness não dá um identificador à pergunta: cada pergunta abre o SEU
    // pedido, e uma confirmação nunca vale para a próxima.
    questionId: `harness-${randomUUID()}`,
    pollIntervalMs,
    maxWaitMs,
    wait: ms => cancellableWait(ms, req.signal),
    now: () => Date.now(),
  })), 'dz23-studio-action-approval.harnessAnswerer')
}

/**
 * Escolhe onde os pedidos são guardados.
 *
 * Falha ALTO quando `rls` é pedido e o armazenamento por inquilino não está
 * montado. Cair de volta para a chave-valor em silêncio seria o pior desfecho:
 * quem pediu RLS acharia que tem isolamento no banco, e a instalação
 * continuaria escrevendo na unidade opaca — com os dois lados divergindo desde
 * o primeiro pedido.
 * @param ctx - o contexto, consultado no momento da montagem.
 * @param config - a configuração do plugin.
 * @param domain - o domínio chave-valor já aberto.
 * @returns o repositório da autoridade.
 */
export function approvalRepository(
  ctx: Pick<Context, 'get'>,
  config: Config,
  domain: Domain<typeof studioActionApprovalsDomainSpec>,
): ActionApprovalRepository {
  if ((config.storageAuthority ?? 'kv') === 'kv') {
    return new DomainActionApprovalRepository(domain.table('approvals'))
  }
  const records = ctx.get('studioTenantStorage')?.records as ApprovalTenantRecordStore | undefined
  if (records === undefined) throw new Error('APPROVAL_TENANT_STORAGE_UNAVAILABLE')
  return new TenantRecordActionApprovalRepository(records)
}
