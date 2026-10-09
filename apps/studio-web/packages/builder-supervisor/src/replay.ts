import { BuilderSupervisorError } from './model.js'

export interface ReplayClaimPort { claim(requestId: string): Promise<void> }

export interface RpcReplayValue {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export interface RpcReplayPort {
  run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue>
}

export class RpcReplayGuard implements RpcReplayPort {
  readonly #entries = new Map<string, { readonly fingerprint: string; readonly result: Promise<RpcReplayValue> }>()
  constructor(private readonly maximum = 4_096) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('INVALID_REPLAY_CONFIGURATION')
  }
  async run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue> {
    const current = this.#entries.get(requestId)
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) throw new BuilderSupervisorError('REQUEST_ID_CONFLICT')
      return clone(await current.result)
    }
    if (this.#entries.size >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
    const result = operation().then(clone)
    this.#entries.set(requestId, { fingerprint, result })
    try { return clone(await result) } catch (error) { this.#entries.delete(requestId); throw error }
  }
}

function clone(value: RpcReplayValue): RpcReplayValue { return { status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body) } }

export class ReplayGuard implements ReplayClaimPort {
  readonly #claims = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
    private readonly maximum = 4_096,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error('INVALID_REPLAY_CONFIGURATION')
    }
  }

  async claim(requestId: string): Promise<void> {
    const now = this.now()
    for (const [id, expiresAt] of this.#claims) if (expiresAt <= now) this.#claims.delete(id)
    if (this.#claims.has(requestId)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    if (this.#claims.size >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
    this.#claims.set(requestId, now + this.ttlMs)
  }
}
