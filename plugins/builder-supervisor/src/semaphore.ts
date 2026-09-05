interface Waiter {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
  previous: Waiter | undefined
  next: Waiter | undefined
  queued: boolean
}

export class Semaphore {
  #active = 0
  #queued = 0
  #head: Waiter | undefined
  #tail: Waiter | undefined
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('INVALID_CONCURRENCY_LIMIT')
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.#active < this.maximum) return this.#grant()
    return new Promise((resolve, reject) => {
      let item!: Waiter
      const abort = () => { if (item.queued) this.#remove(item); reject(signal.reason) }
      item = { signal, reject, queued: true, resolve: release => { signal.removeEventListener('abort', abort); resolve(release) }, previous: this.#tail, next: undefined }
      if (this.#tail === undefined) this.#head = item
      else this.#tail.next = item
      this.#tail = item; this.#queued += 1
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  get active(): number { return this.#active }
  get queued(): number { return this.#queued }
  #grant(): () => void {
    this.#active += 1; let released = false
    return () => {
      if (released) return
      released = true; this.#active -= 1
      while (this.#head !== undefined) {
        const next = this.#head; this.#remove(next)
        if (!next.signal.aborted) { next.resolve(this.#grant()); break }
      }
    }
  }
  #remove(item: Waiter): void {
    if (!item.queued) return
    if (item.previous === undefined) this.#head = item.next
    else item.previous.next = item.next
    if (item.next === undefined) this.#tail = item.previous
    else item.next.previous = item.previous
    item.previous = undefined; item.next = undefined; item.queued = false; this.#queued -= 1
  }
}
