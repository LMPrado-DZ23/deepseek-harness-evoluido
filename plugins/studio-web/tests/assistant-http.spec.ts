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

async function fixture(deadlineMs?: number) {
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
    compact: vi.fn(() => Promise.resolve({ accepted: true as const, organized: true, items: 4, tokens: 900 })),
    attach: vi.fn(async (_session: unknown, _id: unknown, filename: string, bytes: Buffer) => ({
      attachment_id: 'ref-1', name: filename, size: bytes.length, media_type: 'text/plain' as const,
    })),
  }
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const server = createServer(createStudioWebHandler({
    distDirectory: root,
    identity: identity as unknown as StudioIdentityService,
    allowedHosts,
    allowedOrigins,
    assistantConversations: conversations,
    ...(deadlineMs === undefined ? {} : { assistantDeadlineMs: deadlineMs }),
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

  it('erro numa rota da conversa responde JSON, não texto solto', async () => {
    const f = await fixture()
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'Entre para continuar.'))
    const response = await f.request(ASSISTANT_CONVERSATION_PREFIX, { method: 'POST' })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    // O cliente lê `error`; com texto solto a pessoa veria uma mensagem genérica
    // em vez de "entre de novo".
    expect(await response.json()).toEqual({ error: 'Entre para continuar.' })
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
      ['content-type errado', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }],
      ['json inválido', { method: 'POST', headers: json, body: '{' }],
      ['texto ausente', { method: 'POST', headers: json, body: JSON.stringify({}) }],
      ['texto não string', { method: 'POST', headers: json, body: JSON.stringify({ text: 42 }) }],
      ['campo extra', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', tier: 'T3' }) }],
      // A garantia continua existindo na forma NOVA: `{text}` e
      // `{text, attachments}` passam, e absolutamente nada mais.
      ['campo extra junto do anexo', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', attachments: ['a'], tier: 'T3' }) }],
      ['anexo sem texto', { method: 'POST', headers: json, body: JSON.stringify({ attachments: ['a'] }) }],
      ['anexo que não é lista', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', attachments: 'a' }) }],
      ['lista de anexos vazia', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', attachments: [] }) }],
      ['anexo que não é string', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', attachments: [7] }) }],
      ['anexo com caminho dentro', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', attachments: ['../outra/ref'] }) }],
      ['anexos demais', { method: 'POST', headers: json, body: JSON.stringify({ text: 'oi', attachments: ['a', 'b', 'c', 'd', 'e', 'f'] }) }],
      ['chave herdada não conta como chave própria', { method: 'POST', headers: json, body: '{"text":"oi","__proto__":{"attachments":["a"]},"x":1}' }],
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

  it('devolve 405 e 404 pelo servidor real, sem tocar no serviço', async () => {
    const f = await fixture()
    const notAllowed = await f.request(ASSISTANT_CONVERSATION_PREFIX, { method: 'PUT' })
    expect(notAllowed.status).toBe(405)
    expect(await notAllowed.json()).toEqual({ error: expect.stringContaining('não é permitida') })
    const notFound = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/apagar`, { method: 'POST' })
    expect(notFound.status).toBe(404)
    const traversal = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/..%2F..%2Fetc/events`)
    expect(traversal.status).toBe(404)
    for (const call of [f.conversations.open, f.conversations.snapshot, f.conversations.send, f.conversations.cancel]) {
      expect(call).not.toHaveBeenCalled()
    }
  })

  it('aborta a leitura quando o prazo estoura, em vez de segurar o turno da pessoa', async () => {
    const f = await fixture(5)
    type Snapshot = Awaited<ReturnType<typeof f.conversations.snapshot>>
    f.conversations.snapshot.mockImplementation(((_session: unknown, _id: unknown, signal?: AbortSignal) => (
      new Promise<Snapshot>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new AssistantConversationError('SESSION_UNAVAILABLE', 'Tempo esgotado.'))
        })
      })
    )) as typeof f.conversations.snapshot)
    const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/events`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Tempo esgotado.' })
  })

  it('recusa GET em cancelar e método trocado em cada ação', () => {
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/cancel`))
      .toEqual({ kind: 'method-not-allowed' })
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/messages`))
      .toEqual({ kind: 'method-not-allowed' })
  })

  it('organizar a conversa é uma rota própria, só por POST, e passa a sessão do servidor', async () => {
    // Antes, "Organizar conversa agora" ia por /messages como se fosse texto da
    // pessoa. Sendo rota própria, ela é autenticada, tem CSRF e não pode ser
    // confundida com uma mensagem.
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/compact`))
      .toEqual({ kind: 'compact', conversationId: 'c1' })
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/compact`))
      .toEqual({ kind: 'method-not-allowed' })

    const f = await fixture()
    const organized = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/compact`, { method: 'POST' })
    expect(organized.status).toBe(202)
    expect(await organized.json()).toEqual({ accepted: true, organized: true, items: 4, tokens: 900 })
    const identitySession = await f.identity.authenticate.mock.results[0]!.value as { session_id: string }
    expect((f.conversations.compact.mock.calls[0] as unknown as readonly unknown[])[0]).toEqual(identitySession)
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

describe('anexos pela borda HTTP', () => {
  const PNG64 = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('pixels'),
  ]).toString('base64')

  it('anexar é rota própria, só por POST, e nunca uma rota de leitura', () => {
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/attachments`))
      .toEqual({ kind: 'attach', conversationId: 'c1' })
    // GET devolveria o arquivo de volta e transformaria a referência opaca num
    // endereço de download - exatamente o que ela existe para não ser.
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/attachments`))
      .toEqual({ kind: 'method-not-allowed' })
    expect(routeAssistantConversation('DELETE', `${ASSISTANT_CONVERSATION_PREFIX}/c1/attachments`))
      .toEqual({ kind: 'method-not-allowed' })
    // E não existe endereço por anexo: um segundo segmento é 404.
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/attachments/ref-1`))
      .toEqual({ kind: 'not-found' })
  })

  it('anexa com a sessão do servidor e devolve 201 com a referência opaca', async () => {
    const f = await fixture()
    const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ filename: 'desenho.png', content_base64: PNG64 }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      attachment_id: 'ref-1', name: 'desenho.png', size: 14, media_type: 'text/plain',
    })
    const identitySession = await f.identity.authenticate.mock.results[0]!.value as { session_id: string }
    const call = f.conversations.attach.mock.calls[0] as unknown as readonly unknown[]
    expect(call[0]).toEqual(identitySession)
    expect(call[1]).toBe('conversa-1')
    // Os BYTES chegam ao serviço, não o base64 nem um caminho.
    expect(Buffer.isBuffer(call[3])).toBe(true)
  })

  it('exige CSRF e sessão para anexar, como qualquer outra mutação', async () => {
    const f = await fixture()
    f.identity.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
    const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ filename: 'a.txt', content_base64: 'b2k=' }),
    })
    expect(response.status).toBe(401)
    expect(f.conversations.attach).not.toHaveBeenCalled()
  })

  it('recusa todo corpo de anexo que não seja exatamente {filename, content_base64}', async () => {
    const f = await fixture()
    const bad: Array<[string, unknown]> = [
      ['sem nome', { content_base64: PNG64 }],
      ['sem conteúdo', { filename: 'a.png' }],
      ['nome vazio', { filename: '', content_base64: PNG64 }],
      ['nome imenso', { filename: 'a'.repeat(4097), content_base64: PNG64 }],
      ['nome não string', { filename: 7, content_base64: PNG64 }],
      ['conteúdo não string', { filename: 'a.png', content_base64: 7 }],
      // O tipo declarado pelo cliente NÃO existe no contrato: aceitá-lo seria
      // deixar quem envia escolher em que gaveta o arquivo cai.
      ['tipo declarado pelo cliente', { filename: 'a.png', content_base64: PNG64, content_type: 'image/png' }],
      ['caminho declarado pelo cliente', { filename: 'a.png', content_base64: PNG64, path: '/tmp/a.png' }],
      ['identificador escolhido pelo cliente', { filename: 'a.png', content_base64: PNG64, attachment_id: 'ref-9' }],
      // `Buffer.from(..., 'base64')` engole lixo em silêncio; a borda não.
      ['base64 inválido', { filename: 'a.png', content_base64: 'não é base64!!' }],
      ['base64 truncado', { filename: 'a.png', content_base64: 'QQ' }],
    ]
    for (const [label, body] of bad) {
      const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
        method: 'POST', headers: json, body: JSON.stringify(body),
      })
      expect(response.status, label).toBe(400)
    }
    expect(f.conversations.attach).not.toHaveBeenCalled()
  })

  it('o corpo do anexo tem teto próprio: maior que o da mensagem, e ainda assim finito', async () => {
    const f = await fixture()
    // 600 KB de base64 passariam pelo teto do anexo e morreriam no da mensagem
    // se os dois fossem o mesmo número.
    const grande = 'A'.repeat(600 * 1024)
    const aceito = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST', headers: json, body: JSON.stringify({ filename: 'g.bin', content_base64: grande }),
    })
    expect(aceito.status).toBe(201)
    // E o teto do anexo continua sendo um teto.
    const demais = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST', headers: json, body: JSON.stringify({ filename: 'g.bin', content_base64: 'A'.repeat(1_100 * 1024) }),
    })
    expect(demais.status).toBe(400)
  })

  it('a mensagem carrega a referência, e a referência chega ao serviço como referência', async () => {
    const f = await fixture()
    const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/messages`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ text: 'veja', attachments: ['ref-1', 'ref-2'] }),
    })
    expect(response.status).toBe(202)
    const call = f.conversations.send.mock.calls[0] as unknown as readonly unknown[]
    expect(call[2]).toBe('veja')
    expect(call[4]).toEqual(['ref-1', 'ref-2'])
  })

  it('instalação sem anexos responde 503 explicado, em vez de aceitar e descartar', async () => {
    const f = await fixture()
    const { attach: _ignored, ...semAnexos } = f.conversations
    const root = await mkdtemp(join(tmpdir(), 'dz23-conv-noattach-'))
    temporary.push(root)
    await writeFile(join(root, 'index.html'), '<main>DZ23 STUDIO</main>')
    const identity = { authenticate: vi.fn(() => Promise.resolve({ session_id: 's' })), validateCsrfToken: vi.fn() }
    const allowedHosts: string[] = []
    const allowedOrigins: string[] = []
    const server = createServer(createStudioWebHandler({
      distDirectory: root, identity: identity as unknown as StudioIdentityService,
      allowedHosts, allowedOrigins, assistantConversations: semAnexos,
    }))
    servers.push(server)
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
    allowedHosts.push(host)
    allowedOrigins.push(`http://${host}`)
    const response = await fetch(`http://${host}${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST',
      headers: { host, origin: `http://${host}`, cookie: `${SESSION_COOKIE}=token`, 'x-dz23-csrf': 'csrf', ...json },
      body: JSON.stringify({ filename: 'a.txt', content_base64: 'b2k=' }),
    })
    expect(response.status).toBe(503)
  })

  it('a recusa do serviço atravessa traduzida e sem vazar nada do disco', async () => {
    const f = await fixture()
    f.conversations.attach.mockRejectedValueOnce(
      new AssistantConversationError('INVALID_MESSAGE', 'Este tipo de arquivo não é aceito.'),
    )
    const response = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST', headers: json, body: JSON.stringify({ filename: 'a.bin', content_base64: 'b2k=' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Este tipo de arquivo não é aceito.' })

    f.conversations.attach.mockRejectedValueOnce(new Error('EACCES /var/lib/studio/uploads'))
    const inesperado = await f.request(`${ASSISTANT_CONVERSATION_PREFIX}/conversa-1/attachments`, {
      method: 'POST', headers: json, body: JSON.stringify({ filename: 'a.bin', content_base64: 'b2k=' }),
    })
    expect(inesperado.status).toBe(500)
    expect(await inesperado.text()).not.toContain('/var/lib/studio')
  })
})
