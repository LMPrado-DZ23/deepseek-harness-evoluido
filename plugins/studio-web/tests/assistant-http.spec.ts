import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityError, SESSION_COOKIE, type StudioIdentityService } from '@dz23-studio/identity'
import {
  ASSISTANT_CONVERSATION_PREFIX,
  AssistantConversationError,
  createStudioWebHandler,
  routeAssistantConversation,
} from '../src/index.js'

const servers: ReturnType<typeof createServer>[] = []
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))))
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-conv-'))
  temporary.push(root)
  await writeFile(join(root, 'index.html'), '<main>DZ23 STUDIO</main>')
  const identity = {
    authenticate: vi.fn(() => Promise.resolve({ session_id: 'session-a', user_id: 'user-a' })),
    validateCsrfToken: vi.fn(),
  }
  const conversations = {
    open: vi.fn(async () => ({ session_id: 'conversa-1', reused: false, preset: 'dz23-assistant' as const })),
    snapshot: vi.fn(async () => ({ conversation_id: 'conversa-1', cursor: 2, events: [], truncated: false })),
    send: vi.fn(async () => ({ accepted: true as const, request_id: 'req-1' })),
    cancel: vi.fn(() => ({ accepted: true as const })),
  }
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const server = createServer(createStudioWebHandler({
    distDirectory: root,
    identity: identity as unknown as StudioIdentityService,
    allowedHosts,
    allowedOrigins,
    assistantConversations: conversations,
  }))
  servers.push(server)
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  allowedHosts.push(host)
  allowedOrigins.push(`http://${host}`)
  const request = (path: string, init: RequestInit = {}) => fetch(`http://${host}${path}`, {
    ...init,
    headers: {
      host, origin: `http://${host}`, cookie: `${SESSION_COOKIE}=token`, 'x-dz23-csrf': 'csrf',
      ...(init.headers ?? {}),
    },
  })
  return { request, identity, conversations, host }
}

const json = { 'content-type': 'application/json' }

describe('roteamento da conversa do assistente', () => {
  it('só reconhece as quatro formas previstas e recusa todo o resto', () => {
    expect(routeAssistantConversation('POST', ASSISTANT_CONVERSATION_PREFIX)).toEqual({ kind: 'open' })
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/events`))
      .toEqual({ kind: 'snapshot', conversationId: 'c1' })
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/messages`))
      .toEqual({ kind: 'send', conversationId: 'c1' })
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/cancel`))
      .toEqual({ kind: 'cancel', conversationId: 'c1' })
    // Fora do prefixo: o handler estático continua dono do caminho.
    expect(routeAssistantConversation('GET', '/studio/index.html')).toBeUndefined()
    expect(routeAssistantConversation('GET', '/studio/assistant/session')).toBeUndefined()
    // Método errado nunca vira outra ação.
    expect(routeAssistantConversation('GET', ASSISTANT_CONVERSATION_PREFIX)).toEqual({ kind: 'method-not-allowed' })
    expect(routeAssistantConversation('DELETE', `${ASSISTANT_CONVERSATION_PREFIX}/c1/messages`))
      .toEqual({ kind: 'method-not-allowed' })
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/events`))
      .toEqual({ kind: 'method-not-allowed' })
    // Identificador hostil, ação desconhecida e profundidade extra morrem na borda.
    for (const hostile of ['../../etc/passwd', '..', 'c1%00', 'a'.repeat(129), '', 'c 1', 'c1%2Fevents']) {
      expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/${hostile}/events`)?.kind)
        .not.toBe('snapshot')
    }
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/events/extra`))
      .toEqual({ kind: 'not-found' })
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/delete`))
      .toEqual({ kind: 'not-found' })
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1`))
      .toEqual({ kind: 'not-found' })
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/%E0%A4%A/events`))
      .toEqual({ kind: 'not-found' })
  })
})

describe('superfície HTTP da conversa do assistente', () => {
  it('abre, lê, envia e cancela sempre com a sessão do servidor, nunca com dado do cliente', async () => {
    const f = await fixture()
    const opened = await f.request(ASSISTANT_CONVERSATION_PREFIX, { method: 'POST' })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ session_id: 'conversa-1', reused: false, preset: 'dz23-assistant' })

    const snapshot = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/events`)
    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toMatchObject({ conversation_id: 'conversa-1', cursor: 2 })

    const sent = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/messages`, {
      method: 'POST', headers: json, body: JSON.stringify({ text: 'oi' }),
    })
    expect(sent.status).toBe(202)
    expect(await sent.json()).toEqual({ accepted: true, request_id: 'req-1' })

    const cancelled = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/cancel`, { method: 'POST' })
    expect(cancelled.status).toBe(202)

    // A identidade vem sempre do servidor: o serviço recebe a sessão autenticada.
    const identitySession = await f.identity.authenticate.mock.results[0]!.value as { session_id: string }
    const calls: Array<readonly unknown[]> = [
      f.conversations.snapshot.mock.calls[0] as unknown as readonly unknown[],
      f.conversations.send.mock.calls[0] as unknown as readonly unknown[],
      f.conversations.cancel.mock.calls[0] as unknown as readonly unknown[],
    ]
    for (const call of calls) expect(call[0]).toEqual(identitySession)
    expect(calls[1]![2]).toBe('oi')
  })

  it('exige sessão e CSRF em toda ação da conversa', async () => {
    const f = await fixture()
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'Entre para continuar.'))
    expect((await f.request(ASSISTANT_CONVERSATION_PREFIX, { method: 'POST' })).status).toBe(401)
    f.identity.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
    expect((await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/messages`, {
      method: 'POST', headers: json, body: JSON.stringify({ text: 'oi' }),
    })).status).toBe(401)
    expect(f.conversations.send).not.toHaveBeenCalled()
    // Host não confiável não chega ao serviço.
    const foreign = await fetch(`http://${f.host}${ASSISTANT_CONVERSATION_PREFIX}`, {
      method: 'POST', headers: { host: f.host, origin: 'https://evil.example', cookie: `${SESSION_COOKIE}=token` },
    })
    expect(foreign.status).toBe(401)
  })

  it('traduz a recusa do serviço sem vazar nada e sem inventar sucesso', async () => {
    const f = await fixture()
    const cases = [
      ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['INVALID_MESSAGE', 400], ['SESSION_UNAVAILABLE', 503],
    ] as const
    for (const [code, status] of cases) {
      f.conversations.snapshot.mockRejectedValueOnce(new AssistantConversationError(code, 'Mensagem do catálogo.'))
      const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/events`)
      expect(response.status, code).toBe(status)
      expect(await response.json()).toEqual({ error: 'Mensagem do catálogo.' })
    }
    // Erro inesperado não vira 200 nem entrega a mensagem interna.
    f.conversations.snapshot.mockRejectedValueOnce(new Error('ENOENT /home/pessoa/segredo'))
    const unexpected = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/events`)
    expect(unexpected.status).toBe(500)
    expect(await unexpected.text()).not.toContain('/home/pessoa/segredo')
  })

  it('recusa corpo que não seja exatamente {text}, corpo grande demais e corpo sem JSON', async () => {
    const f = await fixture()
    const bad: Array<[string, RequestInit]> = [
      ['sem content-type', { method: 'POST', body: JSON.stringify({ text: 'oi' }) }],
      ['json inválido', { method: 'POST', headers: json, body: '{' }],
      ['texto ausente', { method: 'POST', headers: json, body: JSON.stringify({}) }],
      ['texto não string', { method: 'POST', headers: json, body: JSON.stringify({ text: 42 }) }],
      ['campo extra', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', tier: 'T3' }) }],
      ['array', { method: 'POST', headers: json, body: JSON.stringify(['oi']) }],
      ['nulo', { method: 'POST', headers: json, body: 'null' }],
      ['grande demais', { method: 'POST', headers: json, body: JSON.stringify({ text: 'a'.repeat(70_000) }) }],
    ]
    for (const [label, init] of bad) {
      const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/messages`, init)
      expect(response.status, label).toBe(400)
    }
    expect(f.conversations.send).not.toHaveBeenCalled()
  })

  it('responde 503 explicado quando a conversa não está configurada nesta instalação', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-conv-off-'))
    temporary.push(root)
    await writeFile(join(root, 'index.html'), '<main>DZ23 STUDIO</main>')
    const identity = { authenticate: vi.fn(() => Promise.resolve({ session_id: 's' })), validateCsrfToken: vi.fn() }
    const allowedHosts: string[] = []
    const allowedOrigins: string[] = []
    const server = createServer(createStudioWebHandler({
      distDirectory: root, identity: identity as unknown as StudioIdentityService,
      allowedHosts, allowedOrigins,
    }))
    servers.push(server)
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
    allowedHosts.push(host)
    allowedOrigins.push(`http://${host}`)
    const response = await fetch(`http://${host}${ASSISTANT_CONVERSATION_PREFIX}`, {
      method: 'POST',
      headers: { host, origin: `http://${host}`, cookie: `${SESSION_COOKIE}=token`, 'x-dz23-csrf': 'csrf' },
    })
    expect(response.status).toBe(503)
    expect((await response.json() as { error: string }).error).toContain('não')
  })
})
