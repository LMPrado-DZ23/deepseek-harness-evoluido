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

const NOTIFICATION_OPTIONS = { icon: '/studio/icons/icon-192.png', badge: '/studio/icons/icon-192.png', tag: 'dz23-generation' } as const

/**
 * Browser Notification API behind a port so tests and unsupported browsers are
 * explicit. On Android/Chrome `new Notification(...)` throws
 * (`Illegal constructor`) and only the service worker registration may show
 * one, so the registration is used whenever there is one and the constructor is
 * the fallback for desktop browsers without a worker.
 */
export function browserNotificationPort(registration?: ServiceWorkerRegistration | undefined): NotificationPort | undefined {
  if (typeof Notification === 'undefined') return undefined
  return {
    get permission() { return Notification.permission },
    requestPermission: () => Notification.requestPermission(),
    show: (title, body) => {
      if (registration !== undefined) { void registration.showNotification(title, { body, ...NOTIFICATION_OPTIONS }) ; return }
      // Throws on browsers that only allow the worker path: the notification is a courtesy, never a reason to break the page.
      try { new Notification(title, { body, ...NOTIFICATION_OPTIONS }) } catch { /* the interface remains the source of truth */ }
    },
  }
}

/**
 * The port bound to the service worker registration, when one is ready. Falls
 * back to the constructor port so a browser without a worker still notifies.
 */
export async function notificationPortFor(navigatorRef: Navigator): Promise<NotificationPort | undefined> {
  if (typeof Notification === 'undefined') return undefined
  if (!('serviceWorker' in navigatorRef)) return browserNotificationPort()
  try {
    const registration = await navigatorRef.serviceWorker.ready
    return browserNotificationPort(registration)
  } catch {
    return browserNotificationPort()
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
