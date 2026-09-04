import { BuilderSupervisorError } from './model.js'

export interface ReplayClaimPort { claim(requestId: string): Promise<void> }

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
