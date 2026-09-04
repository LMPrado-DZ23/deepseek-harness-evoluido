import { describe, expect, it } from 'vitest'
import { attachGenerationNotifications, browserNotificationPort, dispatchGenerationFinished, GENERATION_FINISHED_EVENT, notificationBodyFor, notificationKey, notificationPortFor, runIdOf, type NotificationPort } from './notifications'
import t from '../i18n/pwa.pt-BR.json'

function port(permission: NotificationPermission): NotificationPort & { shown: Array<[string, string]> } {
  const shown: Array<[string, string]> = []
  return { permission, shown, requestPermission: async () => permission, show: (title, body) => { shown.push([title, body]) } }
}

function taggedPort(): NotificationPort & { shown: Array<[string, string, string | undefined]> } {
  const shown: Array<[string, string, string | undefined]> = []
  return { permission: 'granted', shown, requestPermission: async () => 'granted' as NotificationPermission, show: (title, body, tag) => { shown.push([title, body, tag]) } }
}

describe('local generation notifications', () => {
  it('maps every final state to a plain-language message from the catalog', () => {
    expect(notificationBodyFor('VERIFIED_PROTOTYPE')).toBe(t.notifications.verified)
    expect(notificationBodyFor('BUILD_FAILED')).toBe(t.notifications.failed)
    expect(notificationBodyFor('TESTS_FAILED')).toBe(t.notifications.failed)
    expect(notificationBodyFor('CANCELLED')).toBe(t.notifications.cancelled)
    expect(notificationBodyFor('BLOCKED_EXTERNAL')).toBe(t.notifications.blocked)
    expect(notificationBodyFor('INTERRUPTED')).toBe(t.notifications.failed)
    expect(notificationBodyFor('SOMETHING_ELSE')).toBeUndefined()
    expect(notificationBodyFor(undefined)).toBeUndefined()
    for (const value of Object.values(t.notifications)) expect(value).not.toMatch(/\bpront[oa]s?\b/iu)
  })

  it('notifies only when permission is granted and the tab is hidden, and detaches cleanly', () => {
    const target = new EventTarget()
    const granted = port('granted')
    let hidden = false
    const detach = attachGenerationNotifications(target, granted, () => hidden)
    target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail: { state: 'VERIFIED_PROTOTYPE' } }))
    expect(granted.shown).toEqual([])
    hidden = true
    target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail: { state: 'VERIFIED_PROTOTYPE' } }))
    expect(granted.shown).toEqual([[t.notifications.title, t.notifications.verified]])
    target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail: {} }))
    expect(granted.shown).toHaveLength(1)
    detach()
    target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail: { state: 'CANCELLED' } }))
    expect(granted.shown).toHaveLength(1)
  })

  it('shows through the service worker registration when there is one, and never breaks the page when the constructor is forbidden', async () => {
    const shown: Array<[string, NotificationOptions | undefined]> = []
    const registration = { showNotification: async (title: string, options?: NotificationOptions) => { shown.push([title, options]) } } as unknown as ServiceWorkerRegistration
    const original = Reflect.get(globalThis, 'Notification') as unknown
    // Android/Chrome: the constructor throws and only the registration may show a notification.
    Reflect.set(globalThis, 'Notification', Object.assign(function Forbidden() { throw new TypeError('Illegal constructor') }, { permission: 'granted' as NotificationPermission }))
    try {
      const viaWorker = browserNotificationPort(registration)!
      viaWorker.show(t.notifications.title, t.notifications.verified)
      expect(shown).toEqual([[t.notifications.title, expect.objectContaining({ body: t.notifications.verified, tag: 'dz23-generation' })]])
      // Without a registration the constructor is tried and its refusal is swallowed: the page keeps working.
      expect(() => browserNotificationPort()!.show('x', 'y')).not.toThrow()
      // The port follows `serviceWorker.ready`, which is the only path that works on Android.
      const port = await notificationPortFor({ serviceWorker: { ready: Promise.resolve(registration) } } as unknown as Navigator)
      port!.show('t', 'b')
      expect(shown).toHaveLength(2)
      // A worker that never becomes ready still leaves a usable port instead of no notifications at all.
      expect(await notificationPortFor({ serviceWorker: { ready: Promise.reject(new Error('no worker')) } } as unknown as Navigator)).toBeDefined()
      expect(await notificationPortFor({} as Navigator)).toBeDefined()
    } finally {
      Reflect.set(globalThis, 'Notification', original)
    }
  })

  it('stays silent without permission or without a Notification API', () => {
    const target = new EventTarget()
    const denied = port('denied')
    attachGenerationNotifications(target, denied, () => true)
    target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail: { state: 'VERIFIED_PROTOTYPE' } }))
    expect(denied.shown).toEqual([])
    expect(attachGenerationNotifications(target, undefined, () => true)).toBeTypeOf('function')
  })

  it('notifies once for the same run in the same state, and again for a different run', () => {
    const target = new EventTarget()
    const granted = taggedPort()
    attachGenerationNotifications(target, granted, () => true)
    // The page polls; the same finished run can be seen more than once. One result, one notification.
    dispatchGenerationFinished(target, { state: 'VERIFIED_PROTOTYPE', runId: 'run-1' })
    dispatchGenerationFinished(target, { state: 'VERIFIED_PROTOTYPE', runId: 'run-1' })
    dispatchGenerationFinished(target, { state: 'VERIFIED_PROTOTYPE', runId: 'run-1' })
    expect(granted.shown).toEqual([[t.notifications.title, t.notifications.verified, 'dz23-generation-run-1']])
    // Another run reaching the same state is another result and must be said.
    dispatchGenerationFinished(target, { state: 'VERIFIED_PROTOTYPE', runId: 'run-2' })
    expect(granted.shown).toHaveLength(2)
    expect(granted.shown[1]).toEqual([t.notifications.title, t.notifications.verified, 'dz23-generation-run-2'])
    // The same run reaching a different final state is also a different thing to say.
    dispatchGenerationFinished(target, { state: 'CANCELLED', runId: 'run-1' })
    expect(granted.shown).toHaveLength(3)
    expect(granted.shown[2]?.[1]).toBe(t.notifications.cancelled)
    dispatchGenerationFinished(target, { state: 'CANCELLED', runId: 'run-1' })
    expect(granted.shown).toHaveLength(3)
    // Both spellings of the run identity are accepted, and they are the SAME run.
    expect(runIdOf({ run_id: 'run-1' })).toBe('run-1')
    expect(runIdOf({ runId: 'run-1' })).toBe('run-1')
    expect(runIdOf({ runId: '  ' })).toBeNull()
    expect(runIdOf(undefined)).toBeNull()
    expect(notificationKey('run-1', 'CANCELLED')).not.toBe(notificationKey('run-2', 'CANCELLED'))
    expect(notificationKey(null, 'CANCELLED')).not.toBe(notificationKey('run-1', 'CANCELLED'))
  })

  it('an event that did not notify does not silence the next one', () => {
    const target = new EventTarget()
    const granted = taggedPort()
    let hidden = false
    attachGenerationNotifications(target, granted, () => hidden)
    dispatchGenerationFinished(target, { state: 'VERIFIED_PROTOTYPE', runId: 'run-1' })
    expect(granted.shown).toEqual([])
    hidden = true
    dispatchGenerationFinished(target, { state: 'VERIFIED_PROTOTYPE', runId: 'run-1' })
    expect(granted.shown).toHaveLength(1)
  })

  it('a rejection from showNotification never becomes an unhandled error', async () => {
    const unhandled: unknown[] = []
    const capture = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', capture)
    const original = Reflect.get(globalThis, 'Notification') as unknown
    Reflect.set(globalThis, 'Notification', Object.assign(function Fake() { /* never used on the worker path */ }, { permission: 'granted' as NotificationPermission }))
    try {
      // Permission revoked mid-session, worker gone, payload refused: showNotification rejects.
      const rejecting = { showNotification: () => Promise.reject(new Error('permission revoked')) } as unknown as ServiceWorkerRegistration
      const viaWorker = browserNotificationPort(rejecting)!
      expect(() => viaWorker.show(t.notifications.title, t.notifications.verified, 'dz23-generation-run-1')).not.toThrow()
      // Node reports an unhandled rejection after the microtask queue drains; give it real time.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      Reflect.set(globalThis, 'Notification', original)
      process.off('unhandledRejection', capture)
    }
  })

  it('a registration that throws synchronously does not break the page either', () => {
    const original = Reflect.get(globalThis, 'Notification') as unknown
    Reflect.set(globalThis, 'Notification', Object.assign(function Fake() { /* never used on the worker path */ }, { permission: 'granted' as NotificationPermission }))
    try {
      const throwing = { showNotification: () => { throw new TypeError('gone') } } as unknown as ServiceWorkerRegistration
      expect(() => browserNotificationPort(throwing)!.show('t', 'b')).not.toThrow()
    } finally {
      Reflect.set(globalThis, 'Notification', original)
    }
  })
})
