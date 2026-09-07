import { ArrowLeft, MessageCircle, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import { openGovernedAssistant } from './assistantLaunch'
import { Conversation } from './Conversation'
import { ConversationRequestError, openConversation, type ConversationPort } from './conversationApi'

export const ASSISTANT_PATH = '/studio/assistente'

export interface AssistantEntryProps {
  readonly port?: ConversationPort
  readonly getCsrf?: () => Promise<string>
}

export function AssistantEntry({ port, getCsrf }: AssistantEntryProps = {}) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)

  const open = async () => {
    setOpening(true)
    setError(null)
    try {
      const opened = await openConversation(port, getCsrf)
      setConversationId(opened.session_id)
    } catch (reason) {
      setError(reason instanceof ConversationRequestError || reason instanceof Error ? reason.message : copy.openError)
    } finally {
      setOpening(false)
    }
  }

  const openInHarness = async () => {
    setError(null)
    try {
      await openGovernedAssistant()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.openError)
    }
  }

  if (conversationId !== null) {
    return <main className="assistant-entry">
      <Conversation
        conversationId={conversationId}
        {...(port === undefined ? {} : { port })}
        {...(getCsrf === undefined ? {} : { getCsrf })}
      />
      <a className="secondary assistant-link" href="/studio"><ArrowLeft aria-hidden="true" />{copy.back}</a>
    </main>
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
      <button className="secondary assistant-link" type="button" onClick={() => { void openInHarness() }}>
        {copy.openInHarness}
      </button>
      {error === null ? null : <p className="error" role="alert">{error}</p>}
      <a className="secondary assistant-link" href="/studio"><ArrowLeft aria-hidden="true" />{copy.back}</a>
    </section>
  </main>
}
