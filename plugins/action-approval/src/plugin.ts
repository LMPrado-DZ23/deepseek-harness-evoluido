import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/identity'
import { studioActionApprovalsDomainSpec, type ApprovalKey } from './domain.js'
import { assertValidApproval, type ApprovalRecord } from './model.js'
import { ApprovalConflictError, type ActionApprovalRepository } from './repository.js'
import { StudioActionApprovalService, type ApprovalStrongIdentityPort } from './service.js'

export const name = 'dz23-studio-action-approval'
export const inject = ['storageDomain', 'studioIdentity']

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

  async get(approvalId: string): Promise<ApprovalRecord | undefined> {
    const row = await this.table.get(approvalId as ApprovalKey)
    if (row === undefined) return undefined
    // Uma linha corrompida é recusada na leitura: corrupção não pode virar
    // uma aprovação silenciosa.
    assertValidApproval(row)
    return row
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
  /** Prazo de vida do pedido de confirmação, em milissegundos. */
  readonly ttlMs?: number
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
    repository: new DomainActionApprovalRepository(domain.table('approvals')),
    identity,
    ...(config.ttlMs === undefined ? {} : { ttlMs: config.ttlMs }),
  })
  ctx.provide('studioActionApproval', { service })
}
