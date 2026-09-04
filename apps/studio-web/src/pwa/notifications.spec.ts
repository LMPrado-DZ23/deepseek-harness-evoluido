import { describe, expect, it } from 'vitest'
import { attachGenerationNotifications, GENERATION_FINISHED_EVENT, notificationBodyFor, type NotificationPort } from './notifications'
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

  it('stays silent without permission or without a Notification API', () => {
    const target = new EventTarget()
    const denied = port('denied')
    attachGenerationNotifications(target, denied, () => true)
    target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail: { state: 'VERIFIED_PROTOTYPE' } }))
    expect(denied.shown).toEqual([])
    expect(attachGenerationNotifications(target, undefined, () => true)).toBeTypeOf('function')
  })
})
