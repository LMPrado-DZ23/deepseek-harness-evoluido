export class Semaphore {
  #active = 0
  readonly #queue: Array<{ readonly signal: AbortSignal; readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void }> = []
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('INVALID_CONCURRENCY_LIMIT')
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.#active < this.maximum) return this.#grant()
    return new Promise((resolve, reject) => {
      const item = { signal, resolve, reject }
      const abort = () => { const at = this.#queue.indexOf(item); if (at >= 0) this.#queue.splice(at, 1); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      this.#queue.push({ ...item, resolve: release => { signal.removeEventListener('abort', abort); resolve(release) } })
    })
  }
  get active(): number { return this.#active }
  #grant(): () => void {
    this.#active += 1; let released = false
    return () => {
      if (released) return
      released = true; this.#active -= 1
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()!
        if (!next.signal.aborted) { next.resolve(this.#grant()); break }
      }
    }
  }
}
