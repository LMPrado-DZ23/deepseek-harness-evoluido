import { describe, expect, it } from 'vitest'
import { FairGlobalBuilderCapacity } from '../src/manager-capacity.js'
import type { BuilderRuntimeScopeId } from '../src/runtime-scope.js'

const scope = (digit: string): BuilderRuntimeScopeId => `s_${digit.repeat(48)}`

describe('fair global builder capacity', () => {
  it('rotates among scopes without starving a quieter scope', async () => {
    const capacity = new FairGlobalBuilderCapacity(1)
    const first = await capacity.acquire(scope('1'))
    const order: string[] = []
    const a1 = capacity.acquire(scope('1')).then(release => { order.push('a1'); release() })
    const a2 = capacity.acquire(scope('1')).then(release => { order.push('a2'); release() })
    const b1 = capacity.acquire(scope('2')).then(release => { order.push('b1'); release() })
    first()
    await Promise.all([a1, a2, b1])
    expect(order).toEqual(['a1', 'b1', 'a2'])
    expect({ active: capacity.active, pending: capacity.pending }).toEqual({ active: 0, pending: 0 })
  })

  it('enforces global and per-scope queue bounds and validates physical scope ids', async () => {
    expect(() => new FairGlobalBuilderCapacity(0)).toThrow('INVALID_GLOBAL_CAPACITY')
    expect(() => new FairGlobalBuilderCapacity(1, 1, 2)).toThrow('INVALID_GLOBAL_CAPACITY')
    const capacity = new FairGlobalBuilderCapacity(1, 2, 1)
    const release = await capacity.acquire(scope('1'))
    const queued = capacity.acquire(scope('1'))
    await expect(capacity.acquire(scope('1'))).rejects.toThrow('GLOBAL_CAPACITY_QUEUE_FULL')
    await expect(capacity.acquire('tenant-secret' as BuilderRuntimeScopeId)).rejects.toThrow('INVALID_RUNTIME_SCOPE')
    release(); (await queued)()

    const globallyBounded = new FairGlobalBuilderCapacity(1, 2, 2)
    const active = await globallyBounded.acquire(scope('1'))
    const one = globallyBounded.acquire(scope('1')); const two = globallyBounded.acquire(scope('2'))
    await expect(globallyBounded.acquire(scope('3'))).rejects.toThrow('GLOBAL_CAPACITY_QUEUE_FULL')
    active(); (await one)(); (await two)()
  })

  it('removes an aborted waiter and returns an idempotent release', async () => {
    const capacity = new FairGlobalBuilderCapacity(1)
    const release = await capacity.acquire(scope('1'))
    const controller = new AbortController()
    const queued = capacity.acquire(scope('2'), controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(queued).rejects.toThrow('cancelled')
    expect(capacity.pending).toBe(0)
    release(); release()
    expect(capacity.active).toBe(0)
  })

  it('rejects a request that is already aborted', async () => {
    const controller = new AbortController(); controller.abort(new Error('early'))
    await expect(new FairGlobalBuilderCapacity(1).acquire(scope('1'), controller.signal)).rejects.toThrow('early')
  })

  it('detaches a live signal on dispatch and preserves other waiters when one aborts', async () => {
    const immediate = new FairGlobalBuilderCapacity(1)
    const live = new AbortController()
    const immediateRelease = await immediate.acquire(scope('1'), live.signal)
    live.abort(new Error('too-late'))
    expect(immediate.active).toBe(1)
    immediateRelease()

    const capacity = new FairGlobalBuilderCapacity(1)
    const active = await capacity.acquire(scope('1'))
    const first = new AbortController()
    const rejected = capacity.acquire(scope('2'), first.signal)
    const preserved = capacity.acquire(scope('2'))
    first.abort(new Error('first-cancelled'))
    await expect(rejected).rejects.toThrow('first-cancelled')
    expect(capacity.pending).toBe(1)
    active(); (await preserved)()
  })
})
