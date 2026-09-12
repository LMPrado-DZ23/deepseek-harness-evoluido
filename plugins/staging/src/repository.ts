import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { stagingReleaseSchema, type StagingRelease } from './model.js'
import type { StagingKey } from './domain.js'
import type { StagingActor, StagingRepository } from './service.js'

/**
 * O journal de staging guardado de verdade.
 *
 * O `StagingRepository` pede cinco garantias atômicas (reservar o destino e
 * alocar uma geração estritamente crescente; CAS das transições com fencing do
 * lease; comparar o release ativo antes de um rollback; finalizar o recibo e
 * trocar o ponteiro ativo na mesma transação; colocar o destino em quarentena
 * sem substituir o dono de uma geração mais nova). Até aqui só existia a
 * implementação em memória das provas — e a ADR-038 registra que era isso que
 * faltava antes de qualquer montagem.
 *
 * ## Onde mora o estado do DESTINO
 *
 * Geração atual, release ativo, ocupação e quarentena NÃO ganham uma segunda
 * tabela. Eles são DERIVADOS do próprio journal ao abrir, e mantidos em memória
 * depois. O motivo é que uma segunda tabela pode discordar da primeira: bastaria
 * uma escrita chegar e a outra não para a geração dizer 7 enquanto o journal
 * mostra 8, e a partir daí a exclusão por destino perde o sentido. O journal é a
 * verdade durável; o resto é leitura dele.
 *
 * ## O que isto garante, e o que NÃO garante
 *
 * As cinco operações são serializadas por uma fila neste objeto, e as escritas
 * passam pela cadeia de escrita única do domínio. Isso vale porque o Studio é
 * ESCRITOR ÚNICO da unidade: o backend Postgres mantém uma conexão dedicada com
 * `pg_try_advisory_lock` por unidade aberta, então uma segunda instância não
 * consegue abrir o mesmo domínio. NÃO é transação distribuída, e não vira
 * ativo-ativo. Está declarado aqui porque a diferença é fácil de confundir com
 * uma garantia que não existe.
 */

const TERMINAL: ReadonlySet<string> = new Set(['FAILED', 'STAGING_OK', 'ROLLED_BACK'])

/** O estado de um destino físico, derivado do journal. */
interface TargetState {
  lastGeneration: number
  activeReleaseId?: string
  activeGeneration?: number
  busyReleaseId?: string
  ownerScope?: string
  quarantined: boolean
}

function scopeOf(actor: StagingActor, projectId: string): string {
  return JSON.stringify([actor.orgId, actor.tenantId, projectId])
}

function recordScope(record: StagingRelease): string {
  return JSON.stringify([record.org_id, record.tenant_id, record.project_id])
}

/**
 * Reconstrói o estado de cada destino a partir do journal.
 *
 * É esta função que faz o reinício ser seguro: depois de uma queda, a geração
 * continua de onde parou e um destino ocupado continua ocupado, porque as duas
 * coisas estão escritas nos próprios registros.
 * @param releases - todos os registros do journal.
 * @returns o estado por `target_key`.
 */
export function deriveTargets(releases: readonly StagingRelease[]): Map<string, TargetState> {
  const targets = new Map<string, TargetState>()
  // Ordenado por geração: a leitura da chave-valor não tem ordem garantida, e
  // é esta ordenação - não um `Math.max` a mais - que faz a última geração, o
  // release ativo e o dono do destino saírem certos.
  const ordered = [...releases].sort((left, right) => left.target_generation - right.target_generation)
  for (const record of ordered) {
    const target = targets.get(record.target_key) ?? { lastGeneration: 0, quarantined: false }
    target.lastGeneration = record.target_generation
    target.ownerScope ??= recordScope(record)
    if (record.state === 'STAGING_OK' || record.state === 'ROLLED_BACK') {
      target.activeReleaseId = record.release_id
      target.activeGeneration = record.target_generation
    }
    // Um release não-terminal deixa o destino OCUPADO. Depois de uma queda é
    // isso que impede uma segunda publicação de começar por cima de um efeito
    // que ninguém sabe se aconteceu.
    if (!TERMINAL.has(record.state)) target.busyReleaseId = record.release_id
    if (record.state === 'RECONCILIATION_REQUIRED') target.quarantined = true
    targets.set(record.target_key, target)
  }
  return targets
}

export class DomainStagingRepository implements StagingRepository {
  readonly #records = new Map<string, StagingRelease>()
  readonly #targets: Map<string, TargetState>
  #tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly table: KvTable<StagingKey, StagingRelease>) {
    for (const [, value] of table.entries()) this.#records.set(value.release_id, value)
    this.#targets = deriveTargets([...this.#records.values()])
  }

  releases(actor: StagingActor, projectId: string): readonly StagingRelease[] {
    const key = scopeOf(actor, projectId)
    return [...this.#records.values()].filter(record => recordScope(record) === key)
  }

  release(actor: StagingActor, projectId: string, releaseId: string): StagingRelease | undefined {
    return this.releases(actor, projectId).find(record => record.release_id === releaseId)
  }

  releaseByOperation(actor: StagingActor, projectId: string, operationId: string): StagingRelease | undefined {
    return this.releases(actor, projectId).find(record => record.operation_id === operationId)
  }

  reserveRelease(record: StagingRelease): Promise<
    | { readonly kind: 'reserved', readonly release: StagingRelease }
    | { readonly kind: 'replay', readonly release: StagingRelease }
    | { readonly kind: 'target-busy' }
    | { readonly kind: 'active-conflict' }
  > {
    return this.#exclusive(async () => {
      const replay = [...this.#records.values()].find(candidate => recordScope(candidate) === recordScope(record)
        && (candidate.release_id === record.release_id || candidate.operation_id === record.operation_id))
      if (replay !== undefined) return { kind: 'replay' as const, release: structuredClone(replay) }
      const target = this.#targets.get(record.target_key) ?? { lastGeneration: 0, quarantined: false }
      if (target.quarantined || target.busyReleaseId !== undefined) return { kind: 'target-busy' as const }
      // O destino FÍSICO fica preso ao primeiro escopo que o reservou: duas
      // organizações não podem comandar o mesmo alvo, nem em sequência.
      if (target.ownerScope !== undefined && target.ownerScope !== recordScope(record)) return { kind: 'active-conflict' as const }
      if (record.kind === 'ROLLBACK' && (target.activeReleaseId !== record.rollback_from_release_id
        || target.activeGeneration !== record.rollback_from_generation)) return { kind: 'active-conflict' as const }
      // A geração é alocada AQUI, e não pelo serviço: ela precisa ser
      // estritamente crescente por destino, e quem sabe qual foi a última é o
      // journal.
      const release = stagingReleaseSchema.parse({ ...record, target_generation: target.lastGeneration + 1 })
      await this.#persist(release)
      this.#targets.set(record.target_key, {
        ...target,
        lastGeneration: release.target_generation,
        busyReleaseId: release.release_id,
        ownerScope: target.ownerScope ?? recordScope(record),
      })
      return { kind: 'reserved' as const, release: structuredClone(release) }
    })
  }

  claimExpiredLease(
    actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number,
    leaseId: string, leaseExpiresAt: string, now: string,
  ): Promise<StagingRelease | undefined> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      const target = current === undefined ? undefined : this.#targets.get(current.target_key)
      // `APPROVAL_PENDING` e só: retomar um lease depois de o efeito externo ter
      // começado seria dar um novo dono a um trabalho em voo.
      if (current === undefined || current.version !== expectedVersion || current.state !== 'APPROVAL_PENDING'
        || current.effect_lease_expires_at > now || target?.busyReleaseId !== releaseId || target.quarantined) return undefined
      const claimed = stagingReleaseSchema.parse({
        ...current, effect_lease_id: leaseId, effect_lease_expires_at: leaseExpiresAt,
        last_transition_at: now, version: current.version + 1,
      })
      await this.#persist(claimed)
      return structuredClone(claimed)
    })
  }

  compareAndSwapRelease(
    actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, record: StagingRelease,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      const target = current === undefined ? undefined : this.#targets.get(current.target_key)
      if (current === undefined || current.version !== expectedVersion || target?.busyReleaseId !== releaseId
        || target.quarantined || record.target_generation !== current.target_generation
        // O lease é o token de fencing: uma escrita com lease velho é de um dono
        // que já perdeu a vez.
        || record.effect_lease_id !== current.effect_lease_id) return false
      await this.#persist(record)
      if (record.state === 'FAILED' && target !== undefined) {
        const { busyReleaseId: _released, ...idle } = target
        this.#targets.set(record.target_key, idle)
      }
      return true
    })
  }

  finalizeAccepted(
    actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, record: StagingRelease,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      const target = current === undefined ? undefined : this.#targets.get(current.target_key)
      // A QUARENTENA TEM SAÍDA, e ela é esta.
      //
      // A regra anterior recusava toda finalização com o destino em
      // quarentena — inclusive a RECONCILIAÇÃO, que é o único trabalho que
      // existe para tirá-lo de lá. O efeito era um beco sem volta: `reconcile`
      // tentava três vezes, era recusado nas três, e terminava chamando
      // `quarantineTarget` de novo. E como o destino é um só para o Studio
      // inteiro (`stagingTargetKey` não leva organização, inquilino nem
      // projeto — decisão registrada), uma única release travada inutilizava o
      // staging de TODOS, para sempre, sem rota de recuperação.
      //
      // Quarentena que ninguém consegue sair não é quarentena, é lápide.
      //
      // O que continua fechado: só a release que É a dona do destino
      // (`busyReleaseId`) sai, e só com um registro de RECONCILIAÇÃO
      // (`reconciled_at`), na mesma geração e sob o mesmo arrendamento. Trabalho
      // NOVO segue recusado enquanto a quarentena durar — que é o que ela existe
      // para fazer.
      const resolvingQuarantine = target?.quarantined === true
        && target.busyReleaseId === releaseId && record.reconciled_at !== null
      if (current === undefined || current.version !== expectedVersion || target?.busyReleaseId !== releaseId
        || (target.quarantined && !resolvingQuarantine) || target.lastGeneration !== current.target_generation
        || record.target_generation !== current.target_generation
        || record.effect_lease_id !== current.effect_lease_id
        || (record.state !== 'STAGING_OK' && record.state !== 'ROLLED_BACK')) return false
      // Gravar o recibo e mover o ponteiro ativo é UMA operação: entre as duas,
      // um leitor veria um destino com efeito aplicado e sem dono.
      await this.#persist(record)
      const { busyReleaseId: _released, ...idle } = target
      this.#targets.set(record.target_key, {
        ...idle,
        // A reconciliação que chegou até aqui trouxe o recibo do provedor: o
        // efeito externo deixou de ser desconhecido, e é isso — e só isso — que
        // a quarentena estava esperando.
        quarantined: false,
        activeReleaseId: releaseId, activeGeneration: record.target_generation,
      })
      return true
    })
  }

  quarantineTarget(
    actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number,
    expectedTargetGeneration: number, expectedLeaseId: string, record: StagingRelease,
  ): Promise<StagingRelease> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      if (current === undefined) throw new Error('missing release')
      const target = this.#targets.get(current.target_key)
        ?? { lastGeneration: current.target_generation, quarantined: false }
      if (current.version < expectedVersion || current.target_generation !== expectedTargetGeneration
        || current.effect_lease_id !== expectedLeaseId || record.target_generation !== expectedTargetGeneration
        || record.effect_lease_id !== expectedLeaseId) throw new Error('stale quarantine fence')
      // O relógio do Studio nunca anda para trás num registro: um carimbo mais
      // velho que o anterior tornaria a ordem causal do journal inútil.
      const transitionAt = new Date(Math.max(
        Date.parse(record.last_transition_at), Date.parse(current.last_transition_at),
      )).toISOString()
      const incident = stagingReleaseSchema.parse({
        ...current, state: 'RECONCILIATION_REQUIRED', version: current.version + 1,
        last_transition_at: transitionAt, finished_at: null,
        provider_receipt: record.provider_receipt, failure_code: 'CONFLICTING_EXTERNAL_EFFECT',
      })
      await this.#persist(incident)
      const busyReleaseId = target.busyReleaseId
      if (busyReleaseId !== undefined && busyReleaseId !== releaseId) {
        const busy = this.#records.get(busyReleaseId)
        if (busy !== undefined && busy.target_generation > expectedTargetGeneration && !TERMINAL.has(busy.state)) {
          const busyAt = new Date(Math.max(
            Date.parse(transitionAt), Date.parse(busy.last_transition_at),
            busy.started_at === null ? 0 : Date.parse(busy.started_at),
          )).toISOString()
          // Quem ainda não começou vira FALHA; quem já começou vira
          // RECONCILIAÇÃO. A diferença é se existe ou não um efeito externo em
          // voo que ninguém pode declarar morto.
          await this.#persist(stagingReleaseSchema.parse(busy.started_at === null
            ? { ...busy, state: 'FAILED', version: busy.version + 1, last_transition_at: busyAt, finished_at: busyAt, failure_code: 'TARGET_QUARANTINED_BEFORE_EFFECT' }
            : { ...busy, state: 'RECONCILIATION_REQUIRED', version: busy.version + 1, last_transition_at: busyAt, finished_at: null, failure_code: 'TARGET_FENCED_BY_LATE_EFFECT' }))
        }
      }
      // O dono da geração mais nova é PRESERVADO: substituí-lo pelo release
      // antigo deixaria o trabalho em voo sem ninguém apontando para ele.
      this.#targets.set(current.target_key, { ...target, busyReleaseId: busyReleaseId ?? releaseId, quarantined: true })
      return structuredClone(incident)
    })
  }

  /** Grava primeiro, memória depois: um leitor nunca vê o que não durou. */
  async #persist(record: StagingRelease): Promise<void> {
    await this.table.put(record.release_id as StagingKey, record)
    this.#records.set(record.release_id, structuredClone(record))
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}
