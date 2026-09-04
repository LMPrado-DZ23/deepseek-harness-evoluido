import { useState } from 'react'
import t from '../i18n/pwa.pt-BR.json'
import { enableGenerationNotifications } from './register'

type State = 'idle' | 'asking' | 'granted' | 'denied' | 'unsupported'

/**
 * The one place that asks for notification permission, and only from a click:
 * browsers refuse the request outside a user gesture, and a dialog nobody asked
 * for is the fastest way to a permanent "denied". Whatever the browser answers
 * is said back in plain words — including "denied", which the person can only
 * undo in the browser's own settings.
 */
export function NotificationOptIn({ enable = enableGenerationNotifications }: { enable?: typeof enableGenerationNotifications }) {
  const [state, setState] = useState<State>(() => (typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'idle'))
  if (state === 'unsupported') return null
  if (state === 'granted') return <p className="pwa-notify-state" role="status">{t.notifications.granted}</p>
  if (state === 'denied') return <p className="pwa-notify-state">{t.notifications.denied}</p>
  return <button
    type="button"
    className="pwa-notify"
    disabled={state === 'asking'}
    onClick={() => {
      setState('asking')
      void enable().then(result => {
        setState(result === 'granted' ? 'granted' : result === 'unsupported' ? 'unsupported' : result === 'denied' ? 'denied' : 'idle')
      }).catch(() => setState('idle'))
    }}
  >{t.notifications.enable}</button>
}
