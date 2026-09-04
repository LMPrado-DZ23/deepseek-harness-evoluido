import t from '../i18n/pwa.pt-BR.json'
import { attachGenerationNotifications, browserNotificationPort, type NotificationPort } from './notifications'
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
  const sync = () => { banner.hidden = env.navigator.onLine }
  sync()
  env.window.addEventListener('online', sync)
  env.window.addEventListener('offline', sync)
  disposers.push(() => { env.window.removeEventListener('online', sync); env.window.removeEventListener('offline', sync); banner.remove() })

  if ('serviceWorker' in env.navigator) {
    void env.navigator.serviceWorker.register('/studio/sw.js', { scope: '/studio/' }).catch(() => undefined)
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
  const onInstalled = () => { deferredPrompt = undefined; installButton.hidden = true; banner.textContent = t.install.installed; banner.hidden = false; env.window.setTimeout(sync, 4_000); banner.textContent = t.offline.banner }
  env.window.addEventListener('beforeinstallprompt', onBeforeInstall)
  env.window.addEventListener('appinstalled', onInstalled)
  disposers.push(() => { env.window.removeEventListener('beforeinstallprompt', onBeforeInstall); env.window.removeEventListener('appinstalled', onInstalled); installButton.remove() })

  disposers.push(attachGenerationNotifications(env.window, env.notifications, () => env.document.visibilityState === 'hidden'))
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}

/** Ask for notification permission from a user gesture; returns the resulting permission. */
export async function enableGenerationNotifications(port: NotificationPort | undefined = browserNotificationPort()): Promise<NotificationPermission | 'unsupported'> {
  if (port === undefined) return 'unsupported'
  if (port.permission === 'granted') return 'granted'
  return port.requestPermission()
}
