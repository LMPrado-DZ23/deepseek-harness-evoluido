import {
  ActionApprovalError,
  type ApprovalActor,
  type ApprovalReceipt,
  type StudioActionApprovalService,
} from '@dz23-studio/action-approval'
import { stagingApprovalReceiptSchema, type StagingApprovalReceipt } from './model.js'
import type { StagingActor, StagingApprovalPort } from './service.js'

/**
 * Adapta a autoridade genérica de confirmação para o contrato do staging.
 * A direção da dependência é esta e só esta: `action-approval` não conhece
 * staging, e nunca vai conhecer.
 */
export class StagingActionApprovalAdapter implements StagingApprovalPort {
  constructor(private readonly approvals: Pick<StudioActionApprovalService, 'consume'>) {}

  async consume(input: {
    readonly actor: StagingActor
    readonly approvalId: string
    readonly tier: 'T2'
    readonly action: 'staging.publish' | 'staging.rollback'
    readonly subjectId: string
    readonly fingerprint: string
    readonly releaseId: string
  }): Promise<
    | { readonly kind: 'approved'; readonly receipt: StagingApprovalReceipt }
    | { readonly kind: 'definitive-denied' }
  > {
    let receipt: ApprovalReceipt
    try {
      receipt = await this.approvals.consume({
        actor: actorOf(input.actor),
        approvalId: input.approvalId,
        // A liberação de UM release é a reivindicação: uma confirmação vale
        // por um release, e repetir o mesmo release devolve o mesmo recibo.
        claimId: input.releaseId,
        action: input.action,
        subjectId: input.subjectId,
        fingerprint: input.fingerprint,
        tier: input.tier,
      })
    } catch (error) {
      // Só a recusa explícita da pessoa é definitiva. Expirado, já consumido,
      // não encontrado ou falha de armazenamento sobem como erro para o
      // StagingService decidir - jamais viram "negado" inventado.
      if (error instanceof ActionApprovalError && error.code === 'DENIED') {
        return { kind: 'definitive-denied' }
      }
      throw error
    }
    return { kind: 'approved', receipt: sanitizeForStaging(receipt) }
  }
}

function actorOf(actor: StagingActor): ApprovalActor {
  return {
    userId: actor.userId, orgId: actor.orgId, tenantId: actor.tenantId, sessionId: actor.sessionId,
  }
}

/**
 * `stagingApprovalReceiptSchema` é estrito: campos a mais fazem o recibo ser
 * recusado. O recibo genérico carrega `tier` e `claim_id`, que não existem
 * naquele contrato, então a projeção é explícita - e o `parse` prova que só
 * o que o staging declara atravessa.
 */
export function sanitizeForStaging(receipt: ApprovalReceipt): StagingApprovalReceipt {
  return stagingApprovalReceiptSchema.parse({
    approval_id: receipt.approval_id,
    action: receipt.action,
    subject_id: receipt.subject_id,
    fingerprint: receipt.fingerprint,
    user_id: receipt.user_id,
    session_id: receipt.session_id,
    org_id: receipt.org_id,
    tenant_id: receipt.tenant_id,
    approved_at: receipt.approved_at,
  })
}
