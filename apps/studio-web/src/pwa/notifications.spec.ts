import { describe, expect, it } from 'vitest'
import { attachGenerationNotifications, browserNotificationPort, GENERATION_FINISHED_EVENT, notificationBodyFor, notificationPortFor, type NotificationPort } from './notifications'
import t from '../i18n/pwa.pt-BR.json'

function port(permission: NotificationPermission): NotificationPort & { shown: Array<[string, string]> } {
  const shown: Array<[string, string]> = []
  return { permission, shown, requestPermission: async () => permission, show: (title, body) => { shown.push([title, body]) } }
}

describe('local generation notifications', () => {
  it('maps every final state to a plain-language message from the catalog', () => {
    expect(notificationBodyFor('VERIFIED_PROTOTYPE')).toBe(t.notifications.verified)
    expect(notificationBodyFor('BUILD_FAILED')).toBe(t.notifications.failed)
    expect(notificationBodyFor('TESTS_FAILED')).toBe(t.notifications.failed)
    expect(notificationBodyFor('CANCELLED')).toBe(t.notifications.cancelled)
    expect(notificationBodyFor('BLOCKED_EXTERNAL')).toBe(t.notifications.blocked)
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
})
