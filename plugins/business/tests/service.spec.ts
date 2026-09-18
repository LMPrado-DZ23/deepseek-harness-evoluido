import { describe, expect, it } from 'vitest'
import { BusinessError, BusinessService, type BusinessActor, type BusinessRepository } from '../src/service.js'
import type { Empresa, Oferta, PlanoDeNegocio, RegistroDeOferta, RegistroDePlano, VinculoDeTarefa } from '../src/model.js'

/**
 * O serviço de empresas — `BUS-01`, a porta do Modo Empresa.
 *
 * O que se prova aqui é o que só existe quando as gravações acontecem juntas:
 * o isolamento por inquilino, a ordem das duas escritas e o histórico que não
 * se apaga.
 */
class MemoryRepository implements BusinessRepository {
  businessRows: Empresa[] = []
  planRows: RegistroDePlano[] = []
  businesses = () => this.businessRows
  plans = () => this.planRows
  putBusiness = async (value: Empresa) => {
    this.businessRows = [...this.businessRows.filter(row => row.business_id !== value.business_id), value]
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

const ana: BusinessActor = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const deOutraEmpresa: BusinessActor = { userId: 'user-b', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' }
const leitor: BusinessActor = { userId: 'user-c', orgId: 'org-a', tenantId: 'tenant-a', role: 'viewer' }

const PLANO: PlanoDeNegocio = {
  objetivo: 'vender bolos caseiros por encomenda no bairro',
  publico: 'moradores do bairro',
  oferta: 'bolo de 1kg com 2 dias de antecedência',
  limites: ['não entrega fora do bairro'],
}

function fixture() {
  const repository = new MemoryRepository()
  let id = 0
  const service = new BusinessService({
    repository,
    now: () => new Date('2026-09-17T12:00:00.000Z'),
    createId: () => `novo-${++id}`,
  })
  return { repository, service }
}

describe('criar a empresa', () => {
  it('grava a empresa E a primeira versão do plano, juntas', async () => {
    // Uma empresa sem objetivo e sem público não é operável, e deixar o plano
    // para depois produziria uma lista de empresas vazias.
    const { service, repository } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    expect(repository.businessRows).toHaveLength(1)
    expect(repository.planRows).toHaveLength(1)
    expect(criada.plano.version).toBe(1)
    expect(criada.plano.business_id).toBe(criada.empresa.business_id)
  })

  it('o escopo vem do ATOR, e não do pedido', async () => {
    const { service, repository } = fixture()
    await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    expect(repository.businessRows[0]).toMatchObject({ org_id: 'org-a', tenant_id: 'tenant-a' })
  })

  it('a identidade jurídica é DECLARADA, e ausente vira `null` — nunca texto vazio', async () => {
    const { service } = fixture()
    const sem = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    expect(sem.empresa.identidade_juridica_declarada).toBeNull()
    const com = await service.create(ana, {
      nome: 'Bolos da Ana', origem: 'vinculada',
      identidade_juridica_declarada: '  ME  registrada  em GO ', plano: PLANO,
    })
    expect(com.empresa.identidade_juridica_declarada).toBe('ME registrada em GO')
  })

  it('nome só com espaço é recusado, e nada é gravado', async () => {
    const { service, repository } = fixture()
    await expect(service.create(ana, { nome: '   ', origem: 'criada', plano: PLANO })).rejects.toThrow(BusinessError)
    expect(repository.businessRows).toHaveLength(0)
    expect(repository.planRows).toHaveLength(0)
  })

  it('quem só pode LER não cria empresa', async () => {
    const { service, repository } = fixture()
    await expect(service.create(leitor, { nome: 'Bolos', origem: 'criada', plano: PLANO })).rejects.toThrow(BusinessError)
    expect(repository.businessRows).toHaveLength(0)
  })
})

describe('o isolamento entre espaços de trabalho', () => {
  it('a empresa de um inquilino NÃO aparece na lista do outro', async () => {
    const { service } = fixture()
    await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    expect(service.list(ana)).toHaveLength(1)
    expect(service.list(deOutraEmpresa)).toHaveLength(0)
  })

  it('ler a empresa de outro inquilino responde NÃO ENCONTRADA, e não "proibida"', async () => {
    // Dizer "proibida" confirmaria que a empresa existe para quem perguntou.
    const { service } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    try {
      service.get(deOutraEmpresa, criada.empresa.business_id)
      throw new Error('deveria ter recusado')
    } catch (erro) {
      expect(erro).toBeInstanceOf(BusinessError)
      expect((erro as BusinessError).code).toBe('NOT_FOUND')
    }
  })

  it('o plano de um inquilino não entra na contagem de versões do outro', async () => {
    const { service, repository } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    // Um registro plantado com o MESMO `business_id` e outro inquilino.
    repository.planRows.push({
      ...criada.plano, plan_id: 'plantado', org_id: 'org-b', tenant_id: 'tenant-b', version: 99,
    })
    const nova = await service.revisarPlano(ana, criada.empresa.business_id, { ...PLANO, oferta: 'bolo de 2kg' })
    // 2, e não 100: a versão 99 do outro inquilino não conta aqui.
    expect(nova.version).toBe(2)
  })
})

describe('o plano versionado', () => {
  it('uma revisão cria versão NOVA e NÃO apaga a anterior', async () => {
    const { service, repository } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.revisarPlano(ana, criada.empresa.business_id, { ...PLANO, oferta: 'bolo de 2kg' })
    expect(repository.planRows).toHaveLength(2)
    expect(service.planos(ana, criada.empresa.business_id).map(registro => registro.version)).toEqual([2, 1])
  })

  it('gravar o MESMO plano de novo é recusado com conflito', async () => {
    const { service, repository } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await expect(service.revisarPlano(ana, criada.empresa.business_id, PLANO)).rejects.toThrow(BusinessError)
    expect(repository.planRows).toHaveLength(1)
  })

  it('o plano é normalizado ao gravar: limite repetido não vira duas regras', async () => {
    const { service } = fixture()
    const criada = await service.create(ana, {
      nome: 'Bolos da Ana', origem: 'criada',
      plano: { ...PLANO, limites: ['não entrega fora do bairro', ' não entrega  fora do bairro '] },
    })
    expect(criada.plano.plano.limites).toEqual(['não entrega fora do bairro'])
  })
})

describe('arquivar', () => {
  it('a empresa arquivada sai da lista, e continua legível por identificador', async () => {
    const { service } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.arquivar(ana, criada.empresa.business_id)
    expect(service.list(ana)).toHaveLength(0)
    expect(service.get(ana, criada.empresa.business_id).archived_at).not.toBeNull()
  })

  it('arquivar NÃO apaga o histórico do plano', async () => {
    // Arquivar não é apagar, e apagar dado exige decisão explícita do dono.
    const { service, repository } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.arquivar(ana, criada.empresa.business_id)
    expect(repository.planRows).toHaveLength(1)
    expect(service.planos(ana, criada.empresa.business_id)).toHaveLength(1)
  })

  it('empresa arquivada NÃO recebe plano novo', async () => {
    const { service } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.arquivar(ana, criada.empresa.business_id)
    await expect(service.revisarPlano(ana, criada.empresa.business_id, { ...PLANO, oferta: 'outra' }))
      .rejects.toThrow(BusinessError)
  })

  it('arquivar duas vezes não muda a data da primeira', async () => {
    const { service } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const primeira = await service.arquivar(ana, criada.empresa.business_id)
    const segunda = await service.arquivar(ana, criada.empresa.business_id)
    expect(segunda.archived_at).toBe(primeira.archived_at)
  })
})

describe('criar tarefa PARA a empresa', () => {
  function comTarefas() {
    const repository = new MemoryRepository()
    let id = 0
    let projeto = 0
    const criadas: Array<{ name: string; original_brief: string }> = []
    const service = new BusinessService({
      repository,
      now: () => new Date('2026-09-17T12:00:00.000Z'),
      createId: () => `novo-${++id}`,
      tarefas: {
        criar: async (_actor, input) => {
          criadas.push({ name: input.name, original_brief: input.original_brief })
          return { project_id: `proj-${++projeto}`, name: input.name, state: 'INTAKE' }
        },
      },
    })
    return { repository, service, criadas }
  }

  it('grava a tarefa E o vínculo, e o vínculo guarda a VERSÃO do plano', async () => {
    // Sem a versão, a pergunta "com base em quê esta tarefa foi feita?" perde a
    // resposta na primeira revisão do plano.
    const { service, repository } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const feita = await service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página para receber encomendas', category: 'landing-page', privacy: 'local-only',
    })
    expect(repository.linkRows).toHaveLength(1)
    expect(feita.vinculo.plan_version).toBe(1)
    expect(feita.vinculo.project_id).toBe(feita.tarefa.project_id)
  })

  it('o PLANO entra no briefing da tarefa', async () => {
    // É isto que faz o vínculo valer alguma coisa: sem o plano dentro do
    // pedido, "tarefa da empresa X" seria só um rótulo.
    const { service, criadas } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })
    expect(criadas[0]!.original_brief).toContain('moradores do bairro')
    expect(criadas[0]!.original_brief).toContain('- não entrega fora do bairro')
  })

  it('a tarefa é criada ANTES do vínculo: a queda no meio não deixa vínculo órfão', async () => {
    // Na ordem invertida, a empresa listaria uma tarefa que ninguém abre.
    const repository = new MemoryRepository()
    const service = new BusinessService({
      repository, createId: () => 'novo', now: () => new Date('2026-09-17T12:00:00.000Z'),
      tarefas: { criar: async () => { throw new Error('caiu') } },
    })
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await expect(service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })).rejects.toThrow('caiu')
    expect(repository.linkRows).toHaveLength(0)
  })

  it('a MESMA tarefa devolvida de novo NÃO grava um segundo vínculo', async () => {
    // É o que o reenvio com a mesma chave de intenção produz: a tarefa é a
    // mesma, e um segundo vínculo faria a empresa listá-la duas vezes.
    const repository = new MemoryRepository()
    let id = 0
    const service = new BusinessService({
      // `createId` INCREMENTA de propósito: com um id fixo, dois vínculos
      // diferentes nasceriam iguais e o teste passaria sem provar nada.
      repository, createId: () => `novo-${++id}`, now: () => new Date('2026-09-17T12:00:00.000Z'),
      tarefas: { criar: async () => ({ project_id: 'proj-1', name: 'x', state: 'INTAKE' }) },
    })
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const pedido = { pedido: 'uma página', category: 'landing-page', privacy: 'local-only' } as const
    const primeira = await service.criarTarefa(ana, criada.empresa.business_id, pedido, 'chave')
    const segunda = await service.criarTarefa(ana, criada.empresa.business_id, pedido, 'chave')
    expect(repository.linkRows).toHaveLength(1)
    expect(segunda.vinculo.link_id).toBe(primeira.vinculo.link_id)
  })

  it('o vínculo guarda a versão que VALE no momento, e não sempre a 1', async () => {
    // Fixar 1 aqui apagaria justamente a informação pela qual o vínculo existe.
    const { service } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.revisarPlano(ana, criada.empresa.business_id, { ...PLANO, oferta: 'bolo de 2kg' })
    const feita = await service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })
    expect(feita.vinculo.plan_version).toBe(2)
  })

  it('o vínculo de OUTRO inquilino não entra na lista, mesmo com o mesmo `business_id`', async () => {
    // A reautorização da empresa já barra quem vem de fora; o filtro de escopo
    // barra o registro PLANTADO — que é o que outra pessoa gravando ao mesmo
    // tempo, ou uma leitura sem escopo, produziria.
    const { service, repository } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    const feita = await service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })
    repository.linkRows.push({
      ...feita.vinculo, link_id: 'plantado', project_id: 'proj-de-outro',
      org_id: 'org-b', tenant_id: 'tenant-b',
    })
    expect(service.tarefas(ana, criada.empresa.business_id).map(vinculo => vinculo.project_id))
      .toEqual([feita.tarefa.project_id])
  })

  it('empresa ARQUIVADA não recebe tarefa nova', async () => {
    const { service, repository } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.arquivar(ana, criada.empresa.business_id)
    await expect(service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })).rejects.toThrow(BusinessError)
    expect(repository.linkRows).toHaveLength(0)
  })

  it('sem serviço de tarefas montado, RECUSA em palavras — e não quebra', async () => {
    // Um perfil que monte o Modo Empresa sem o prompt-to-app continua listando
    // e revisando empresas.
    const { service } = fixture()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await expect(service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })).rejects.toThrow(BusinessError)
  })

  it('quem só pode LER não cria tarefa', async () => {
    const { service, repository } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await expect(service.criarTarefa(leitor, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })).rejects.toThrow(BusinessError)
    expect(repository.linkRows).toHaveLength(0)
  })

  it('a tarefa de um inquilino NÃO aparece na lista do outro', async () => {
    const { service } = comTarefas()
    const criada = await service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    await service.criarTarefa(ana, criada.empresa.business_id, {
      pedido: 'uma página', category: 'landing-page', privacy: 'local-only',
    })
    expect(service.tarefas(ana, criada.empresa.business_id)).toHaveLength(1)
    expect(() => service.tarefas(deOutraEmpresa, criada.empresa.business_id)).toThrow(BusinessError)
  })
})

const OFERTA: Oferta = {
  nome: 'Bolo de aniversário',
  entrega: 'Um bolo de dois quilos, decorado, entregue no endereço da pessoa.',
  publico: 'Famílias do bairro',
  preco: 200,
  moeda: 'BRL',
  capacidade: { quantidade: 4, periodo: 'semana' },
  condicoes: ['Encomenda com três dias de antecedência'],
  custos: [{ nome: 'Ingredientes', valor: 60 }],
}

async function comEmpresa() {
  const contexto = fixture()
  const criada = await contexto.service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
  return { ...contexto, businessId: criada.empresa.business_id }
}

describe('o catálogo de ofertas', () => {
  it('a oferta nasce na versão 1 e em RASCUNHO, mesmo chegando completa', async () => {
    // Aprovar é um ato de quem responde pela empresa. Fazê-lo acontecer junto
    // da criação tiraria dessa pessoa a única decisão que o aceite pede que
    // seja dela.
    const { service, businessId, repository } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    expect(registro.version).toBe(1)
    expect(registro.approved_at).toBeNull()
    expect(registro.approved_by).toBeNull()
    expect(repository.offerRows).toHaveLength(1)
  })

  it('o preço gravado é o que a PESSOA escreveu — a sugestão não vira preço sozinha', async () => {
    // É a metade do aceite que diz "preço sugerido não publicado
    // automaticamente". Um rascunho com custos e sem preço fica SEM preço.
    const { service, businessId } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, { ...OFERTA, preco: null })
    expect(registro.oferta.preco).toBeNull()
  })

  it('a REVISÃO cria versão nova e não apaga a anterior', async () => {
    const { service, businessId, repository } = await comEmpresa()
    const primeira = await service.criarOferta(ana, businessId, OFERTA)
    const segunda = await service.revisarOferta(ana, businessId, primeira.offer_key, { ...OFERTA, preco: 240 })
    expect(segunda.version).toBe(2)
    expect(segunda.offer_key).toBe(primeira.offer_key)
    expect(repository.offerRows).toHaveLength(2)
    expect(service.versoesDaOferta(ana, businessId, primeira.offer_key).map(item => item.version)).toEqual([2, 1])
  })

  it('a revisão de uma oferta APROVADA nasce em rascunho de novo', async () => {
    // Herdar a aprovação faria condições que ninguém leu virarem "condições
    // aprovadas" — exatamente o que o aceite proíbe.
    const { service, businessId } = await comEmpresa()
    const primeira = await service.criarOferta(ana, businessId, OFERTA)
    await service.aprovarOferta(ana, businessId, primeira.offer_version_id)
    const segunda = await service.revisarOferta(ana, businessId, primeira.offer_key, { ...OFERTA, preco: 240 })
    expect(segunda.approved_at).toBeNull()
  })

  it('revisão IDÊNTICA à vigente é recusada', async () => {
    const { service, businessId, repository } = await comEmpresa()
    const primeira = await service.criarOferta(ana, businessId, OFERTA)
    await expect(service.revisarOferta(ana, businessId, primeira.offer_key, OFERTA)).rejects.toThrow(BusinessError)
    expect(repository.offerRows).toHaveLength(1)
  })

  it('revisar uma oferta que não existe é NÃO ENCONTRADA, e não cria uma nova', async () => {
    const { service, businessId, repository } = await comEmpresa()
    await expect(service.revisarOferta(ana, businessId, 'of-inexistente', OFERTA)).rejects.toThrow(BusinessError)
    expect(repository.offerRows).toHaveLength(0)
  })

  it('DUAS ofertas diferentes têm numeração independente', async () => {
    const { service, businessId } = await comEmpresa()
    const bolo = await service.criarOferta(ana, businessId, OFERTA)
    await service.revisarOferta(ana, businessId, bolo.offer_key, { ...OFERTA, preco: 240 })
    const torta = await service.criarOferta(ana, businessId, { ...OFERTA, nome: 'Torta salgada' })
    expect(torta.version).toBe(1)
    expect(service.catalogo(ana, businessId).map(item => [item.oferta.nome, item.version]))
      .toEqual([['Bolo de aniversário', 2], ['Torta salgada', 1]])
  })

  it('empresa ARQUIVADA não recebe oferta nova', async () => {
    const { service, businessId, repository } = await comEmpresa()
    await service.arquivar(ana, businessId)
    await expect(service.criarOferta(ana, businessId, OFERTA)).rejects.toThrow(BusinessError)
    expect(repository.offerRows).toHaveLength(0)
  })
})

describe('aprovar a oferta', () => {
  it('grava QUEM aprovou e QUANDO', async () => {
    const { service, businessId } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    const aprovada = await service.aprovarOferta(ana, businessId, registro.offer_version_id)
    expect(aprovada.approved_by).toBe('user-a')
    expect(aprovada.approved_at).toBe('2026-09-17T12:00:00.000Z')
  })

  it('aprovar NÃO cria versão nova: é a mesma versão, com a decisão dentro', async () => {
    // "Condições aprovadas" são as condições que estavam escritas quando
    // alguém aprovou. Uma versão nova mudaria o texto que foi aprovado.
    const { service, businessId, repository } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    const aprovada = await service.aprovarOferta(ana, businessId, registro.offer_version_id)
    expect(repository.offerRows).toHaveLength(1)
    expect(aprovada.offer_version_id).toBe(registro.offer_version_id)
    expect(aprovada.oferta).toEqual(registro.oferta)
  })

  it('sem PREÇO, recusa em vez de aprovar', async () => {
    const { service, businessId, repository } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, { ...OFERTA, preco: null })
    await expect(service.aprovarOferta(ana, businessId, registro.offer_version_id)).rejects.toThrow(BusinessError)
    expect(repository.offerRows[0]!.approved_at).toBeNull()
  })

  it('sem CAPACIDADE, recusa', async () => {
    const { service, businessId } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, { ...OFERTA, capacidade: { quantidade: 0, periodo: 'mes' } })
    await expect(service.aprovarOferta(ana, businessId, registro.offer_version_id)).rejects.toThrow(BusinessError)
  })

  it('sem CONDIÇÃO escrita, recusa', async () => {
    const { service, businessId } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, { ...OFERTA, condicoes: [] })
    await expect(service.aprovarOferta(ana, businessId, registro.offer_version_id)).rejects.toThrow(BusinessError)
  })

  it('aprovar duas vezes a mesma versão é recusado', async () => {
    const { service, businessId } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    await service.aprovarOferta(ana, businessId, registro.offer_version_id)
    await expect(service.aprovarOferta(ana, businessId, registro.offer_version_id)).rejects.toThrow(BusinessError)
  })

  it('quem só pode LER não aprova', async () => {
    const { service, businessId, repository } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    await expect(service.aprovarOferta(leitor, businessId, registro.offer_version_id)).rejects.toThrow(BusinessError)
    expect(repository.offerRows[0]!.approved_at).toBeNull()
  })
})

describe('o isolamento do catálogo', () => {
  it('a oferta de um inquilino NÃO aparece para o outro', async () => {
    const { service, businessId } = await comEmpresa()
    await service.criarOferta(ana, businessId, OFERTA)
    expect(service.catalogo(ana, businessId)).toHaveLength(1)
    expect(() => service.catalogo(deOutraEmpresa, businessId)).toThrow(BusinessError)
  })

  it('o vizinho NÃO aprova a oferta da empresa alheia, e recebe NÃO ENCONTRADA', async () => {
    // Dizer "proibido" confirmaria para quem perguntou que a empresa existe.
    const { service, businessId, repository } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    await expect(service.aprovarOferta(deOutraEmpresa, businessId, registro.offer_version_id)).rejects.toThrow(BusinessError)
    expect(repository.offerRows[0]!.approved_at).toBeNull()
  })

  it('o vizinho NÃO revisa a oferta da empresa alheia', async () => {
    const { service, businessId, repository } = await comEmpresa()
    const registro = await service.criarOferta(ana, businessId, OFERTA)
    await expect(service.revisarOferta(deOutraEmpresa, businessId, registro.offer_key, { ...OFERTA, preco: 300 }))
      .rejects.toThrow(BusinessError)
    expect(repository.offerRows).toHaveLength(1)
  })
})
