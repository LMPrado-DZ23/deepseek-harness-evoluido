import type { BuilderRuntimeScopeId } from './runtime-scope.js'
import { isBuilderRuntimeScopeId } from './runtime-scope.js'

export interface GlobalBuilderCapacityPort {
  acquire(scopeId: BuilderRuntimeScopeId, signal?: AbortSignal): Promise<() => void>
}

interface Waiter { readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void; readonly signal?: AbortSignal; abort?: () => void }

export class FairGlobalBuilderCapacity implements GlobalBuilderCapacityPort {
  readonly #queues = new Map<BuilderRuntimeScopeId, Waiter[]>()
  readonly #turns: BuilderRuntimeScopeId[] = []
  #active = 0

  constructor(readonly maximum: number, readonly maximumPending = 1_024, readonly maximumPendingPerScope = 64) {
    if (![maximum, maximumPending, maximumPendingPerScope].every(value => Number.isSafeInteger(value) && value >= 1) || maximumPendingPerScope > maximumPending) throw new Error('INVALID_GLOBAL_CAPACITY')
  }

  acquire(scopeId: BuilderRuntimeScopeId, signal?: AbortSignal): Promise<() => void> {
    if (!isBuilderRuntimeScopeId(scopeId)) return Promise.reject(new Error('INVALID_RUNTIME_SCOPE'))
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const current = this.#queues.get(scopeId)?.length ?? 0
    if (this.pending >= this.maximumPending || current >= this.maximumPendingPerScope) return Promise.reject(new Error('GLOBAL_CAPACITY_QUEUE_FULL'))
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) }
      let queue = this.#queues.get(scopeId)
      if (queue === undefined) { queue = []; this.#queues.set(scopeId, queue); this.#turns.push(scopeId) }
      queue.push(waiter)
      if (signal !== undefined) {
        waiter.abort = () => { this.#remove(scopeId, waiter); reject(signal.reason) }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.#drain()
    })
  }

  get active(): number { return this.#active }
  get pending(): number { return [...this.#queues.values()].reduce((total, queue) => total + queue.length, 0) }

  #drain(): void {
    while (this.#active < this.maximum && this.#turns.length > 0) {
      const scopeId = this.#turns.shift()!
      const queue = this.#queues.get(scopeId)!
      const waiter = queue.shift()!
      if (queue.length > 0) this.#turns.push(scopeId); else this.#queues.delete(scopeId)
      if (waiter.signal !== undefined && waiter.abort !== undefined) waiter.signal.removeEventListener('abort', waiter.abort)
      this.#active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true; this.#active -= 1; this.#drain()
      })
    }
  }

  #remove(scopeId: BuilderRuntimeScopeId, waiter: Waiter): void {
    // Only the abort handler installed after enqueue can enter this method.
    const queue = this.#queues.get(scopeId)!
    queue.splice(queue.indexOf(waiter), 1)
    if (queue.length === 0) {
      this.#queues.delete(scopeId)
      const turn = this.#turns.indexOf(scopeId)
      this.#turns.splice(turn, 1)
    }
  }
}
