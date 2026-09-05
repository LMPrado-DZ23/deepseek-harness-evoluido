import t from '../i18n/pwa.pt-BR.json'
import { attachGenerationNotifications, browserNotificationPort, notificationPortFor, type NotificationPort } from './notifications'
import { SHELL_CLEARED_MESSAGE, SHELL_LOGOUT_MESSAGE, SHELL_SOURCE_ANSWER, SHELL_SOURCE_REQUEST, SW_CACHE_PREFIX, type ShellSource } from './policy'
import './pwa.css'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface PwaEnvironment {
  window: Window
  document: Document
  navigator: Navigator
  notifications?: NotificationPort | undefined
  caches?: CacheStorage | undefined
}

/**
 * Whether THIS screen is the copy saved on this device or something the server just sent. A page
 * cannot read the headers of its own navigation response, so it asks the worker that controls it,
 * and the worker answers about the navigation that created this page and no other.
 *
 * It used to read one global mark out of Cache Storage instead, and a per-navigation fact kept in a
 * single last-writer-wins slot told people the wrong thing. Reproduced in Chromium: visit once with
 * no network (the slot is left saying `cache`), then reload with the network back and the worker
 * bypassed — Shift+Reload, `Network.setBypassServiceWorker`. The navigation goes straight to the
 * server, nothing corrects the slot, and a person with a live session is told the screen is an old
 * saved copy. Asking the controller closes exactly that: a bypassed navigation produces a page with
 * NO controller, so there is nobody to ask and nothing is claimed.
 *
 * `undefined` means nobody answered: no worker controlling this page, a worker that never saw this
 * navigation, or a browser that refuses. The interface then says nothing extra, which is the honest
 * thing to do with an unknown.
 */
export async function shellSource(env: { navigator: Navigator } = { navigator }, timeoutMs = 3_000): Promise<ShellSource | undefined> {
  const worker = env.navigator.serviceWorker?.controller
  if (worker === undefined || worker === null) return undefined
  try {
    return await new Promise<ShellSource | undefined>(resolvePromise => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolvePromise(undefined), timeoutMs)
      channel.port1.onmessage = message => {
        clearTimeout(timer)
        const answer = message.data as { type?: unknown; source?: unknown } | null
        const value = answer?.type === SHELL_SOURCE_ANSWER ? answer.source : undefined
        resolvePromise(value === 'cache' || value === 'network' ? value : undefined)
      }
      worker.postMessage({ type: SHELL_SOURCE_REQUEST }, [channel.port2])
    })
  } catch { return undefined }
}

/**
 * Signing out. There is no sign-out button in the Studio yet — the session ends by expiring, and the
 * worker handles THAT on its own (a 401 on `/studio/` drops the caches). This is the hook for the
 * button when it arrives, and the same thing a page can call after clearing the session itself:
 * without it the copy of the authenticated interface stays on the device and comes back offline.
 *
 * Resolves `true` when the worker confirmed the caches are gone, `false` when there was no worker to
 * ask — in which case the caller falls back to deleting them from the page, which this does too.
 */
export async function forgetSavedShell(env: { navigator: Navigator; caches?: CacheStorage | undefined } = { navigator, caches: typeof caches === 'undefined' ? undefined : caches }): Promise<boolean> {
  const worker = env.navigator.serviceWorker?.controller
  if (worker === undefined || worker === null) {
    await deleteShellCaches(env.caches)
    return false
  }
  const confirmed = await new Promise<boolean>(resolvePromise => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolvePromise(false), 3_000)
    channel.port1.onmessage = message => {
      clearTimeout(timer)
      resolvePromise((message.data as { type?: unknown } | null)?.type === SHELL_CLEARED_MESSAGE)
    }
    worker.postMessage({ type: SHELL_LOGOUT_MESSAGE }, [channel.port2])
  })
  if (!confirmed) await deleteShellCaches(env.caches)
  return confirmed
}

async function deleteShellCaches(store: CacheStorage | undefined): Promise<void> {
  if (store === undefined) return
  try {
    for (const name of await store.keys()) if (name.startsWith(SW_CACHE_PREFIX)) await store.delete(name)
  } catch { /* a browser that refuses Cache Storage has nothing saved to forget */ }
}

/**
 * Registers the service worker (offline shell only), shows an offline banner
 * driven by the browser's online/offline events, offers the install prompt
 * when the browser exposes it, and wires local notifications. Everything is
 * additive: the interface works exactly the same when any of it is missing.
 */
export function registerStudioPwa(env: PwaEnvironment = { window, document, navigator, notifications: browserNotificationPort() }): () => void {
  const disposers: Array<() => void> = []
  const banner = env.document.createElement('div')
  banner.className = 'pwa-offline-banner'
  banner.setAttribute('role', 'status')
  banner.setAttribute('aria-live', 'polite')
  banner.hidden = true
  banner.textContent = t.offline.banner
  env.document.body.append(banner)
  const sync = () => {
    banner.textContent = t.offline.banner
    banner.hidden = env.navigator.onLine
    env.document.body.classList.toggle('pwa-offline', !env.navigator.onLine)
  }
  sync()
  env.window.addEventListener('online', sync)
  env.window.addEventListener('offline', sync)
  disposers.push(() => { env.window.removeEventListener('online', sync); env.window.removeEventListener('offline', sync); banner.remove() })

  // A screen restored from the copy saved on this device says so, in its own notice, ALWAYS — not only
  // when the browser reports being offline. Otherwise a session that ended looks exactly like an
  // interface that is open, and on a shared device the next person is told "you are offline" when the
  // truth is "your session ended". This notice is separate from the offline banner because the two
  // things are different and can be true at the same time.
  const savedNotice = env.document.createElement('div')
  savedNotice.className = 'pwa-cached-shell'
  savedNotice.setAttribute('role', 'status')
  savedNotice.setAttribute('aria-live', 'polite')
  savedNotice.hidden = true
  savedNotice.textContent = t.offline.cachedShell
  env.document.body.append(savedNotice)
  disposers.push(() => savedNotice.remove())
  void shellSource({ navigator: env.navigator }).then(source => { savedNotice.hidden = source !== 'cache' }).catch(() => undefined)

  if ('serviceWorker' in env.navigator) {
    // Registered after the page finished loading so the worker never competes with the first paint.
    const register = () => { void env.navigator.serviceWorker.register('/studio/sw.js', { scope: '/studio/' }).catch(() => undefined) }
    if (env.document.readyState === 'complete') register()
    else env.window.addEventListener('load', register, { once: true })
  }

  let deferredPrompt: BeforeInstallPromptEvent | undefined
  const installButton = env.document.createElement('button')
  installButton.className = 'pwa-install'
  installButton.type = 'button'
  installButton.hidden = true
  installButton.textContent = t.install.prompt
  installButton.addEventListener('click', () => {
    if (deferredPrompt === undefined) return
    void deferredPrompt.prompt()
    void deferredPrompt.userChoice.then(() => { deferredPrompt = undefined; installButton.hidden = true })
  })
  env.document.body.append(installButton)
  const onBeforeInstall = (event: Event) => { event.preventDefault(); deferredPrompt = event as BeforeInstallPromptEvent; installButton.hidden = false }
  const onInstalled = () => {
    deferredPrompt = undefined
    installButton.hidden = true
    banner.textContent = t.install.installed
    banner.hidden = false
    env.window.setTimeout(sync, 4_000)
  }
  env.window.addEventListener('beforeinstallprompt', onBeforeInstall)
  env.window.addEventListener('appinstalled', onInstalled)
  disposers.push(() => { env.window.removeEventListener('beforeinstallprompt', onBeforeInstall); env.window.removeEventListener('appinstalled', onInstalled); installButton.remove() })

  // The port is bound to whatever is available now; once the worker is ready it is
  // rebound to the registration, which is the only path that works on Android.
  let detachNotifications = attachGenerationNotifications(env.window, env.notifications, () => env.document.visibilityState === 'hidden')
  let disposed = false
  void notificationPortFor(env.navigator).then(port => {
    if (disposed || port === undefined) return
    detachNotifications()
    detachNotifications = attachGenerationNotifications(env.window, port, () => env.document.visibilityState === 'hidden')
  }).catch(() => undefined)
  disposers.push(() => { disposed = true; detachNotifications() })
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}

/**
 * Ask for notification permission. Browsers only accept this from a user
 * gesture, so it must be called from a click handler — `NotificationOptIn` is
 * that button. Never called on load: an unprompted permission dialog is the
 * fastest way to a permanent "denied".
 */
export async function enableGenerationNotifications(port?: NotificationPort | undefined): Promise<NotificationPermission | 'unsupported'> {
  if (port !== undefined) {
    if (port.permission === 'granted') return 'granted'
    return port.requestPermission()
  }
  // The request has to happen INSIDE the click: awaiting `serviceWorker.ready` first can outlive the
  // gesture, and a browser then refuses the prompt outright. The permission is asked here and now;
  // which port actually shows the notification is decided later, by the registration.
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

export { browserNotificationPort, notificationPortFor } from './notifications'
