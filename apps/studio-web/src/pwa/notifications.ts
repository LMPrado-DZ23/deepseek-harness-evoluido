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
  /** `tag` groups the OS notification. One tag per run, so two different runs do not replace each other. */
  show(title: string, body: string, tag?: string): void
}

const NOTIFICATION_OPTIONS = { icon: '/studio/icons/icon-192.png', badge: '/studio/icons/icon-192.png', tag: 'dz23-generation' } as const

/** Detail carried by the finished-generation event. `runId` is what makes a repeat recognisable. */
export interface GenerationFinishedDetail { state: unknown; runId?: string | undefined }

/** Placeholder key for an event with no run: it still notifies, it just cannot be told apart from another run in the same state. */
export const UNKNOWN_RUN_KEY = 'unknown-run'

/** The run an event refers to, accepting both spellings so the event is not a trap for whoever dispatches it. */
export function runIdOf(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null
  const record = detail as { runId?: unknown; run_id?: unknown }
  const value = typeof record.runId === 'string' ? record.runId : typeof record.run_id === 'string' ? record.run_id : null
  return value === null || value.trim() === '' ? null : value
}

/** Identity of a notification: the same run reaching the same state is the same notification, however many events say so. */
export function notificationKey(runId: string | null, state: string): string {
  return `${runId ?? UNKNOWN_RUN_KEY}::${state}`
}

/** Dispatches the event the PWA listens to. Kept here so the page only has to pass the run and the state. */
export function dispatchGenerationFinished(target: EventTarget, detail: GenerationFinishedDetail): void {
  target.dispatchEvent(new CustomEvent(GENERATION_FINISHED_EVENT, { detail }))
}

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
    show: (title, body, tag) => {
      const options = { ...NOTIFICATION_OPTIONS, body, ...(tag === undefined ? {} : { tag }) }
      if (registration !== undefined) {
        // The promise MUST be handled. `showNotification` rejects when the permission was revoked
        // mid-session, when the worker is gone, or when the platform refuses the payload — and an
        // unhandled rejection there would surface as an error in a page that is otherwise fine.
        // The notification is a courtesy; its failure is silent by design.
        try { void Promise.resolve(registration.showNotification(title, options)).catch(() => undefined) } catch { /* the interface remains the source of truth */ }
        return
      }
      // Throws on browsers that only allow the worker path: the notification is a courtesy, never a reason to break the page.
      try { new Notification(title, options) } catch { /* the interface remains the source of truth */ }
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
 *
 * Each run/state pair notifies at most once. The page polls, and a poll that
 * lands twice on the same finished run used to produce a second identical
 * notification; the person's phone buzzing twice for one result is the
 * interface saying something happened when nothing did.
 */
const NOTIFIED_KEYS_LIMIT = 64

export function attachGenerationNotifications(target: EventTarget, port: NotificationPort | undefined, isHidden: () => boolean): () => void {
  if (port === undefined) return () => undefined
  const notified = new Set<string>()
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ state?: unknown } | undefined>).detail
    const state = detail?.state
    const body = notificationBodyFor(state)
    // The key is only recorded when the notification is actually shown: an event that arrived
    // with the tab visible, or without permission, must not silence the next one.
    if (body === undefined || port.permission !== 'granted' || !isHidden()) return
    const runId = runIdOf(detail)
    const key = notificationKey(runId, state as string)
    if (notified.has(key)) return
    notified.add(key)
    // Bounded: a long session must not grow this set forever.
    if (notified.size > NOTIFIED_KEYS_LIMIT) notified.delete(notified.values().next().value as string)
    port.show(t.notifications.title, body, runId === null ? undefined : `dz23-generation-${runId}`)
  }
  target.addEventListener(GENERATION_FINISHED_EVENT, listener)
  return () => target.removeEventListener(GENERATION_FINISHED_EVENT, listener)
}
