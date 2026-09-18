import { describe, expect, it, vi } from 'vitest'
import { DomainBusinessRepository, apply, inject, type StudioBusinessRuntime } from '../src/index.ts'
import type { BusinessKey, Empresa, RegistroDeOferta, RegistroDePlano, VinculoDeTarefa } from '../src/model.ts'

/**
 * A MONTAGEM do Modo Empresa.
 *
 * Existir no código não é existir em execução: este arquivo prova que o plugin
 * abre os dois domínios, lê o que já estava gravado e registra a extensão HTTP
 * — e que o repositório de verdade, e não só o dublê do serviço, devolve o que
 * está nas tabelas.
 */
function tabela<V>() {
  const registros = new Map<string, V>()
  return {
    registros,
    get: (chave: string) => registros.get(chave),
    entries: () => registros.entries(),
    keys: () => registros.keys(),
    get size() { return registros.size },
    put: (chave: string, valor: V) => { registros.set(chave, valor); return Promise.resolve() },
    delete: (chave: string) => Promise.resolve(registros.delete(chave)),
    update: (chave: string, fn: (atual: V) => V) => {
      const proximo = fn(registros.get(chave)!)
      registros.set(chave, proximo)
      return Promise.resolve(proximo)
    },
  }
}

const PLANO = {
  objetivo: 'vender bolos caseiros por encomenda no bairro',
  publico: 'moradores do bairro',
  oferta: 'bolo de 1kg com 2 dias de antecedência',
  limites: ['não entrega fora do bairro'],
}

const ana = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' } as const

function contexto() {
  const empresas = tabela<Empresa>()
  const planos = tabela<RegistroDePlano>()
  const vinculos = tabela<VinculoDeTarefa>()
  const ofertas = tabela<RegistroDeOferta>()
  const close = vi.fn(() => Promise.resolve())
  let runtime!: StudioBusinessRuntime
  const ctx = {
    storageDomain: {
      open: vi.fn((spec: { name: string }) => Promise.resolve({
        table: () => (spec.name === 'studio_businesses' ? empresas : spec.name === 'studio_business_plans' ? planos : spec.name === 'studio_business_tasks' ? vinculos : ofertas),
        close,
      })),
    },
    effect: vi.fn((factory: () => unknown) => factory()),
    provide: vi.fn((_nome: string, valor: StudioBusinessRuntime) => { runtime = valor }),
  }
  return { ctx, empresas, planos, vinculos, ofertas, close, runtime: () => runtime }
}

describe('a montagem do Modo Empresa', () => {
  it('`inject` pede SÓ o que o plugin não sabe viver sem', () => {
    // `promptToApp` entra porque as rotas da empresa são registradas no
    // manipulador de workspace dele: sem ele, elas não existem em lugar nenhum.
    expect(inject).toEqual(['storageDomain', 'promptToApp'])
  })

  it('abre os QUATRO domínios e entrega um serviço que grava nas tabelas', async () => {
    const { ctx, empresas, planos, runtime } = contexto()
    await apply(ctx as never)
    // A contagem é literal de propósito: um domínio novo declarado no modelo e
    // esquecido no `apply` é código que existe e não executa — o defeito que
    // `gate:profile-mounts` nasceu para pegar, uma camada acima.
    expect(ctx.storageDomain.open).toHaveBeenCalledTimes(4)
    await runtime().service.create(ana, { nome: 'Bolos da Ana', origem: 'criada', plano: PLANO })
    expect(empresas.registros.size).toBe(1)
    expect(planos.registros.size).toBe(1)
  })

  it('LÊ o que já estava gravado antes de o plugin subir', async () => {
    // Sem esta leitura, a primeira tela depois de um reinício mostraria zero
    // empresas para quem tem empresa gravada.
    const { ctx, empresas, runtime } = contexto()
    empresas.registros.set('emp-1', {
      business_id: 'emp-1', org_id: 'org-a', tenant_id: 'tenant-a', nome: 'Bolos da Ana',
      origem: 'criada', identidade_juridica_declarada: null, created_by: 'user-a',
      created_at: '2026-09-17T12:00:00.000Z', updated_at: '2026-09-17T12:00:00.000Z', archived_at: null,
    })
    await apply(ctx as never)
    expect(runtime().service.list(ana).map(empresa => empresa.nome)).toEqual(['Bolos da Ana'])
  })
})

describe('o repositório sobre as tabelas', () => {
  it('a empresa gravada é lida de volta pela CHAVE dela', async () => {
    const empresas = tabela<Empresa>()
    const planos = tabela<RegistroDePlano>()
    const repositorio = new DomainBusinessRepository(empresas as never, planos as never, tabela<VinculoDeTarefa>() as never, tabela<RegistroDeOferta>() as never)
    const empresa: Empresa = {
      business_id: 'emp-1', org_id: 'org-a', tenant_id: 'tenant-a', nome: 'Bolos da Ana',
      origem: 'criada', identidade_juridica_declarada: null, created_by: 'user-a',
      created_at: '2026-09-17T12:00:00.000Z', updated_at: '2026-09-17T12:00:00.000Z', archived_at: null,
    }
    await repositorio.putBusiness(empresa)
    expect(empresas.get('emp-1' as BusinessKey)).toBe(empresa)
    expect(repositorio.businesses()).toEqual([empresa])
  })

  it('o plano é gravado pelo `plan_id`, e NÃO pelo `business_id`', async () => {
    // Com a chave errada, a segunda versão do plano sobrescreveria a primeira —
    // e o histórico que o produto promete guardar sumiria em silêncio.
    const empresas = tabela<Empresa>()
    const planos = tabela<RegistroDePlano>()
    const repositorio = new DomainBusinessRepository(empresas as never, planos as never, tabela<VinculoDeTarefa>() as never, tabela<RegistroDeOferta>() as never)
    const base = {
      business_id: 'emp-1', org_id: 'org-a', tenant_id: 'tenant-a', plano: PLANO,
      created_by: 'user-a', created_at: '2026-09-17T12:00:00.000Z',
    }
    await repositorio.putPlan({ ...base, plan_id: 'plan-1', version: 1 })
    await repositorio.putPlan({ ...base, plan_id: 'plan-2', version: 2 })
    expect([...planos.registros.keys()]).toEqual(['plan-1', 'plan-2'])
    expect(repositorio.plans().map(registro => registro.version)).toEqual([1, 2])
  })

  it('o vínculo é gravado pelo PROJETO: uma tarefa pertence a no máximo uma empresa', async () => {
    // Com o `link_id` na chave, dois vínculos para o mesmo projeto conviveriam,
    // e a pergunta "de quem é esta tarefa?" teria duas respostas.
    const vinculos = tabela<VinculoDeTarefa>()
    const repositorio = new DomainBusinessRepository(tabela<Empresa>() as never, tabela<RegistroDePlano>() as never, vinculos as never, tabela<RegistroDeOferta>() as never)
    const base = {
      business_id: 'emp-1', project_id: 'proj-1', org_id: 'org-a', tenant_id: 'tenant-a',
      plan_version: 1, created_by: 'user-a', created_at: '2026-09-17T12:00:00.000Z',
    }
    await repositorio.putLink({ ...base, link_id: 'v-1' })
    await repositorio.putLink({ ...base, link_id: 'v-2', business_id: 'emp-2' })
    expect([...vinculos.registros.keys()]).toEqual(['proj-1'])
    expect(repositorio.links()).toEqual([{ ...base, link_id: 'v-2', business_id: 'emp-2' }])
  })

  it('a leitura NÃO é um retrato tirado na montagem: o que outra escrita gravou aparece', async () => {
    // Uma cópia em memória ao lado da tabela seria uma segunda verdade, e
    // divergiria na primeira escrita que não passasse por este repositório.
    const empresas = tabela<Empresa>()
    const repositorio = new DomainBusinessRepository(empresas as never, tabela<RegistroDePlano>() as never, tabela<VinculoDeTarefa>() as never, tabela<RegistroDeOferta>() as never)
    expect(repositorio.businesses()).toHaveLength(0)
    empresas.registros.set('emp-9', { business_id: 'emp-9' } as Empresa)
    expect(repositorio.businesses()).toHaveLength(1)
  })
})

describe('o repositório de ofertas', () => {
  it('a oferta é gravada pela VERSÃO, e não pela oferta', async () => {
    // Com a `offer_key` na chave, gravar a versão 2 apagaria a 1, e "sob que
    // condições este pedido foi aceito?" ficaria sem resposta no primeiro
    // reajuste de preço.
    const ofertas = tabela<RegistroDeOferta>()
    const repositorio = new DomainBusinessRepository(
      tabela<Empresa>() as never, tabela<RegistroDePlano>() as never, tabela<VinculoDeTarefa>() as never, ofertas as never,
    )
    const base = {
      offer_key: 'of-1', business_id: 'emp-1', org_id: 'org-a', tenant_id: 'tenant-a',
      oferta: {
        nome: 'Bolo', entrega: 'Um bolo de dois quilos, decorado.', publico: 'Famílias',
        preco: 200, moeda: 'BRL', capacidade: { quantidade: 4, periodo: 'semana' as const },
        condicoes: [], custos: [],
      },
      created_by: 'user-a', created_at: '2026-09-18T12:00:00.000Z',
      approved_at: null, approved_by: null,
    }
    await repositorio.putOffer({ ...base, offer_version_id: 'ov-1', version: 1 })
    await repositorio.putOffer({ ...base, offer_version_id: 'ov-2', version: 2 })
    expect([...ofertas.registros.keys()]).toEqual(['ov-1', 'ov-2'])
    expect(repositorio.offers().map(registro => registro.version)).toEqual([1, 2])
  })

  it('a leitura das ofertas também vê o que outra escrita gravou', async () => {
    const ofertas = tabela<RegistroDeOferta>()
    const repositorio = new DomainBusinessRepository(
      tabela<Empresa>() as never, tabela<RegistroDePlano>() as never, tabela<VinculoDeTarefa>() as never, ofertas as never,
    )
    expect(repositorio.offers()).toHaveLength(0)
    ofertas.registros.set('ov-9', { offer_version_id: 'ov-9' } as RegistroDeOferta)
    expect(repositorio.offers()).toHaveLength(1)
  })
})
