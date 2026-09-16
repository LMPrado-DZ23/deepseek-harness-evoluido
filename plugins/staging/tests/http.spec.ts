import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CAMPOS_INTERNOS_DO_RELEASE,
  STAGING_ROUTE_CONTRACTS,
  codeOf,
  createStagingHttpExtension,
  releasePublico,
  statusOf,
} from '../src/http.js'
import { StagingError, type StagingService } from '../src/service.js'
import { StagingSourceError } from '../src/source.js'
import { owner } from './helpers.js'

function request(method: string, body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  return Object.assign(stream, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
}

function response() {
  const captured: { status?: number, body?: Record<string, unknown> } = {}
  return {
    captured,
    response: {
      writableEnded: false,
      writeHead: (status: number) => { captured.status = status },
      end: (text: string) => { captured.body = JSON.parse(text) as Record<string, unknown> },
    } as unknown as ServerResponse,
  }
}

function service(overrides: Partial<StagingService> = {}) {
  return {
    list: vi.fn(() => [{ release_id: 'stg-1' }]),
    get: vi.fn(() => ({ release_id: 'stg-1' })),
    publish: vi.fn(async () => ({ release_id: 'stg-1', state: 'STAGING_OK' })),
    rollback: vi.fn(async () => ({ release_id: 'stg-2', state: 'ROLLED_BACK' })),
    reconcile: vi.fn(async () => ({ release_id: 'stg-1', state: 'STAGING_OK' })),
    ...overrides,
  } as unknown as StagingService
}

async function call(suffix: string, method: string, body?: string, current?: StagingService) {
  const out = response()
  const extension = createStagingHttpExtension(() => current)
  const handled = await extension({
    request: request(method, body), response: out.response,
    actor: { orgId: owner.orgId, tenantId: owner.tenantId, role: 'owner', sessionId: 'session-a' } as never,
    projectId: 'project-1', suffix,
  })
  return { handled, ...out.captured }
}

const publishBody = JSON.stringify({ operation_id: 'op-1', approval_id: 'apr-1' })

describe('contratos de rota', () => {
  it('cada rota declara o que exige, e publicar exige a permissão de staging', () => {
    const publish = STAGING_ROUTE_CONTRACTS.find(route => route.method === 'POST' && route.path.endsWith('/staging/releases'))
    expect(publish).toMatchObject({ access: 'authorized', permission: 'project.publish_staging', scope: 'project' })
    // Ler não pode exigir a permissão de publicar: quem só acompanha ficaria
    // sem ver o que já foi publicado.
    const list = STAGING_ROUTE_CONTRACTS.find(route => route.method === 'GET' && route.path.endsWith('/staging/releases'))
    expect(list).toMatchObject({ permission: 'project.read' })
    // NÃO existe rota de apagar: apagar o registro não desfaz o efeito. O tipo
    // hoje nem admite DELETE; a comparação é alargada de propósito para que a
    // conferência continue existindo se alguém ampliar o tipo amanhã.
    expect(STAGING_ROUTE_CONTRACTS.some(route => (route.method as string) === 'DELETE')).toBe(false)
  })
})

describe('roteamento', () => {
  it('o que não é de staging passa adiante', async () => {
    for (const suffix of ['/previews', '/staging', '/staging/releasesX', '/runs']) {
      expect((await call(suffix, 'GET', undefined, service())).handled, suffix).toBe(false)
    }
  })

  it('lista, lê, publica, desfaz e reconcilia', async () => {
    expect(await call('/staging/releases', 'GET', undefined, service()))
      .toMatchObject({ handled: true, status: 200, body: { releases: [{ release_id: 'stg-1' }] } })
    expect(await call('/staging/releases/stg-1', 'GET', undefined, service()))
      .toMatchObject({ status: 200, body: { release: { release_id: 'stg-1' } } })
    expect(await call('/staging/releases', 'POST', publishBody, service()))
      .toMatchObject({ status: 200, body: { release: { state: 'STAGING_OK' } } })
    expect(await call('/staging/releases/stg-1/rollback', 'POST', publishBody, service()))
      .toMatchObject({ status: 200, body: { release: { state: 'ROLLED_BACK' } } })
    expect(await call('/staging/releases/stg-1/reconcile', 'POST', '{}', service()))
      .toMatchObject({ status: 200 })
  })

  it('método errado no caminho certo não é atendido por outra rota', async () => {
    expect((await call('/staging/releases/stg-1', 'POST', publishBody, service())).handled).toBe(false)
    expect((await call('/staging/releases/stg-1/rollback', 'GET', undefined, service())).handled).toBe(false)
  })
})

describe('recusas', () => {
  it('sem staging configurado, 503 com o motivo — e não um 404 que pareça inexistente', async () => {
    const outcome = await call('/staging/releases', 'GET')
    expect(outcome.status).toBe(503)
    expect(String(outcome.body?.error)).toContain('pasta de publicação')
  })

  it('sem sessão auditável a publicação é recusada', async () => {
    const out = response()
    const extension = createStagingHttpExtension(() => service())
    await extension({
      request: request('POST', publishBody), response: out.response,
      actor: { orgId: owner.orgId, tenantId: owner.tenantId, role: 'owner' } as never,
      projectId: 'project-1', suffix: '/staging/releases',
    })
    expect(out.captured.status).toBe(403)
  })

  it('corpo sem JSON, malformado ou com campo a mais é recusado', async () => {
    const out = response()
    const extension = createStagingHttpExtension(() => service())
    await extension({
      request: Object.assign(Readable.from([Buffer.from(publishBody)]), { method: 'POST', headers: {} }) as unknown as IncomingMessage,
      response: out.response, actor: { orgId: owner.orgId, tenantId: owner.tenantId, role: 'owner', sessionId: 's' } as never,
      projectId: 'project-1', suffix: '/staging/releases',
    })
    expect(out.captured.status).toBe(400)
    expect((await call('/staging/releases', 'POST', '{', service())).status).toBe(400)
    expect((await call('/staging/releases', 'POST', JSON.stringify({ operation_id: 'op', approval_id: 'a', extra: 1 }), service())).status).toBe(400)
  })

  it('corpo grande demais é recusado antes de virar objeto', async () => {
    expect((await call('/staging/releases', 'POST', JSON.stringify({ operation_id: 'o'.repeat(9000), approval_id: 'a' }), service())).status).toBe(400)
  })

  it('a recusa da ORIGEM é 409, e diz o que fazer em português', async () => {
    // O pedido está correto; o que falta é uma versão verificada. Um 400
    // mandaria a pessoa corrigir o que não está errado.
    const failing = service({
      publish: vi.fn(async () => { throw new StagingSourceError('NO_VERIFIED_RUN', 'sem execução') }),
    } as never)
    const outcome = await call('/staging/releases', 'POST', publishBody, failing)
    expect(outcome.status).toBe(409)
    expect(String(outcome.body?.error)).toContain('verificada')
    // O código viaja junto: a tela precisa saber QUAL gesto a recusa pede.
    expect(outcome.body?.code).toBe('NO_VERIFIED_RUN')
  })

  it('cada código de erro do serviço tem seu status', () => {
    expect(statusOf(new StagingError('NOT_FOUND', 'x'))).toBe(404)
    expect(statusOf(new StagingError('FORBIDDEN', 'x'))).toBe(403)
    expect(statusOf(new StagingError('CONFLICT', 'x'))).toBe(409)
    expect(statusOf(new StagingError('INVALID', 'x'))).toBe(400)
    expect(statusOf(new StagingSourceError('ATTESTATIONS_MISSING', 'x'))).toBe(409)
    expect(statusOf(new Error('cano estourado'))).toBe(500)
    expect(codeOf(new Error('x'))).toBeUndefined()
  })

  it('uma falha inesperada NÃO vaza a mensagem dela', async () => {
    // A mensagem de um erro inesperado pode carregar caminho, consulta ou
    // credencial.
    const failing = service({
      publish: vi.fn(async () => { throw new Error('/home/alguem/segredo.pem não pôde ser lido') }),
    } as never)
    const outcome = await call('/staging/releases', 'POST', publishBody, failing)
    expect(outcome.status).toBe(500)
    expect(String(outcome.body?.error)).not.toContain('/home/')
    expect(String(outcome.body?.error)).toContain('staging')
  })
})

describe('OS-88 — o journal não atravessa inteiro para a rede', () => {
  it('a projeção tira a sessão, a cerca e a impressão, e deixa o resto', () => {
    const release = {
      release_id: `stg-${'a'.repeat(64)}`, operation_id: 'op-1', request_fingerprint: 'b'.repeat(64),
      target_key: 'c'.repeat(64), target_generation: 1, effect_lease_id: 'lease-secreto',
      effect_lease_expires_at: '2026-09-08T12:00:00.000Z', kind: 'PUBLISH', org_id: 'org-a',
      tenant_id: 'ws-a', project_id: 'p1', run_id: 'run-1', provider_id: 'local', environment: 'staging',
      target_ref: 'dz23-target:x', state: 'STAGING_OK', version: 1, created_by: 'u-1',
      source_session_id: 'sessao-de-quem-publicou', requested_approval_id: 'ap-1', approval_id: 'ap-1',
    } as unknown as Parameters<typeof releasePublico>[0]
    const visivel = releasePublico(release) as Record<string, unknown>
    for (const campo of CAMPOS_INTERNOS_DO_RELEASE) expect(visivel).not.toHaveProperty(campo)
    expect(JSON.stringify(visivel)).not.toContain('sessao-de-quem-publicou')
    expect(JSON.stringify(visivel)).not.toContain('lease-secreto')
    // …e o que a tela precisa continua vindo: um recorte que come a resposta
    // inteira não é minimização, é produto quebrado.
    expect(visivel).toMatchObject({ release_id: release.release_id, state: 'STAGING_OK', created_by: 'u-1', target_generation: 1 })
  })

  it('a lista de campos internos não fica vazia por acidente', () => {
    // Uma projeção que não tira nada passaria em todas as asserções de forma se
    // esta linha não existisse.
    expect(CAMPOS_INTERNOS_DO_RELEASE.length).toBeGreaterThanOrEqual(4)
  })
})
