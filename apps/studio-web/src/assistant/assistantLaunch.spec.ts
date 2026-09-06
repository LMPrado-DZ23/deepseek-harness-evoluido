import { describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_SESSION_ENDPOINT,
  HARNESS_AUTHENTICATION_PATH,
  HARNESS_SELECTION_STORAGE_KEY,
  openGovernedAssistant,
  type AssistantBrowserPort,
} from './assistantLaunch'

function port(response: Response) {
  const calls: string[] = []
  const value: AssistantBrowserPort = {
    fetch: vi.fn(async (input, init) => {
      calls.push(`${init.method}:${input}:${String((init.headers as Record<string, string>)['x-dz23-csrf'])}`)
      return response
    }),
    selectSession: sessionId => { calls.push(`select:${sessionId}`) },
    openHarness: () => { calls.push(`open:${HARNESS_AUTHENTICATION_PATH}`) },
  }
  return { calls, value }
}

describe('governed Assistant browser handoff', () => {
  it('stores the server-issued Session selection before entering the authenticated Harness', async () => {
    const browser = port(Response.json({ session_id: 'assistant-1', reused: false, preset: 'dz23-assistant' }))
    await expect(openGovernedAssistant(browser.value, async () => 'csrf-1')).resolves.toEqual({
      session_id: 'assistant-1', reused: false, preset: 'dz23-assistant',
    })
    expect(browser.calls).toEqual([
      `POST:${ASSISTANT_SESSION_ENDPOINT}:csrf-1`,
      'select:assistant-1',
      `open:${HARNESS_AUTHENTICATION_PATH}`,
    ])
    expect(HARNESS_SELECTION_STORAGE_KEY).toBe('dsh.sessions.current')
  })

  it('does not change selection or navigate on a server or contract failure', async () => {
    const denied = port(Response.json({ error: 'Projeto ainda não configurado.' }, { status: 503 }))
    await expect(openGovernedAssistant(denied.value, async () => 'csrf')).rejects.toThrow('Projeto ainda não configurado')
    expect(denied.calls).toEqual([`POST:${ASSISTANT_SESSION_ENDPOINT}:csrf`])

    const malformed = port(Response.json({ session_id: 'unsafe', reused: false, preset: 'outro' }))
    await expect(openGovernedAssistant(malformed.value, async () => 'csrf')).rejects.toThrow('perfil seguro')
    expect(malformed.calls).toHaveLength(1)

    const opaque = port(new Response('indisponível', { status: 500 }))
    await expect(openGovernedAssistant(opaque.value, async () => 'csrf')).rejects.toThrow('Não foi possível')
  })
})
