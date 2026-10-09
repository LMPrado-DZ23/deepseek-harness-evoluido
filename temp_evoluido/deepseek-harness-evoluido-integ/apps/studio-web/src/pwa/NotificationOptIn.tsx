import { Bell } from 'lucide-react'
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
export function NotificationOptIn({ enable = enableGenerationNotifications, compacto = false }: {
  enable?: typeof enableGenerationNotifications
  /**
   * `compacto` desenha um SINO em vez da frase, para o rodapé do trilho.
   *
   * O texto continua sendo o nome acessível, e os estados concedido/negado
   * continuam sendo ditos em palavras — eles só deixam de ocupar uma linha
   * inteira ao lado da conta, onde a referência tem um ícone.
   */
  compacto?: boolean
}) {
  const [state, setState] = useState<State>(() => (typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'idle'))
  if (state === 'unsupported') return null
  if (state === 'granted' || state === 'denied') {
    const frase = state === 'granted' ? t.notifications.granted : t.notifications.denied
    // Concedido e negado são ESTADOS, não ações: no rodapé eles viram um sino
    // com o estado no título, e não um botão que não faz nada ao ser clicado.
    if (compacto) return <span className="dz-rail-icone dz-rail-icone-estado" title={frase} role="status" aria-label={frase}><Bell aria-hidden="true" /></span>
    return <p className="pwa-notify-state" {...(state === 'granted' ? { role: 'status' } : {})}>{frase}</p>
  }
  return <button
    type="button"
    className={compacto ? 'dz-rail-icone' : 'pwa-notify'}
    {...(compacto ? { 'aria-label': t.notifications.enable, title: t.notifications.enable } : {})}
    disabled={state === 'asking'}
    onClick={() => {
      setState('asking')
      void enable().then(result => {
        setState(result === 'granted' ? 'granted' : result === 'unsupported' ? 'unsupported' : result === 'denied' ? 'denied' : 'idle')
      }).catch(() => setState('idle'))
    }}
  >{compacto ? <Bell aria-hidden="true" /> : t.notifications.enable}</button>
}
