import t from '../i18n/pwa.pt-BR.json'

/** Event the interface dispatches on `window` when a generation finishes (any final state). */
export const GENERATION_FINISHED_EVENT = 'dz23:generation-finished'
export type GenerationFinalState = 'VERIFIED_PROTOTYPE' | 'BUILD_FAILED' | 'TESTS_FAILED' | 'BLOCKED_EXTERNAL' | 'CANCELLED'

const FINAL_STATES: readonly GenerationFinalState[] = ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'BLOCKED_EXTERNAL', 'CANCELLED']

/** Message for a known final state; unknown values (arbitrary event detail) produce no notification. */
export function notificationBodyFor(state: unknown): string | undefined {
  if (!FINAL_STATES.includes(state as GenerationFinalState)) return undefined
  if (state === 'VERIFIED_PROTOTYPE') return t.notifications.verified
  if (state === 'CANCELLED') return t.notifications.cancelled
  if (state === 'BLOCKED_EXTERNAL') return t.notifications.blocked
  return t.notifications.failed
}

export interface NotificationPort {
  permission: NotificationPermission
  requestPermission(): Promise<NotificationPermission>
  show(title: string, body: string): void
}

/** Browser Notification API behind a port so tests and unsupported browsers are explicit. */
export function browserNotificationPort(): NotificationPort | undefined {
  if (typeof Notification === 'undefined') return undefined
  return {
    get permission() { return Notification.permission },
    requestPermission: () => Notification.requestPermission(),
    show: (title, body) => { new Notification(title, { body, icon: '/studio/icons/icon-192.png', tag: 'dz23-generation' }) },
  }
}

/**
 * Local notifications only (no push, no server): when the tab is hidden and
 * permission was granted, a finished generation shows one notification. The
 * interface stays the source of truth; this is a courtesy for people who
 * switched apps while waiting.
 */
export function attachGenerationNotifications(target: EventTarget, port: NotificationPort | undefined, isHidden: () => boolean): () => void {
  if (port === undefined) return () => undefined
  const listener = (event: Event) => {
    const body = notificationBodyFor((event as CustomEvent<{ state?: unknown }>).detail?.state)
    if (body === undefined || port.permission !== 'granted' || !isHidden()) return
    port.show(t.notifications.title, body)
  }
  target.addEventListener(GENERATION_FINISHED_EVENT, listener)
  return () => target.removeEventListener(GENERATION_FINISHED_EVENT, listener)
}
