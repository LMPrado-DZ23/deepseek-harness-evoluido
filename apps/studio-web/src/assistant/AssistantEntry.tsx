import { ArrowLeft, MessageCircle, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import { openGovernedAssistant } from './assistantLaunch'

export const ASSISTANT_PATH = '/studio/assistente'

export function AssistantEntry() {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    setOpening(true)
    setError(null)
    try {
      await openGovernedAssistant()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.openError)
      setOpening(false)
    }
  }

  return <main className="assistant-entry">
    <section className="task-card assistant-card">
      <MessageCircle aria-hidden="true" />
      <h1>{copy.title}</h1>
      <p>{copy.subtitle}</p>
      <p className="context-note">{copy.reuse}</p>
      <section aria-labelledby="assistant-safety-title">
        <h2 id="assistant-safety-title"><ShieldCheck aria-hidden="true" />{copy.safetyTitle}</h2>
        <ul>{copy.safetyItems.map(item => <li key={item}>{item}</li>)}</ul>
      </section>
      <button className="primary assistant-link" type="button" disabled={opening} onClick={() => { void open() }}>
        {opening ? copy.opening : copy.open}
      </button>
      <p className="coming">{copy.automaticSession}</p>
      {error === null ? null : <p className="error" role="alert">{error}</p>}
      <a className="secondary assistant-link" href="/studio"><ArrowLeft aria-hidden="true" />{copy.back}</a>
    </section>
  </main>
}
