import { ArrowLeft, MessageCircle, ShieldCheck } from 'lucide-react'
import copy from '../i18n/assistant.pt-BR.json'

export const ASSISTANT_PATH = '/studio/assistente'
export const HARNESS_CHAT_PATH = '/'

export function AssistantEntry() {
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
      <a className="primary assistant-link" href={HARNESS_CHAT_PATH}>{copy.open}</a>
      <p className="coming">{copy.automaticSession}</p>
      <a className="secondary assistant-link" href="/studio"><ArrowLeft aria-hidden="true" />{copy.back}</a>
    </section>
  </main>
}
