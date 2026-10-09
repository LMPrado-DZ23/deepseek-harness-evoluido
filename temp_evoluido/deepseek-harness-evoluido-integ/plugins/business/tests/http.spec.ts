import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { BUSINESS_ROUTE_CONTRACTS, createBusinessHttpExtension } from '../src/http.ts'
import type { Empresa, RegistroDeOferta, RegistroDePlano, VinculoDeTarefa } from '../src/model.ts'
import { BusinessService, type BusinessRepository } from '../src/service.ts'

/**
 * A BORDA HTTP do Modo Empresa.
 *
 * O que se prova aqui é o que só existe na borda: o contrato de cada rota, o
 * código de estado de cada recusa e o fato de que o escopo NUNCA vem do corpo.
 */
class MemoryRepository implements BusinessRepository {
  businessRows: Empresa[] = []
  planRows: RegistroDePlano[] = []
  businesses = () => this.businessRows
  plans = () => this.planRows
  putBusiness = async (value: Empresa) => {
    this.businessRows = [...this.businessRows.filter(linha => linha.business_id !== value.business_id), value]
  }
  putPlan = async (value: RegistroDePlano) => { this.planRows = [...this.planRows, value] }
  linkRows: VinculoDeTarefa[] = []
  links = () => this.linkRows
  putLink = async (value: VinculoDeTarefa) => {
    this.linkRows = [...this.linkRows.filter(linha => linha.project_id !== value.project_id), value]
  }
  offerRows: RegistroDeOferta[] = []
  offers = () => this.offerRows
  putOffer = async (value: RegistroDeOferta) => {
    this.offerRows = [...this.offerRows.filter(linha => linha.offer_version_id !== value.offer_version_id), value]
  }
}

const ana = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' as const }
const leitor = { ...ana, userId: 'user-c', role: 'viewer' as const }
const deOutraEmpresa = { userId: 'user-b', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' as const }

const PLANO = {
  objetivo: 'vender bolos caseiros por encomenda no bairro',
  publico: 'moradores do bairro',
  oferta: 'bolo de 1kg com 2 dias de antecedência',
  limites: ['não entrega fora do bairro'],
}

function capture() {
  const chunks: string[] = []
  let status = 0
  const response = {
    writableEnded: false,
    writeHead(code: number) { status = code; return response },
    end(value?: string) { if (value !== undefined) chunks.push(value); response.writableEnded = true },
  }
  return { response, get status() { return status }, body: () => (chunks.length === 0 ? {} : JSON.parse(chunks.join('')) as Record<string, unknown>) }
}

function request(method: string, body?: unknown, contentType = 'application/json'): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage
  stream.method = method
  stream.headers = body === undefined ? {} : { 'content-type': contentType }
  return stream
}

function fixture() {
  const repository = new MemoryRepository()
  let id = 0
  const service = new BusinessService({
    repository,
    now: () => new Date('2026-09-17T12:00:00.000Z'),
    createId: () => `novo-${++id}`,
  })
  return { repository, service, extension: createBusinessHttpExtension(service) }
}

async function call(
  f: ReturnType<typeof fixture>,
  suffix: string,
  method: string,
  body?: unknown,
  actor: typeof ana | typeof leitor | typeof deOutraEmpresa = ana,
  contentType?: string,
) {
  const out = capture()
  const claimed = await f.extension({
    request: request(method, body, contentType),
    response: out.response as unknown as ServerResponse,
    actor, suffix,
  } as never)
  return { claimed, status: out.status, body: out.body() }
}

describe('os contratos das rotas de empresa', () => {
  it('toda rota é de escopo `workspace` e exige permissão de papel', () => {
    // Escopo `public` ou `authenticated` aqui abriria a empresa de um inquilino
    // para quem só tem sessão.
    expect(BUSINESS_ROUTE_CONTRACTS.every(rota => rota.scope === 'workspace')).toBe(true)
    expect(BUSINESS_ROUTE_CONTRACTS.every(rota => rota.access === 'authorized')).toBe(true)
  })

  it('escrever exige `project.write`, só ler exige `project.read`, e arquivar é POST', () => {
    // Arquivar por `DELETE` faria a próxima pessoa achar que apaga — e
    // arquivar NÃO apaga. A lista inteira está aqui e não há verbo de remoção
    // nenhum nela; uma comparação separada com `'DELETE'` seria código morto,
    // porque o tipo do contrato já não admite esse valor.
    expect(BUSINESS_ROUTE_CONTRACTS.map(rota => `${rota.method} ${rota.path} ${rota.permission}`)).toEqual([
      'GET /businesses project.read',
      'POST /businesses project.write',
      'GET /businesses/:businessId project.read',
      'POST /businesses/:businessId/plan project.write',
      'POST /businesses/:businessId/archive project.write',
      'GET /businesses/:businessId/tasks project.read',
      'POST /businesses/:businessId/tasks project.write',
      'GET /businesses/:businessId/offers project.read',
      'POST /businesses/:businessId/offers project.write',
      'POST /businesses/:businessId/offers/approve project.write',
    ])
  })
})

describe('a extensão HTTP', () => {
  it('não reivindica o que não é dela', async () => {
    const f = fixture()
    expect((await call(f, '/projects', 'GET')).claimed).toBe(false)
    expect((await call(f, '/businesses-outra-coisa', 'GET')).claimed).toBe(false)
  })

  it('criar devolve 201 com a empresa E a primeira versão do plano', async () => {
    const f = fixture()
    const resposta = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    expect(resposta.status).toBe(201)
    expect((resposta.body['plan'] as RegistroDePlano).version).toBe(1)
  })

  it('o escopo do CORPO é recusado — ele nunca vem do pedido', async () => {
    // Aceitar `org_id` do corpo deixaria qualquer um gravar dentro do inquilino
    // de outro; o schema é `strict()` justamente por isso.
    const f = fixture()
    const resposta = await call(f, '/businesses', 'POST', {
      nome: 'Bolos da Ana', origem: 'criada', plano: PLANO, org_id: 'org-b', tenant_id: 'tenant-b',
    })
    expect(resposta.status).toBe(400)
    expect(f.repository.businessRows).toHaveLength(0)
  })

  it('ler a empresa devolve a empresa E as versões do plano no mesmo corpo', async () => {
    const f = fixture()
    const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const id = (criada.body['business'] as Empresa).business_id
    const resposta = await call(f, `/businesses/${id}`, 'GET')
    expect(resposta.status).toBe(200)
    expect((resposta.body['plans'] as RegistroDePlano[])).toHaveLength(1)
  })

  it('a empresa de OUTRO inquilino responde 404, e não 403', async () => {
    const f = fixture()
    const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const id = (criada.body['business'] as Empresa).business_id
    expect((await call(f, `/businesses/${id}`, 'GET', undefined, deOutraEmpresa)).status).toBe(404)
  })

  it('quem só pode LER recebe 403 ao criar', async () => {
    const f = fixture()
    expect((await call(f, '/businesses', 'POST', { nome: 'Bolos', origem: 'criada', plano: PLANO }, leitor)).status).toBe(403)
  })

  it('plano repetido é 409, e não 400: é conflito com o estado de agora', async () => {
    const f = fixture()
    const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const id = (criada.body['business'] as Empresa).business_id
    expect((await call(f, `/businesses/${id}/plan`, 'POST', { plano: PLANO })).status).toBe(409)
  })

  it('revisar o plano devolve 201 com a versão nova', async () => {
    const f = fixture()
    const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const id = (criada.body['business'] as Empresa).business_id
    const resposta = await call(f, `/businesses/${id}/plan`, 'POST', { plano: { ...PLANO, oferta: 'bolo de 2kg' } })
    expect(resposta.status).toBe(201)
    expect((resposta.body['plan'] as RegistroDePlano).version).toBe(2)
  })

  it('arquivar tira da lista sem apagar o histórico', async () => {
    const f = fixture()
    const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const id = (criada.body['business'] as Empresa).business_id
    expect((await call(f, `/businesses/${id}/archive`, 'POST')).status).toBe(200)
    expect((await call(f, '/businesses', 'GET')).body['businesses']).toHaveLength(0)
    expect(f.repository.planRows).toHaveLength(1)
  })

  it('corpo que não é JSON é recusado ANTES de qualquer gravação', async () => {
    const f = fixture()
    const resposta = await call(f, '/businesses', 'POST', 'nome=Bolos', ana, 'text/plain')
    expect(resposta.status).toBe(400)
    expect(f.repository.businessRows).toHaveLength(0)
  })

  it('JSON quebrado responde 400, e não 500', async () => {
    const f = fixture()
    expect((await call(f, '/businesses', 'POST', '{"nome":')).status).toBe(400)
  })

  it('método que a rota não tem responde 404', async () => {
    const f = fixture()
    expect((await call(f, '/businesses/emp-1/plan', 'GET')).status).toBe(404)
  })
})

describe('as rotas de tarefa da empresa', () => {
  function comTarefas() {
    const repository = new MemoryRepository()
    let id = 0
    let projeto = 0
    const chaves: Array<string | undefined> = []
    const service = new BusinessService({
      repository,
      now: () => new Date('2026-09-17T12:00:00.000Z'),
      createId: () => `novo-${++id}`,
      tarefas: {
        criar: async (_actor, input, requestKey) => {
          chaves.push(requestKey)
          return { project_id: `proj-${++projeto}`, name: input.name, state: 'INTAKE' }
        },
      },
    })
    return { repository, service, chaves, extension: createBusinessHttpExtension(service) }
  }

  async function empresaCriada(f: ReturnType<typeof comTarefas>) {
    const criada = await call(f as never, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    return (criada.body['business'] as Empresa).business_id
  }

  it('criar tarefa devolve 201 com a tarefa E o vínculo', async () => {
    const f = comTarefas()
    const id = await empresaCriada(f)
    const resposta = await call(f as never, `/businesses/${id}/tasks`, 'POST', {
      pedido: 'uma página para receber encomendas', category: 'landing-page', privacy: 'local-only',
    })
    expect(resposta.status).toBe(201)
    expect(resposta.body['task']).toMatchObject({ project_id: 'proj-1' })
    expect(resposta.body['link']).toMatchObject({ project_id: 'proj-1', plan_version: 1 })
  })

  it('`request_key` ATRAVESSA inteira para quem já sabe tratá-la', async () => {
    // Não há segunda contabilidade de criação aqui: a identidade de intenção
    // continua sendo a do serviço de tarefas.
    const f = comTarefas()
    const id = await empresaCriada(f)
    await call(f as never, `/businesses/${id}/tasks`, 'POST', {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only', request_key: 'k-1',
    })
    expect(f.chaves).toEqual(['k-1'])
  })

  it('categoria que a TAREFA não conhece é recusada com 400, e nada é criado', async () => {
    const f = comTarefas()
    const id = await empresaCriada(f)
    const resposta = await call(f as never, `/businesses/${id}/tasks`, 'POST', {
      pedido: 'uma página', category: 'jogo-de-tiro', privacy: 'local-only',
    })
    expect(resposta.status).toBe(400)
    expect(f.repository.linkRows).toHaveLength(0)
  })

  it('listar as tarefas da empresa devolve os vínculos', async () => {
    const f = comTarefas()
    const id = await empresaCriada(f)
    await call(f as never, `/businesses/${id}/tasks`, 'POST', {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })
    const resposta = await call(f as never, `/businesses/${id}/tasks`, 'GET')
    expect(resposta.status).toBe(200)
    expect(resposta.body['tasks']).toHaveLength(1)
  })

  it('a empresa de OUTRO inquilino responde 404 também aqui', async () => {
    const f = comTarefas()
    const id = await empresaCriada(f)
    expect((await call(f as never, `/businesses/${id}/tasks`, 'GET', undefined, deOutraEmpresa)).status).toBe(404)
  })

  it('sem serviço de tarefas montado, a rota recusa com 409 e uma frase', async () => {
    const f = fixture()
    const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const id = (criada.body['business'] as Empresa).business_id
    const resposta = await call(f, `/businesses/${id}/tasks`, 'POST', {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })
    expect(resposta.status).toBe(409)
    expect(String(resposta.body['error'])).toContain('serviço de tarefas')
  })
})

const OFERTA = {
  nome: 'Bolo de aniversário',
  entrega: 'Um bolo de dois quilos, decorado, entregue no endereço da pessoa.',
  publico: 'Famílias do bairro',
  preco: 200,
  moeda: 'BRL',
  capacidade: { quantidade: 4, periodo: 'dia' },
  condicoes: ['Encomenda com três dias de antecedência'],
  custos: [{ nome: 'Ingredientes', valor: 60 }],
}

async function comEmpresa() {
  const f = fixture()
  const criada = await call(f, '/businesses', 'POST', { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
  return { f, businessId: (criada.body.business as { business_id: string }).business_id }
}

describe('as rotas da oferta', () => {
  it('criar devolve 201 com a primeira versão, em rascunho', async () => {
    const { f, businessId } = await comEmpresa()
    const criada = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA })
    expect(criada.status).toBe(201)
    expect(criada.body.offer).toMatchObject({ version: 1, approved_at: null })
  })

  it('o corpo COM `offer_key` é revisão, e sem ele é oferta nova', async () => {
    // A diferença entre criar e revisar é exatamente um campo do corpo; duas
    // rotas para isso diriam a mesma coisa duas vezes.
    const { f, businessId } = await comEmpresa()
    const primeira = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA })
    const chave = (primeira.body.offer as { offer_key: string }).offer_key
    const revisada = await call(f, `/businesses/${businessId}/offers`, 'POST', {
      offer_key: chave, oferta: { ...OFERTA, preco: 240 },
    })
    expect(revisada.status).toBe(201)
    expect(revisada.body.offer).toMatchObject({ version: 2, offer_key: chave })
    const outra = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: { ...OFERTA, nome: 'Torta' } })
    expect((outra.body.offer as { offer_key: string }).offer_key).not.toBe(chave)
  })

  it('o catálogo traz UMA entrada por oferta, com a versão que vale', async () => {
    const { f, businessId } = await comEmpresa()
    const primeira = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA })
    await call(f, `/businesses/${businessId}/offers`, 'POST', {
      offer_key: (primeira.body.offer as { offer_key: string }).offer_key, oferta: { ...OFERTA, preco: 240 },
    })
    const catalogo = await call(f, `/businesses/${businessId}/offers`, 'GET')
    expect(catalogo.status).toBe(200)
    expect(catalogo.body.offers).toHaveLength(1)
    expect((catalogo.body.offers as { version: number }[])[0]!.version).toBe(2)
  })

  it('aprovar devolve 200 com a MESMA versão, agora com a decisão dentro', async () => {
    const { f, businessId } = await comEmpresa()
    const criada = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA })
    const id = (criada.body.offer as { offer_version_id: string }).offer_version_id
    const aprovada = await call(f, `/businesses/${businessId}/offers/approve`, 'POST', { offer_version_id: id })
    expect(aprovada.status).toBe(200)
    expect(aprovada.body.offer).toMatchObject({ offer_version_id: id, approved_by: 'user-a' })
  })

  it('aprovar sem preço é 409 — conflito com o estado, e não pedido malformado', async () => {
    const { f, businessId } = await comEmpresa()
    const criada = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: { ...OFERTA, preco: null } })
    const id = (criada.body.offer as { offer_version_id: string }).offer_version_id
    const recusa = await call(f, `/businesses/${businessId}/offers/approve`, 'POST', { offer_version_id: id })
    expect(recusa.status).toBe(409)
  })

  it('custo SEM valor atravessa a fronteira: é o que declara o que falta saber', async () => {
    // Exigir um número aqui faria a pessoa digitar zero, e o zero mentiria
    // para cima na margem.
    const { f, businessId } = await comEmpresa()
    const criada = await call(f, `/businesses/${businessId}/offers`, 'POST', {
      oferta: { ...OFERTA, custos: [{ nome: 'Frete', valor: null }] },
    })
    expect(criada.status).toBe(201)
    expect((criada.body.offer as { oferta: { custos: unknown[] } }).oferta.custos).toEqual([{ nome: 'Frete', valor: null }])
  })

  it('moeda fora de ISO 4217 é 400', async () => {
    const { f, businessId } = await comEmpresa()
    expect((await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: { ...OFERTA, moeda: 'reais' } })).status).toBe(400)
    expect((await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: { ...OFERTA, moeda: 'brl' } })).status).toBe(400)
  })

  it('campo desconhecido no corpo da oferta é 400, e não é ignorado em silêncio', async () => {
    const { f, businessId } = await comEmpresa()
    const resposta = await call(f, `/businesses/${businessId}/offers`, 'POST', {
      oferta: { ...OFERTA, aprovada: true },
    })
    expect(resposta.status).toBe(400)
  })

  it('o vizinho recebe 404 no catálogo da empresa alheia, e não 403', async () => {
    const { f, businessId } = await comEmpresa()
    await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA })
    expect((await call(f, `/businesses/${businessId}/offers`, 'GET', undefined, deOutraEmpresa)).status).toBe(404)
  })

  it('quem só pode LER recebe 403 ao criar e ao aprovar', async () => {
    const { f, businessId } = await comEmpresa()
    expect((await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA }, leitor)).status).toBe(403)
    const criada = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA })
    const id = (criada.body.offer as { offer_version_id: string }).offer_version_id
    expect((await call(f, `/businesses/${businessId}/offers/approve`, 'POST', { offer_version_id: id }, leitor)).status).toBe(403)
  })

  it('o escopo NÃO vem do corpo: mandar `org_id` é 400', async () => {
    const { f, businessId } = await comEmpresa()
    const resposta = await call(f, `/businesses/${businessId}/offers`, 'POST', { oferta: OFERTA, org_id: 'org-b' })
    expect(resposta.status).toBe(400)
  })
})
