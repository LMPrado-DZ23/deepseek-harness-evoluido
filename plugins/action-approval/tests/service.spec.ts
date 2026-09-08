import { describe, expect, it } from 'vitest'
import {
  ActionApprovalError,
  APPROVAL_TTL_MS,
  InMemoryActionApprovalRepository,
  StudioActionApprovalService,
  approvalId,
  assertValidApproval,
  type ApprovalActor,
  type ApprovalDescriptor,
  type ApprovalRecord,
} from '../src/index.js'

const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)
const START = Date.parse('2026-09-07T12:00:00.000Z')

const actor: ApprovalActor = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }

function descriptor(overrides: Partial<ApprovalDescriptor> = {}): ApprovalDescriptor {
  return {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'staging.publish', subject_id: 'project-1', fingerprint: FINGERPRINT,
    tier: 'T2', request_id: 'req-1', summary: 'Publicar o projeto no ambiente de teste.', ...overrides,
  }
}

function harness(options: { strongIdentity?: boolean } = {}) {
  const repository = new InMemoryActionApprovalRepository()
  let clock = START
  const service = new StudioActionApprovalService({
    repository,
    identity: { strongIdentityVerified: () => options.strongIdentity ?? true },
    now: () => new Date(clock),
  })
  return { repository, service, advance: (ms: number) => { clock += ms }, at: () => clock }
}

async function available(h: ReturnType<typeof harness>, overrides: Partial<ApprovalDescriptor> = {}) {
  const created = await h.service.request(descriptor(overrides))
  await h.service.confirm({ ...actor, ...actorOf(overrides) }, created.approval_id)
  return created.approval_id
}

function actorOf(overrides: Partial<ApprovalDescriptor>): Partial<ApprovalActor> {
  return {
    ...(overrides.user_id === undefined ? {} : { userId: overrides.user_id }),
    ...(overrides.org_id === undefined ? {} : { orgId: overrides.org_id }),
    ...(overrides.tenant_id === undefined ? {} : { tenantId: overrides.tenant_id }),
    ...(overrides.session_id === undefined ? {} : { sessionId: overrides.session_id }),
  }
}

const claim = (approval: string, overrides: Record<string, unknown> = {}) => ({
  actor, approvalId: approval, claimId: 'release-1', action: 'staging.publish',
  subjectId: 'project-1', fingerprint: FINGERPRINT, tier: 'T2' as const, ...overrides,
})

describe('M90-A — autoridade genérica de confirmação', () => {
  it('o pedido exato é idempotente e o mesmo request_id com descritor diferente conflita', async () => {
    const h = harness()
    const first = await h.service.request(descriptor())
    const again = await h.service.request(descriptor())
    expect(again).toEqual(first)
    expect(first.approval_id).toBe(approvalId(descriptor()))
    expect(h.repository.size()).toBe(1)

    for (const changed of [{ action: 'staging.rollback' }, { subject_id: 'project-2' }, { fingerprint: OTHER_FINGERPRINT }, { tier: 'T3' as const }]) {
      await expect(h.service.request(descriptor(changed)))
        .rejects.toMatchObject({ code: 'CONFLICT' })
    }
    // O conflito não estraga o pedido original.
    expect(await h.service.get(actor, first.approval_id)).toEqual(first)
  })

  it('outro usuário, sessão, organização ou inquilino recebe o mesmo "não existe"', async () => {
    const h = harness()
    const id = await available(h)
    const strangers: ReadonlyArray<readonly [string, ApprovalActor]> = [
      ['outro usuário', { ...actor, userId: 'user-2' }],
      ['outra sessão', { ...actor, sessionId: 'session-2' }],
      ['outra organização', { ...actor, orgId: 'org-2' }],
      ['outro inquilino', { ...actor, tenantId: 'tenant-2' }],
    ]
    for (const [label, stranger] of strangers) {
      await expect(h.service.get(stranger, id), label).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(h.service.confirm(stranger, id), label).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(h.service.deny(stranger, id), label).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(h.service.consume(claim(id, { actor: stranger })), label).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    // A mensagem de um id inexistente é exatamente a mesma: nada revela que o
    // pedido existe para outra pessoa.
    const invented = `apv-${'c'.repeat(64)}`
    const strangerError = await h.service.get(strangers[0]![1], id).catch((error: unknown) => error) as ActionApprovalError
    const missingError = await h.service.get(actor, invented).catch((error: unknown) => error) as ActionApprovalError
    expect(strangerError.message).toBe(missingError.message)
    expect(strangerError.code).toBe(missingError.code)
  })

  it('T3 sem passkey recente falha fechado e NÃO consome o pedido', async () => {
    const weak = harness({ strongIdentity: false })
    const created = await weak.service.request(descriptor({ tier: 'T3', request_id: 'req-t3' }))
    await expect(weak.service.confirm(actor, created.approval_id))
      .rejects.toMatchObject({ code: 'STRONG_IDENTITY_REQUIRED' })
    // Continua PENDING: a pessoa pode confirmar depois de usar a chave.
    expect(await weak.service.get(actor, created.approval_id)).toMatchObject({ state: 'PENDING' })

    const strong = harness({ strongIdentity: true })
    const other = await strong.service.request(descriptor({ tier: 'T3', request_id: 'req-t3' }))
    await expect(strong.service.confirm(actor, other.approval_id)).resolves.toMatchObject({ state: 'AVAILABLE' })
  })

  it('expira antes e depois da confirmação, e expirar é terminal', async () => {
    const before = harness()
    const pending = await before.service.request(descriptor())
    before.advance(APPROVAL_TTL_MS)
    await expect(before.service.confirm(actor, pending.approval_id)).rejects.toMatchObject({ code: 'EXPIRED' })
    // Depois de expirado, LER continua funcionando e conta a verdade: a tela
    // precisa poder dizer "o tempo acabou" em vez de "não existe".
    expect(await before.service.get(actor, pending.approval_id)).toMatchObject({ state: 'EXPIRED' })
    await expect(before.service.consume(claim(pending.approval_id))).rejects.toMatchObject({ code: 'EXPIRED' })
    await expect(before.service.deny(actor, pending.approval_id)).rejects.toMatchObject({ code: 'EXPIRED' })

    const after = harness()
    const id = await available(after)
    after.advance(APPROVAL_TTL_MS)
    await expect(after.service.consume(claim(id))).rejects.toMatchObject({ code: 'EXPIRED' })
  })

  it('negar não se desfaz e consumido não pode ser negado', async () => {
    const h = harness()
    const id = await available(h)
    await h.service.deny(actor, id)
    // Negar de novo é idempotente, não é erro nem reversão.
    expect(await h.service.deny(actor, id)).toMatchObject({ state: 'DENIED' })
    await expect(h.service.confirm(actor, id)).rejects.toMatchObject({ code: 'DENIED' })
    await expect(h.service.consume(claim(id))).rejects.toMatchObject({ code: 'DENIED' })

    const used = harness()
    const other = await available(used)
    await used.service.consume(claim(other))
    await expect(used.service.deny(actor, other)).rejects.toMatchObject({ code: 'CONSUMED' })
    await expect(used.service.confirm(actor, other)).rejects.toMatchObject({ code: 'CONSUMED' })
  })

  it('o consumo exato é idempotente e sobrevive a recriar serviço e repositório-cliente', async () => {
    const h = harness()
    const id = await available(h)
    const first = await h.service.consume(claim(id))
    expect(first).toMatchObject({ approval_id: id, claim_id: 'release-1', tier: 'T2' })

    // Mesma reivindicação: mesmo recibo, sem segundo efeito.
    expect(await h.service.consume(claim(id))).toEqual(first)

    // Serviço novo sobre o MESMO armazenamento durável: mesmo recibo.
    const revived = new StudioActionApprovalService({
      repository: h.repository,
      identity: { strongIdentityVerified: () => true },
      now: () => new Date(h.at()),
    })
    expect(await revived.consume(claim(id))).toEqual(first)
  })

  it('claim, fingerprint, ação, sujeito ou nível divergente falha fechado', async () => {
    const h = harness()
    const id = await available(h)
    const divergences: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['fingerprint', { fingerprint: OTHER_FINGERPRINT }],
      ['ação', { action: 'staging.rollback' }],
      ['sujeito', { subjectId: 'project-2' }],
      ['nível', { tier: 'T3' as const }],
    ]
    for (const [label, change] of divergences) {
      await expect(h.service.consume(claim(id, change)), label).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    // Nenhuma tentativa divergente consumiu a confirmação.
    expect(await h.service.get(actor, id)).toMatchObject({ state: 'AVAILABLE' })

    // Depois de consumida por uma reivindicação, outra reivindicação é recusada.
    await h.service.consume(claim(id))
    await expect(h.service.consume(claim(id, { claimId: 'release-2' })))
      .rejects.toMatchObject({ code: 'CONSUMED' })
  })

  it('não existe consumo de pedido só pendente', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    await expect(h.service.consume(claim(created.approval_id)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('duas confirmações e dois consumos concorrentes não criam dois recibos', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    const confirms = await Promise.allSettled([
      h.service.confirm(actor, created.approval_id),
      h.service.confirm(actor, created.approval_id),
    ])
    expect(confirms.filter(result => result.status === 'fulfilled')).toHaveLength(1)

    const consumes = await Promise.allSettled([
      h.service.consume(claim(created.approval_id)),
      h.service.consume(claim(created.approval_id)),
    ])
    const receipts = consumes.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    expect(receipts.length).toBeGreaterThanOrEqual(1)
    for (const receipt of receipts) expect(receipt).toEqual(receipts[0])
    expect(await h.service.get(actor, created.approval_id)).toMatchObject({ state: 'CONSUMED', claim_id: 'release-1' })
  })

  it('a correção NÃO depende de escrita condicional: sem ela, ainda há um só recibo', async () => {
    // Este repositório se comporta como o seam real de domínio: `put(chave,
    // valor)`, sem "grave só se o estado ainda for X". Quem segura a corrida
    // aqui é o mutex do serviço, e é exatamente isso que este teste prova.
    const repository = new InMemoryActionApprovalRepository(false)
    const service = new StudioActionApprovalService({
      repository, identity: { strongIdentityVerified: () => true }, now: () => new Date(START),
    })
    const created = await service.request(descriptor())
    const confirms = await Promise.allSettled([
      service.confirm(actor, created.approval_id),
      service.confirm(actor, created.approval_id),
    ])
    expect(confirms.filter(result => result.status === 'fulfilled')).toHaveLength(1)

    const consumes = await Promise.allSettled([
      service.consume(claim(created.approval_id)),
      service.consume(claim(created.approval_id, { claimId: 'release-rival' })),
    ])
    const receipts = consumes.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    // Uma confirmação vale por UMA ação: a segunda reivindicação é recusada.
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ claim_id: 'release-1' })
    const stored = await service.get(actor, created.approval_id)
    expect(stored).toMatchObject({ state: 'CONSUMED', claim_id: 'release-1' })
  })

  it('dois pedidos concorrentes com o mesmo descritor convergem para um só', async () => {
    const h = harness()
    const [first, second] = await Promise.all([
      h.service.request(descriptor()),
      h.service.request(descriptor()),
    ])
    expect(second).toEqual(first)
    expect(h.repository.size()).toBe(1)
  })

  it('exceção do armazenamento permanece exceção, nunca vira aprovação nem negação', async () => {
    const h = harness()
    const id = await available(h)
    const boom = new Error('armazenamento indisponível')
    h.repository.failNext(boom)
    await expect(h.service.consume(claim(id))).rejects.toBe(boom)
    // O pedido continua utilizável: a falha não decidiu nada.
    expect(await h.service.get(actor, id)).toMatchObject({ state: 'AVAILABLE' })

    // Falha que não é conflito na ESCRITA do consumo também sobe intacta.
    const writing = harness()
    const writingId = await available(writing)
    writing.repository.interceptNextPut(() => { throw boom })
    await expect(writing.service.consume(claim(writingId))).rejects.toBe(boom)

    // E na criação do pedido, idem: nenhum pedido nasce de uma falha.
    const creating = harness()
    creating.repository.interceptNextPut(() => { throw boom })
    await expect(creating.service.request(descriptor())).rejects.toBe(boom)
    expect(creating.repository.size()).toBe(0)
  })

  it('o modelo recusa registro corrompido em vez de deixá-lo virar aprovação', () => {
    const base: ApprovalRecord = {
      ...descriptor(), approval_id: approvalId(descriptor()), state: 'AVAILABLE', claim_id: null,
      created_at: new Date(START).toISOString(), expires_at: new Date(START + APPROVAL_TTL_MS).toISOString(),
      confirmed_at: new Date(START).toISOString(), consumed_at: null, denied_at: null,
    }
    expect(() => { assertValidApproval(base) }).not.toThrow()
    const corrupted: readonly ApprovalRecord[] = [
      { ...base, state: 'PENDING' },
      { ...base, state: 'CONSUMED' },
      { ...base, state: 'CONSUMED', consumed_at: base.confirmed_at, claim_id: null },
      { ...base, state: 'CONSUMED', consumed_at: base.confirmed_at, claim_id: 'r', confirmed_at: null },
      { ...base, state: 'DENIED' },
      { ...base, state: 'EXPIRED', denied_at: base.confirmed_at },
      { ...base, expires_at: base.created_at },
      { ...base, state: 'CONSUMED', claim_id: 'r', consumed_at: new Date(START - 1).toISOString() },
      { ...base, confirmed_at: new Date(START - 1).toISOString() },
      { ...base, state: 'AVAILABLE', confirmed_at: null },
      { ...base, fingerprint: 'curto' },
      { ...base, state: 'DENIED', denied_at: base.confirmed_at, consumed_at: base.confirmed_at, claim_id: 'r' },
    ]
    for (const record of corrupted) {
      expect(() => { assertValidApproval(record) }, JSON.stringify(record.state)).toThrow()
    }
  })

  it('quem perde a corrida da criação aceita o vencedor, e só se ele for o mesmo pedido', async () => {
    const h = harness()
    const winner: ApprovalRecord = {
      ...descriptor(), approval_id: approvalId(descriptor()), state: 'PENDING', claim_id: null,
      created_at: new Date(START).toISOString(), expires_at: new Date(START + APPROVAL_TTL_MS).toISOString(),
      confirmed_at: null, consumed_at: null, denied_at: null,
    }
    h.repository.interceptNextPut(() => { h.repository.seed(winner) })
    expect(await h.service.request(descriptor())).toEqual(winner)

    // Agora o vencedor é OUTRO pedido com o mesmo id: isso é conflito, não
    // "aceita o que estiver lá".
    const other = harness()
    other.repository.interceptNextPut(() => {
      other.repository.seed({ ...winner, action: 'staging.rollback' })
    })
    await expect(other.service.request(descriptor())).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('quem perde a corrida do consumo só recebe recibo se for a MESMA reivindicação', async () => {
    const h = harness()
    const id = await available(h)
    const current = await h.service.get(actor, id)
    const consumedBySomeoneElse: ApprovalRecord = {
      ...current, state: 'CONSUMED', claim_id: 'release-1', consumed_at: new Date(START).toISOString(),
    }
    h.repository.interceptNextPut(() => { h.repository.seed(consumedBySomeoneElse) })
    expect(await h.service.consume(claim(id))).toMatchObject({ claim_id: 'release-1' })

    const rival = harness()
    const rivalId = await available(rival)
    const rivalCurrent = await rival.service.get(actor, rivalId)
    rival.repository.interceptNextPut(() => {
      rival.repository.seed({
        ...rivalCurrent, state: 'CONSUMED', claim_id: 'release-outra', consumed_at: new Date(START).toISOString(),
      })
    })
    await expect(rival.service.consume(claim(rivalId))).rejects.toMatchObject({ code: 'CONSUMED' })

    // Vencedor num estado que não é consumo (negado sob a corrida): recusa.
    const denied = harness()
    const deniedId = await available(denied)
    const deniedCurrent = await denied.service.get(actor, deniedId)
    denied.repository.interceptNextPut(() => {
      denied.repository.seed({ ...deniedCurrent, state: 'DENIED', denied_at: new Date(START).toISOString() })
    })
    await expect(denied.service.consume(claim(deniedId))).rejects.toMatchObject({ code: 'CONSUMED' })

    // A linha some sob a corrida: recusa, nunca recibo inventado.
    const vanished = harness()
    const vanishedId = await available(vanished)
    vanished.repository.interceptNextPut(() => { vanished.repository.forget(vanishedId) })
    await expect(vanished.service.consume(claim(vanishedId))).rejects.toMatchObject({ code: 'CONSUMED' })
  })

  it('expirar sob concorrência não engole o resultado: continua expirado', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    h.advance(APPROVAL_TTL_MS)
    h.repository.interceptNextPut(() => {
      h.repository.seed({ ...created, state: 'DENIED', denied_at: new Date(START).toISOString() })
    })
    await expect(h.service.confirm(actor, created.approval_id)).rejects.toMatchObject({ code: 'EXPIRED' })

    // Falha que NÃO é conflito, durante a expiração, sobe: não é engolida.
    const broken = harness()
    const other = await broken.service.request(descriptor())
    broken.advance(APPROVAL_TTL_MS)
    const boom = new Error('armazenamento indisponível')
    broken.repository.interceptNextPut(() => { throw boom })
    await expect(broken.service.confirm(actor, other.approval_id)).rejects.toBe(boom)
  })

  it('sem relógio injetado o serviço usa a hora real', async () => {
    const repository = new InMemoryActionApprovalRepository()
    const service = new StudioActionApprovalService({
      repository, identity: { strongIdentityVerified: () => true },
    })
    const created = await service.request(descriptor())
    expect(Date.parse(created.expires_at) - Date.parse(created.created_at)).toBe(APPROVAL_TTL_MS)
    await expect(service.confirm(actor, created.approval_id)).resolves.toMatchObject({ state: 'AVAILABLE' })
  })

  it('confirmar duas vezes é conflito, não uma segunda confirmação', async () => {
    const h = harness()
    const created = await h.service.request(descriptor())
    await h.service.confirm(actor, created.approval_id)
    await expect(h.service.confirm(actor, created.approval_id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('descritor fora do contrato é recusado antes de existir qualquer pedido', async () => {
    const h = harness()
    for (const broken of [{ fingerprint: 'curto' }, { action: '' }, { tier: 'T1' as never }, { subject_id: ' espaço' }]) {
      await expect(h.service.request(descriptor(broken as Partial<ApprovalDescriptor>)))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(h.repository.size()).toBe(0)
  })
})
