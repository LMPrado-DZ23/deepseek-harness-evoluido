import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client, QueryResult } from 'pg'
import { PostgresKvUnit } from '../src/unit.ts'

const descriptor = { name: 'unit_test', version: 1, tables: ['records'], hasGlobal: true } as const

describe('PostgresKvUnit defensive paths', () => {
  afterEach(() => vi.useRealTimers())

  it('maps a snapshot and performs every primitive on one client', async () => {
    const client = fakeClient(sql => {
      if (sql.includes('jsonb_agg')) return result({ records: [{ table: 'records', key: '__proto__', value: { safe: true } }], global: { n: 1 } })
      return { rows: [], rowCount: 1 } as unknown as QueryResult
    })
    const closed = vi.fn()
    const unit = new PostgresKvUnit({ client: client as unknown as Client, descriptor, schema: 'unit_schema', holder: 'holder', heartbeatMs: 60_000, onClose: closed })
    const snapshot = await unit.loadAll()
    expect(Object.prototype.hasOwnProperty.call(snapshot.tables.records, '__proto__')).toBe(true)
    expect(snapshot.global).toEqual({ n: 1 })
    await unit.putRecord('records', 'key', { value: true })
    await unit.deleteRecord('records', 'key')
    await unit.setGlobal({ value: true })
    await unit.close()
    await unit.close()
    expect(closed).toHaveBeenCalledOnce()
    expect(client.end).toHaveBeenCalledOnce()
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects malformed rows from undeclared physical tables', async () => {
    const client = fakeClient(sql => sql.includes('jsonb_agg')
      ? result({ records: [{ table: 'foreign', key: 'key', value: {} }], global: null })
      : ({ rows: [], rowCount: 1 } as unknown as QueryResult))
    const unit = createUnit(client)
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'malformed-medium' })
    await unit.close()
  })

  it('preserves ordinary PostgreSQL failures and wraps non-Error throws', async () => {
    const ordinary = new Error('statement failed')
    const client = fakeClient(sql => {
      if (sql.startsWith('INSERT') || sql.startsWith('DELETE') || sql.includes('jsonb_agg')) throw ordinary
      return { rows: [], rowCount: 1 } as unknown as QueryResult
    })
    const unit = createUnit(client)
    await expect(unit.loadAll()).rejects.toBe(ordinary)
    await expect(unit.putRecord('records', 'key', {})).rejects.toBe(ordinary)
    await expect(unit.deleteRecord('records', 'key')).rejects.toBe(ordinary)
    await expect(unit.setGlobal({})).rejects.toBe(ordinary)
    await unit.close()

    const nonErrorClient = fakeClient(sql => {
      if (sql.includes('jsonb_agg')) throw 'non-error failure'
      return { rows: [], rowCount: 1 } as unknown as QueryResult
    })
    const nonErrorUnit = createUnit(nonErrorClient)
    await expect(nonErrorUnit.loadAll()).rejects.toThrow('non-error failure')
    await nonErrorUnit.close()
  })

  it('fails closed for connection errors, client error events and a lost heartbeat row', async () => {
    const connection = Object.assign(new Error('connection ended'), { code: 'EPIPE' })
    const connectionClient = fakeClient(sql => {
      if (sql.startsWith('INSERT')) throw connection
      return { rows: [], rowCount: 1 } as unknown as QueryResult
    })
    const connectionUnit = createUnit(connectionClient)
    await expect(connectionUnit.putRecord('records', 'key', {})).rejects.toMatchObject({ code: 'unit-locked' })
    await connectionUnit.close()

    const eventClient = fakeClient(() => ({ rows: [], rowCount: 1 } as unknown as QueryResult))
    const eventUnit = createUnit(eventClient)
    eventClient.emit('error', new Error('socket closed'))
    await expect(eventUnit.deleteRecord('records', 'key')).rejects.toMatchObject({ code: 'unit-locked' })
    await eventUnit.close()

    vi.useFakeTimers()
    const healthyHeartbeatClient = fakeClient(() => ({ rows: [], rowCount: 1 } as unknown as QueryResult))
    const healthyHeartbeatUnit = new PostgresKvUnit({ client: healthyHeartbeatClient as unknown as Client, descriptor, schema: 'unit_schema', holder: 'holder', heartbeatMs: 10, onClose: vi.fn() })
    await vi.advanceTimersByTimeAsync(11)
    await expect(healthyHeartbeatUnit.setGlobal({})).resolves.toBeUndefined()
    await healthyHeartbeatUnit.close()

    const heartbeatClient = fakeClient(sql => ({ rows: [], rowCount: sql.startsWith('UPDATE') ? 0 : 1 } as unknown as QueryResult))
    const heartbeatUnit = new PostgresKvUnit({ client: heartbeatClient as unknown as Client, descriptor, schema: 'unit_schema', holder: 'holder', heartbeatMs: 10, onClose: vi.fn() })
    await vi.advanceTimersByTimeAsync(11)
    await expect(heartbeatUnit.setGlobal({})).rejects.toMatchObject({ code: 'unit-locked' })
    await heartbeatUnit.close()
  })
})

type FakeClient = EventEmitter & { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }

function fakeClient(handler: (sql: string) => QueryResult): FakeClient {
  const client = new EventEmitter() as FakeClient
  client.query = vi.fn((sql: string) => Promise.resolve().then(() => handler(sql)))
  client.end = vi.fn(() => Promise.resolve())
  return client
}

function createUnit(client: FakeClient): PostgresKvUnit {
  return new PostgresKvUnit({ client: client as unknown as Client, descriptor, schema: 'unit_schema', holder: 'holder', heartbeatMs: 60_000, onClose: vi.fn() })
}

function result(row: unknown): QueryResult {
  return { rows: [row], rowCount: 1 } as unknown as QueryResult
}
