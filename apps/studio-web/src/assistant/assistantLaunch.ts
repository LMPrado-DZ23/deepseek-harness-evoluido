import { csrfToken } from '../api'

export const ASSISTANT_SESSION_ENDPOINT = '/studio/assistant/session'
export const HARNESS_AUTHENTICATION_PATH = '/api/studio/identity/harness/session'
export const HARNESS_SELECTION_STORAGE_KEY = 'dsh.sessions.current'

export interface AssistantLaunchResponse {
  readonly session_id: string
  readonly reused: boolean
  readonly preset: 'dz23-assistant'
}

export interface AssistantBrowserPort {
  fetch(input: string, init: RequestInit): Promise<Response>
  selectSession(sessionId: string): void
  openHarness(): void
}

const browserPort: AssistantBrowserPort = {
  fetch: (input, init) => fetch(input, init),
  selectSession: sessionId => {
    window.localStorage.setItem(HARNESS_SELECTION_STORAGE_KEY, JSON.stringify({ sessionId }))
  },
  openHarness: () => { window.location.assign(HARNESS_AUTHENTICATION_PATH) },
}

export async function openGovernedAssistant(
  port: AssistantBrowserPort = browserPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<AssistantLaunchResponse> {
  const response = await port.fetch(ASSISTANT_SESSION_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-dz23-csrf': await getCsrf(),
    },
    body: '{}',
  })
  const body = await response.json().catch(() => undefined) as (Partial<AssistantLaunchResponse> & { error?: string }) | undefined
  if (!response.ok) throw new Error(body?.error ?? 'Não foi possível abrir a conversa segura.')
  if (body?.preset !== 'dz23-assistant' || typeof body.session_id !== 'string' || body.session_id === '') {
    throw new Error('O servidor não confirmou o perfil seguro da conversa.')
  }
  port.selectSession(body.session_id)
  port.openHarness()
  return { session_id: body.session_id, reused: body.reused === true, preset: body.preset }
}
