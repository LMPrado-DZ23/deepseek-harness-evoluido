import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_PREFIX,
  ActionApprovalError,
  InMemoryActionApprovalRepository,
  StudioActionApprovalService,
  approvalStatus,
  handleApproval,
  routeApproval,
  type ApprovalActor,
  type ApprovalDescriptor,
} from '../src/index.js'

const FINGERPRINT = 'a'.repeat(64)
const ID = `apv-${'0'.repeat(64)}`
const actor: ApprovalActor = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }

function descriptor(): ApprovalDescriptor {
  return {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'staging.publish', subject_id: 'project-1', fingerprint: FINGERPRINT,
    tier: 'T2', request_id: 'req-1', summary: 'Publicar o projeto no ambiente de teste.',
  }
}

function fakeRequest(body = '{}'): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers: {}, method: 'POST' }) as unknown as IncomingMessage
}

function harness() {
  const repository = new InMemoryActionApprovalRepository()
  const service = new StudioActionApprovalService({
    repository, identity: { strongIdentityVerified: () => true },
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  })
  const authenticate = vi.fn(async () => actor)
  const assertCsrf = vi.fn()
  return { service, repository, config: { service, authenticate, assertCsrf }, authenticate, assertCsrf }
}

describe('M90-A — superfície HTTP', () => {
  it('não existe rota pública para CRIAR uma confirmação', () => {
    // Nenhum método, em nenhuma forma do prefixo, cria coisa alguma.
    for (const method of ['POST', 'PUT', 'PATCH', 'GET', 'DELETE']) {
      expect(routeApproval(method, `${APPROVAL_PREFIX}/create`)).toEqual({ kind: 'not-found' })
      expect(routeApproval(method, `${APPROVAL_PREFIX}/${ID}/request`)).toEqual({ kind: 'not-found' })
    }
    // O prefixo puro LÊ a lista de pendentes; nenhum método mutante existe ali.
    expect(routeApproval('GET', APPROVAL_PREFIX)).toEqual({ kind: 'list' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(routeApproval(method, APPROVAL_PREFIX)).toEqual({ kind: 'method-not-allowed' })
    }
    // As únicas formas que existem.
    expect(routeApproval('POST', `${APPROVAL_PREFIX}/${ID}/confirm`)).toEqual({ kind: 'confirm', approvalId: ID })
    expect(routeApproval('POST', `${APPROVAL_PREFIX}/${ID}/deny`)).toEqual({ kind: 'deny', approvalId: ID })
    expect(routeApproval('GET', `${APPROVAL_PREFIX}/${ID}`)).toEqual({ kind: 'read', approvalId: ID })
    // Fora do prefixo, o roteador não opina.
    expect(routeApproval('GET', '/studio/outro')).toBeUndefined()
  })

  it('lista somente os pedidos abertos de quem está perguntando, sem fingerprint', async () => {
    const h = harness()
    const pending = await h.service.request(descriptor())
    const confirmed = await h.service.request({ ...descriptor(), request_id: 'req-2', subject_id: 'project-2' })
    await h.service.confirm(actor, confirmed.approval_id)
    const denied = await h.service.request({ ...descriptor(), request_id: 'req-3', subject_id: 'project-3' })
    await h.service.deny(actor, denied.approval_id)
    // De outra pessoa, no mesmo armazenamento: nunca pode aparecer.
    await h.service.request({ ...descriptor(), user_id: 'user-2', request_id: 'req-4', subject_id: 'project-4' })

    const outcome = await handleApproval(fakeRequest(), routeApproval('GET', APPROVAL_PREFIX)!, h.config)
    expect(outcome.status).toBe(200)
    const body = outcome.body as { readonly approvals: readonly { readonly approval_id: string, readonly state: string }[] }
    expect(body.approvals.map(row => row.approval_id)).toEqual([pending.approval_id, confirmed.approval_id])
    expect(body.approvals.map(row => row.state)).toEqual(['PENDING', 'AVAILABLE'])
    expect(JSON.stringify(body)).not.toContain(FINGERPRINT)
    // Ler a lista não muda nada, então não exige CSRF.
    expect(h.assertCsrf).not.toHaveBeenCalled()
  })

  it('um pedido vencido some da lista e é expirado na leitura', async () => {
    const repository = new InMemoryActionApprovalRepository()
    let now = new Date('2026-09-07T12:00:00.000Z')
    const service = new StudioActionApprovalService({
      repository, identity: { strongIdentityVerified: () => true }, now: () => now,
    })
    const config = { service, authenticate: async () => actor, assertCsrf: () => {} }
    const created = await service.request(descriptor())
    now = new Date('2026-09-07T12:10:00.000Z')
    const outcome = await handleApproval(fakeRequest(), routeApproval('GET', APPROVAL_PREFIX)!, config)
    expect(outcome.body).toEqual({ approvals: [] })
    // O vencimento ficou GRAVADO: a próxima leitura já encontra EXPIRED.
    await expect(service.get(actor, created.approval_id)).resolves.toMatchObject({ state: 'EXPIRED' })
  })

  it('um pedido vencido some da lista mesmo quando não dá para gravar o vencimento', async () => {
    const repository = new InMemoryActionApprovalRepository()
    let now = new Date('2026-09-07T12:00:00.000Z')
    const service = new StudioActionApprovalService({
      repository, identity: { strongIdentityVerified: () => true }, now: () => now,
    })
    await service.request(descriptor())
    now = new Date('2026-09-07T12:10:00.000Z')
    // A gravação do vencimento falha. A lista não pode, por causa disso,
    // voltar a mostrar um pedido morto como confirmável.
    repository.interceptNextPut(() => { throw new Error('armazenamento indisponível') })
    await expect(service.listOpen(actor)).resolves.toEqual([])
  })

  it('um pedido vencido nunca volta como aberto: pedir de novo abre o próximo', async () => {
    const repository = new InMemoryActionApprovalRepository()
    let now = new Date('2026-09-07T12:00:00.000Z')
    const service = new StudioActionApprovalService({
      repository, identity: { strongIdentityVerified: () => true }, now: () => now,
    })
    const created = await service.request(descriptor())
    now = new Date('2026-09-07T12:10:00.000Z')
    // Sem ninguém abrir a tela: pedir de novo tem de ver EXPIRED, e não um
    // PENDING morto que prenderia o chamador apontando um id que a tela esconde.
    await expect(service.request(descriptor())).resolves.toMatchObject({
      approval_id: created.approval_id, state: 'EXPIRED',
    })
    await expect(service.listOpen(actor)).resolves.toEqual([])
  })

  it('grava o vencimento ao pedir de novo, e segue mesmo se a gravação falhar', async () => {
    const repository = new InMemoryActionApprovalRepository()
    let now = new Date('2026-09-07T12:00:00.000Z')
    const service = new StudioActionApprovalService({
      repository, identity: { strongIdentityVerified: () => true }, now: () => now,
    })
    await service.request(descriptor())
    now = new Date('2026-09-07T12:10:00.000Z')
    // A gravação do vencimento falha. O pedido AINDA tem de voltar como
    // EXPIRED: devolvê-lo como aberto prenderia o chamador num id morto.
    repository.interceptNextPut(() => { throw new Error('armazenamento indisponível') })
    await expect(service.request(descriptor())).resolves.toMatchObject({ state: 'EXPIRED' })
  })

  it('método trocado nunca vira outra ação e identificador hostil morre na borda', () => {
    expect(routeApproval('GET', `${APPROVAL_PREFIX}/${ID}/confirm`)).toEqual({ kind: 'method-not-allowed' })
    expect(routeApproval('POST', `${APPROVAL_PREFIX}/${ID}`)).toEqual({ kind: 'method-not-allowed' })
    expect(routeApproval('GET', `${APPROVAL_PREFIX}/${ID}/deny`)).toEqual({ kind: 'method-not-allowed' })
    expect(routeApproval('DELETE', `${APPROVAL_PREFIX}/${ID}/deny`)).toEqual({ kind: 'method-not-allowed' })
    for (const hostile of ['..', '../../etc', 'apv-curto', `${ID}extra`, '%E0%A4%A', '']) {
      expect(routeApproval('GET', `${APPROVAL_PREFIX}/${hostile}`)?.kind).not.toBe('read')
    }
    expect(routeApproval('POST', `${APPROVAL_PREFIX}/${ID}/confirm/extra`)).toEqual({ kind: 'not-found' })
  })

  it('POST exige CSRF e o cliente não escolhe nível, ação, sujeito nem "aprovado"', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    const route = routeApproval('POST', `${APPROVAL_PREFIX}/${created.approval_id}/confirm`)!

    // Corpo hostil tentando decidir tudo: é lido, descartado e ignorado.
    const hostile = fakeRequest(JSON.stringify({
      approved: true, tier: 'T3', action: 'staging.rollback', fingerprint: 'b'.repeat(64), org_id: 'org-2',
    }))
    const outcome = await handleApproval(hostile, route, h.config)
    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({
      approval_id: created.approval_id, state: 'AVAILABLE', action: 'staging.publish',
      subject_id: 'project-1', tier: 'T2', expires_at: created.expires_at,
      summary: 'Publicar o projeto no ambiente de teste.',
    })
    expect(h.assertCsrf).toHaveBeenCalledOnce()

    // O registro não foi contaminado por nada do corpo.
    expect(await h.service.get(actor, created.approval_id)).toMatchObject({
      tier: 'T2', action: 'staging.publish', org_id: 'org-1', fingerprint: FINGERPRINT,
    })
  })

  it('a leitura pública não devolve o fingerprint', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    const outcome = await handleApproval(
      fakeRequest(), routeApproval('GET', `${APPROVAL_PREFIX}/${created.approval_id}`)!, h.config,
    )
    expect(JSON.stringify(outcome.body)).not.toContain(FINGERPRINT)
    expect(h.assertCsrf).not.toHaveBeenCalled()
  })

  it('CSRF ausente aborta antes de qualquer efeito', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    h.assertCsrf.mockImplementationOnce(() => { throw new ActionApprovalError('FORBIDDEN', 'csrf') })
    await expect(handleApproval(
      fakeRequest(), routeApproval('POST', `${APPROVAL_PREFIX}/${created.approval_id}/confirm`)!, h.config,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await h.service.get(actor, created.approval_id)).toMatchObject({ state: 'PENDING' })
  })

  it('corpo grande demais é recusado sem tocar na confirmação', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    await expect(handleApproval(
      fakeRequest('x'.repeat(5 * 1024)),
      routeApproval('POST', `${APPROVAL_PREFIX}/${created.approval_id}/deny`)!,
      h.config,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await h.service.get(actor, created.approval_id)).toMatchObject({ state: 'PENDING' })
  })

  it('405 e 404 respondem sem autenticar nem tocar no serviço', async () => {
    const h = harness()
    expect(await handleApproval(fakeRequest(), { kind: 'method-not-allowed' }, h.config))
      .toEqual({ status: 405, body: { error: expect.stringContaining('não é permitida') } })
    expect(await handleApproval(fakeRequest(), { kind: 'not-found' }, h.config))
      .toEqual({ status: 404, body: { error: expect.stringContaining('não encontrada') } })
    expect(h.authenticate).not.toHaveBeenCalled()
  })

  it('cada recusa do serviço tem um código HTTP próprio e nenhuma delas vaza detalhe', async () => {
    const cases = [
      ['INVALID_REQUEST', 400], ['NOT_FOUND', 404], ['FORBIDDEN', 403], ['CONFLICT', 409],
      ['EXPIRED', 410], ['DENIED', 409], ['CONSUMED', 409], ['STRONG_IDENTITY_REQUIRED', 403],
    ] as const
    for (const [code, status] of cases) {
      expect(approvalStatus(new ActionApprovalError(code, 'mensagem')), code).toBe(status)
    }
    expect(approvalStatus(new Error('/home/pessoa/segredo'))).toBeUndefined()
  })

  it('negar pela rota também funciona e é terminal', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    const denied = await handleApproval(
      fakeRequest(), routeApproval('POST', `${APPROVAL_PREFIX}/${created.approval_id}/deny`)!, h.config,
    )
    expect(denied.body).toMatchObject({ state: 'DENIED' })
    await expect(handleApproval(
      fakeRequest(), routeApproval('POST', `${APPROVAL_PREFIX}/${created.approval_id}/confirm`)!, h.config,
    )).rejects.toMatchObject({ code: 'DENIED' })
  })
})
