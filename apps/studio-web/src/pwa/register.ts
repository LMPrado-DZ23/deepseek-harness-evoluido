import t from '../i18n/pwa.pt-BR.json'
import { attachGenerationNotifications, browserNotificationPort, notificationPortFor, type NotificationPort } from './notifications'
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
  const resolved = port ?? await notificationPortFor(navigator)
  if (resolved === undefined) return 'unsupported'
  if (resolved.permission === 'granted') return 'granted'
  return resolved.requestPermission()
}

export { browserNotificationPort, notificationPortFor } from './notifications'
