import { createHash } from 'node:crypto'
import { t } from './i18n.js'
import {
  approvalDescriptorSchema,
  approvalReceiptSchema,
  type ApprovalDescriptor,
  type ApprovalReceipt,
  type ApprovalRecord,
  type ApprovalTier,
} from './model.js'
import { ApprovalConflictError, type ActionApprovalRepository } from './repository.js'

/** Prazo de vida de um pedido de confirmação. */
export const APPROVAL_TTL_MS = 3 * 60 * 1000

export class ActionApprovalError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'EXPIRED' | 'DENIED' | 'CONSUMED' | 'STRONG_IDENTITY_REQUIRED',
    message: string,
  ) {
    super(message)
  }
}

export interface ApprovalActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly sessionId: string
}

export interface ApprovalStrongIdentityPort {
  /** T3 exige passkey recente NA MESMA sessão. Ausência falha fechada. */
  strongIdentityVerified(sessionId: string): boolean
}

export interface ActionApprovalServiceOptions {
  readonly repository: ActionApprovalRepository
  readonly identity: ApprovalStrongIdentityPort
  readonly now?: () => Date
  readonly ttlMs?: number
}

/**
 * Identidade determinística do pedido: mesmo escopo + mesmo `request_id` dá
 * sempre o mesmo id. É o que torna o pedido idempotente sem inventar um
 * segundo identificador que o cliente pudesse escolher.
 */
export function approvalId(descriptor: Pick<ApprovalDescriptor, 'org_id' | 'tenant_id' | 'user_id' | 'session_id' | 'request_id'>): string {
  const canonical = [
    descriptor.org_id, descriptor.tenant_id, descriptor.user_id, descriptor.session_id, descriptor.request_id,
  ].map(value => `${String(value.length)}:${value}`).join('|')
  return `apv-${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/**
 * Autoridade genérica de confirmação de ações sensíveis. Ela não conhece
 * staging, nem integrações, nem nenhuma fatia específica: quem sabe o que está
 * sendo confirmado é o serviço interno que deriva o descritor.
 */
export class StudioActionApprovalService {
  readonly #ttlMs: number

  constructor(private readonly options: ActionApprovalServiceOptions) {
    this.#ttlMs = options.ttlMs ?? APPROVAL_TTL_MS
  }

  /**
   * Chamado por um serviço interno confiável, nunca por rota pública. Repetir o
   * mesmo pedido é idempotente; reusar o `request_id` com descritor diferente é
   * conflito, não sobrescrita.
   */
  async request(input: ApprovalDescriptor): Promise<ApprovalRecord> {
    const descriptor = this.#parseDescriptor(input)
    const id = approvalId(descriptor)
    const existing = await this.options.repository.get(id)
    if (existing !== undefined) {
      if (!sameDescriptor(existing, descriptor)) {
        throw new ActionApprovalError('CONFLICT', t('errors.descriptorConflict'))
      }
      return existing
    }
    const createdAt = this.#now()
    const record: ApprovalRecord = {
      ...descriptor,
      approval_id: id,
      state: 'PENDING',
      claim_id: null,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + this.#ttlMs).toISOString(),
      confirmed_at: null,
      consumed_at: null,
      denied_at: null,
    }
    try {
      await this.options.repository.put(record, 'new')
    } catch (error) {
      if (!(error instanceof ApprovalConflictError)) throw error
      // Alguém criou o mesmo pedido entre a leitura e a escrita: o vencedor vale.
      const winner = await this.options.repository.get(id)
      if (winner === undefined || !sameDescriptor(winner, descriptor)) {
        throw new ActionApprovalError('CONFLICT', t('errors.descriptorConflict'))
      }
      return winner
    }
    return record
  }

  /** A pessoa confirma. É a única coisa que o cliente pode fazer, junto com negar. */
  async confirm(actor: ApprovalActor, id: string): Promise<ApprovalRecord> {
    const record = await this.#owned(actor, id)
    if (record.state !== 'PENDING') throw this.#resolved(record)
    if (record.tier === 'T3' && !this.options.identity.strongIdentityVerified(actor.sessionId)) {
      // Falha fechada e NÃO consome o pedido: a pessoa pode confirmar de novo
      // depois de usar a chave de acesso.
      throw new ActionApprovalError('STRONG_IDENTITY_REQUIRED', t('errors.strongIdentity'))
    }
    const confirmedAt = this.#now().toISOString()
    const next: ApprovalRecord = { ...record, state: 'AVAILABLE', confirmed_at: confirmedAt }
    await this.#write(next, 'PENDING')
    return next
  }

  async deny(actor: ApprovalActor, id: string): Promise<ApprovalRecord> {
    const record = await this.#owned(actor, id)
    if (record.state === 'DENIED') return record
    if (record.state !== 'PENDING' && record.state !== 'AVAILABLE') throw this.#resolved(record)
    const next: ApprovalRecord = { ...record, state: 'DENIED', denied_at: this.#now().toISOString() }
    await this.#write(next, record.state)
    return next
  }

  /**
   * Consumo durável e idempotente por `approval_id + claim_id + fingerprint`.
   * Repetir exatamente devolve o mesmo recibo, inclusive depois de reiniciar o
   * processo. Qualquer divergência recusa - fechado, nunca aberto.
   */
  async consume(input: {
    readonly actor: ApprovalActor
    readonly approvalId: string
    readonly claimId: string
    readonly action: string
    readonly subjectId: string
    readonly fingerprint: string
    readonly tier: ApprovalTier
  }): Promise<ApprovalReceipt> {
    const record = await this.#owned(input.actor, input.approvalId)
    const matches = record.action === input.action
      && record.subject_id === input.subjectId
      && record.fingerprint === input.fingerprint
      && record.tier === input.tier
    if (!matches) throw new ActionApprovalError('FORBIDDEN', t('errors.claimMismatch'))

    if (record.state === 'CONSUMED') {
      // Replay exato: mesmo recibo. Reivindicação diferente sobre a mesma
      // confirmação é recusada - uma confirmação vale por uma ação.
      if (record.claim_id !== input.claimId) throw new ActionApprovalError('CONSUMED', t('errors.consumed'))
      return this.#receipt(record)
    }
    if (record.state === 'DENIED') throw new ActionApprovalError('DENIED', t('errors.denied'))
    if (record.state === 'EXPIRED') throw new ActionApprovalError('EXPIRED', t('errors.expired'))
    if (record.state === 'PENDING') throw new ActionApprovalError('FORBIDDEN', t('errors.notPending'))
    // Não há checagem de expiração aqui: `#owned` já expirou o que estava
    // vencido antes de chegar neste ponto. Repetir seria código morto - e
    // código morto num caminho de segurança é onde um erro se esconde.

    const next: ApprovalRecord = {
      ...record, state: 'CONSUMED', claim_id: input.claimId, consumed_at: this.#now().toISOString(),
    }
    try {
      await this.#write(next, 'AVAILABLE')
    } catch (error) {
      if (!(error instanceof ApprovalConflictError)) throw error
      // Dois consumos concorrentes: só um escreve. O outro lê o vencedor e só
      // recebe recibo se for exatamente a mesma reivindicação.
      const winner = await this.options.repository.get(record.approval_id)
      if (winner === undefined || winner.state !== 'CONSUMED' || winner.claim_id !== input.claimId) {
        throw new ActionApprovalError('CONSUMED', t('errors.consumed'))
      }
      return this.#receipt(winner)
    }
    return this.#receipt(next)
  }

  async get(actor: ApprovalActor, id: string): Promise<ApprovalRecord> {
    return this.#owned(actor, id)
  }

  #receipt(record: ApprovalRecord): ApprovalReceipt {
    return approvalReceiptSchema.parse({
      approval_id: record.approval_id,
      action: record.action,
      subject_id: record.subject_id,
      fingerprint: record.fingerprint,
      tier: record.tier,
      claim_id: record.claim_id,
      user_id: record.user_id,
      session_id: record.session_id,
      org_id: record.org_id,
      tenant_id: record.tenant_id,
      approved_at: record.confirmed_at,
    })
  }

  /**
   * Escopo é tudo: outra pessoa, outra sessão, outra organização ou outro
   * inquilino recebem exatamente o mesmo "não existe" de um id inventado. Nada
   * na resposta revela que o pedido existe para outra pessoa.
   */
  async #owned(actor: ApprovalActor, id: string): Promise<ApprovalRecord> {
    const record = await this.options.repository.get(id)
    if (record === undefined
      || record.user_id !== actor.userId
      || record.session_id !== actor.sessionId
      || record.org_id !== actor.orgId
      || record.tenant_id !== actor.tenantId) {
      throw new ActionApprovalError('NOT_FOUND', t('errors.unknownApproval'))
    }
    if (record.state === 'PENDING' || record.state === 'AVAILABLE') {
      if (this.#isExpired(record)) throw await this.#expire(record)
    }
    return record
  }

  async #expire(record: ApprovalRecord): Promise<ActionApprovalError> {
    const expired: ApprovalRecord = { ...record, state: 'EXPIRED' }
    try {
      await this.#write(expired, record.state)
    } catch (error) {
      if (!(error instanceof ApprovalConflictError)) throw error
    }
    return new ActionApprovalError('EXPIRED', t('errors.expired'))
  }

  #resolved(record: ApprovalRecord): ActionApprovalError {
    if (record.state === 'DENIED') return new ActionApprovalError('DENIED', t('errors.denied'))
    if (record.state === 'CONSUMED') return new ActionApprovalError('CONSUMED', t('errors.consumed'))
    if (record.state === 'EXPIRED') return new ActionApprovalError('EXPIRED', t('errors.expired'))
    return new ActionApprovalError('CONFLICT', t('errors.notPending'))
  }

  #isExpired(record: ApprovalRecord): boolean {
    return this.#now().getTime() >= Date.parse(record.expires_at)
  }

  async #write(record: ApprovalRecord, expected: ApprovalRecord['state']): Promise<void> {
    await this.options.repository.put(record, expected)
  }

  #parseDescriptor(input: ApprovalDescriptor): ApprovalDescriptor {
    const parsed = approvalDescriptorSchema.safeParse(input)
    if (!parsed.success) throw new ActionApprovalError('INVALID_REQUEST', t('errors.invalidRequest'))
    return parsed.data
  }

  #now(): Date {
    return this.options.now?.() ?? new Date()
  }
}

function sameDescriptor(record: ApprovalRecord, descriptor: ApprovalDescriptor): boolean {
  return record.org_id === descriptor.org_id
    && record.tenant_id === descriptor.tenant_id
    && record.user_id === descriptor.user_id
    && record.session_id === descriptor.session_id
    && record.action === descriptor.action
    && record.subject_id === descriptor.subject_id
    && record.fingerprint === descriptor.fingerprint
    && record.tier === descriptor.tier
    && record.request_id === descriptor.request_id
}
