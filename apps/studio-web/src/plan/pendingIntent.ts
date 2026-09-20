import { novaChave } from '../creationIntent'

export const PLAN_INTENT_DATABASE = 'frigg.plan-intents.v1'
const STORE = 'pending'

/** Somente metadados: nenhum texto, cookie, credencial ou corpo do pedido. */
export interface PendingIntent {
  readonly slot: string
  readonly digest: string
  readonly key: string
  readonly baseRevision: number | null
}

export interface PendingPlanIntent extends PendingIntent { readonly baseRevision: number }
export interface PendingCreationIntent extends PendingIntent { readonly baseRevision: null }

export interface PlanIntentInput {
  readonly scope: readonly [string, string, string]
  readonly projectId: string
  readonly kind: 'edit' | 'slice'
  readonly material: string
  readonly baseRevision: number
}

export function isPendingIntent(value: unknown): value is PendingIntent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<PendingIntent>
  return Object.keys(record).sort().join(',') === 'baseRevision,digest,key,slot'
    && typeof record.slot === 'string' && /^[a-f0-9]{64}$/u.test(record.slot)
    && typeof record.digest === 'string' && /^[a-f0-9]{64}$/u.test(record.digest)
    && typeof record.key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/u.test(record.key)
    && (record.baseRevision === null || (typeof record.baseRevision === 'number' && Number.isSafeInteger(record.baseRevision) && record.baseRevision > 0))
}

export function isPendingPlanIntent(value: unknown): value is PendingPlanIntent {
  return isPendingIntent(value) && value.baseRevision !== null
}

/** Criacao nao tem revisao de plano; null distingue esses metadados. */
export function resolvePendingCreationIntent(previous: unknown, slot: string, fingerprint: string, generate: () => string = novaChave): PendingCreationIntent {
  if (previous !== undefined && (!isPendingIntent(previous) || previous.slot !== slot || previous.baseRevision !== null)) {
    throw new Error('PLAN_INTENT_STORAGE_CORRUPTED')
  }
  if (previous !== undefined && previous.digest === fingerprint) return previous as PendingCreationIntent
  return { slot, digest: fingerprint, key: generate(), baseRevision: null }
}

/** Mesma intencao conserva a revisao antiga; texto corrigido e outra intencao. */
export function resolvePendingPlanIntent(previous: unknown, slot: string, fingerprint: string, baseRevision: number, generate: () => string = novaChave): PendingPlanIntent {
  if (previous !== undefined && (!isPendingPlanIntent(previous) || previous.slot !== slot)) {
    throw new Error('PLAN_INTENT_STORAGE_CORRUPTED')
  }
  if (previous !== undefined && previous.digest === fingerprint) return previous
  return { slot, digest: fingerprint, key: generate(), baseRevision }
}

async function digest(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(PLAN_INTENT_DATABASE, 1)
    let ended = false
    const finish = (error?: unknown): void => {
      if (ended) return
      ended = true
      clearTimeout(timeout)
      if (error !== undefined) reject(error)
      else resolve(request.result)
    }
    const timeout = setTimeout(() => finish(new Error('PLAN_INTENT_STORAGE_TIMEOUT')), 5_000)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'slot' }) }
    request.onerror = () => finish(request.error ?? new Error('PLAN_INTENT_STORAGE_FAILED'))
    request.onblocked = () => finish(new Error('PLAN_INTENT_STORAGE_BLOCKED'))
    request.onsuccess = () => {
      if (ended) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close() }
      finish()
    }
  })
}

/** A transacao nativa serializa abas: ler e reservar a chave sao um unico efeito. */
async function transact<T>(factory: IDBFactory, action: (store: IDBObjectStore, setResult: (value: T) => void) => void): Promise<T> {
  const database = await open(factory)
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' })
      let result: T
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error ?? new Error('PLAN_INTENT_STORAGE_ABORTED'))
      transaction.onerror = () => reject(transaction.error ?? new Error('PLAN_INTENT_STORAGE_FAILED'))
      try { action(transaction.objectStore(STORE), value => { result = value }) }
      catch (error) { transaction.abort(); reject(error) }
    })
  } finally { database.close() }
}

/** Reabrir a pagina conserva chave e revisao originais para o mesmo pedido. */
export async function preparePlanIntent(input: PlanIntentInput, factory: IDBFactory = window.indexedDB): Promise<PendingPlanIntent> {
  const intent = await prepareIntent(input, factory)
  if (!isPendingPlanIntent(intent)) throw new Error('PLAN_INTENT_STORAGE_CORRUPTED')
  return intent
}

/** Reserva a criacao no escopo da pessoa, antes de existir identificador de projeto. */
export async function prepareCreationIntent(scope: readonly [string, string, string], material: string, factory: IDBFactory = window.indexedDB): Promise<PendingIntent> {
  return prepareIntent({ scope, projectId: '@new-project', kind: 'create', material, baseRevision: null }, factory)
}

async function prepareIntent(input: PlanIntentInput | { scope: readonly [string, string, string]; projectId: string; kind: 'create'; material: string; baseRevision: null }, factory: IDBFactory): Promise<PendingIntent> {
  if ((input.baseRevision !== null && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1)) || input.scope.some(value => value === '') || input.projectId === '') {
    throw new Error('PLAN_INTENT_INPUT_INVALID')
  }
  const slot = await digest(JSON.stringify([input.scope, input.projectId, input.kind]))
  const fingerprint = await digest(JSON.stringify([slot, input.material]))
  return transact(factory, (store, done) => {
    const read = store.get(slot)
    read.onsuccess = () => {
      const previous: unknown = read.result
      try {
        const intent = input.baseRevision === null ? resolvePendingCreationIntent(previous, slot, fingerprint)
          : resolvePendingPlanIntent(previous, slot, fingerprint, input.baseRevision)
        if (intent !== previous) store.put(intent)
        done(intent)
      } catch {
        // Dado corrompido nao vira chave nova silenciosamente: poderia repetir custo.
        store.transaction.abort()
      }
    }
  })
}

/** Uma resposta antiga nunca apaga uma intencao mais nova, criada em outra aba. */
export async function confirmPlanIntent(intent: PendingIntent, factory: IDBFactory = window.indexedDB): Promise<void> {
  return transact(factory, (store, done) => {
    const read = store.get(intent.slot)
    read.onsuccess = () => {
      const current: unknown = read.result
      if (current !== undefined && !isPendingIntent(current)) { store.transaction.abort(); return }
      if (current?.key === intent.key && current.digest === intent.digest) store.delete(intent.slot)
      done(undefined)
    }
  })
}

/** Limpa somente os metadados do FRIGG, depois da revogacao confirmada no servidor. */
export async function clearPendingPlanIntents(factory: IDBFactory = window.indexedDB): Promise<void> {
  return transact(factory, (store, done) => { store.clear(); done(undefined) })
}
