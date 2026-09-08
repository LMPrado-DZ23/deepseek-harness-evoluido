import { describe, expect, it } from 'vitest'
import {
  INTEGRATIONS_PAGE_MAX, INTEGRATIONS_PAGE_SIZE, boundedLimit, catalogOrder, decodeCatalogCursor, encodeCatalogCursor,
  matchesFilters, matchesSearch, normalizeSearch, pageOfIntegrations,
} from '../src/catalog.ts'
import type { IntegrationManifest, StudioIntegration } from '../src/model.ts'

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], ...overrides,
  } as IntegrationManifest
}

function integration(overrides: Partial<StudioIntegration> = {}): StudioIntegration {
  return {
    integration_id: 'i-1', org_id: 'org-a', tenant_id: 'ws-a', kind: 'skill', name: 'Agenda',
    manifest: manifest(), effective_tier: 'T0', verification: 'verified', enabled: false, secret_ref: null,
    created_by: 'u-1', created_at: '2026-09-04T00:00:00.000Z', updated_at: '2026-09-04T00:00:00.000Z',
    ...overrides,
  } as StudioIntegration
}

/** Um catálogo com nomes que uma pessoa deste país digitaria, e ids fora de ordem alfabética de propósito. */
function catalog(): StudioIntegration[] {
  return [
    integration({ integration_id: 'i-3', name: 'Salão de beleza', manifest: manifest({ id: 'salao', description: 'Agenda do salão' }) }),
    integration({ integration_id: 'i-1', name: 'Agenda', enabled: true }),
    integration({ integration_id: 'i-2', name: 'Boleto', kind: 'webhook', verification: 'unverified', manifest: manifest({ id: 'boleto', publisher: { id: 'acme', name: 'Acme Pagamentos' } }) }),
    integration({ integration_id: 'i-4', name: 'Correio', kind: 'mcp', enabled: true, verification: 'invalid', manifest: manifest({ id: 'correio' }) }),
  ]
}

describe('catálogo de integrações', () => {
  it('acha "Salão" para quem digita "salao", sem acento e sem caixa', () => {
    expect(normalizeSearch('  Salão DE Beleza ')).toBe('salao de beleza')
    const salao = catalog()[0]!
    expect(matchesSearch(salao, normalizeSearch('SALAO'))).toBe(true)
    expect(matchesSearch(salao, normalizeSearch('beleza'))).toBe(true)
    // Busca vazia não é filtro: ela não pode esconder ninguém.
    expect(matchesSearch(salao, '')).toBe(true)
  })

  it('procura no que a pessoa vê, e nunca no nome de um segredo do cofre', () => {
    const smtp = integration({ integration_id: 'i-5', kind: 'smtp', name: 'E-mail do aplicativo', manifest: null, secret_ref: 'DZ23_APP_SMTP' })
    expect(matchesSearch(smtp, normalizeSearch('e-mail'))).toBe(true)
    // Um acerto por `secret_ref` contaria a quem procurasse quais nomes existem no cofre.
    expect(matchesSearch(smtp, normalizeSearch('DZ23_APP_SMTP'))).toBe(false)
    // O publicador e a descrição do manifesto são públicos e entram na busca.
    expect(matchesSearch(catalog()[2]!, normalizeSearch('acme'))).toBe(true)
    expect(matchesSearch(catalog()[0]!, normalizeSearch('agenda do salao'))).toBe(true)
  })

  it('filtra por tipo, por estado e por verificação, e um filtro vazio não filtra nada', () => {
    const boleto = catalog()[2]!
    expect(matchesFilters(boleto, { kinds: ['webhook'] })).toBe(true)
    expect(matchesFilters(boleto, { kinds: ['skill'] })).toBe(false)
    expect(matchesFilters(boleto, { kinds: [] })).toBe(true)
    expect(matchesFilters(boleto, { status: 'disabled' })).toBe(true)
    expect(matchesFilters(boleto, { status: 'enabled' })).toBe(false)
    expect(matchesFilters(boleto, { status: 'all' })).toBe(true)
    expect(matchesFilters(boleto, { verifications: ['unverified'] })).toBe(true)
    expect(matchesFilters(boleto, { verifications: ['verified'] })).toBe(false)
  })

  it('diz quantas existem e quantas o filtro deixou passar, para a tela saber qual vazio é qual', () => {
    const rows = catalog()
    const nothingFound = pageOfIntegrations(rows, { search: 'não existe nada assim' })
    expect(nothingFound.integrations).toEqual([])
    // Nada encontrado PARA A BUSCA: o catálogo tem quatro.
    expect(nothingFound.matched).toBe(0)
    expect(nothingFound.total).toBe(4)
    const emptyCatalog = pageOfIntegrations([], { search: 'qualquer coisa' })
    // Catálogo vazio de verdade: não há o que procurar.
    expect(emptyCatalog.matched).toBe(0)
    expect(emptyCatalog.total).toBe(0)
  })

  it('ordena por nome como se lê e desempata pelo id, para a paginação não repetir nem pular', () => {
    const page = pageOfIntegrations(catalog())
    expect(page.integrations.map(row => row.name)).toEqual(['Agenda', 'Boleto', 'Correio', 'Salão de beleza'])
    const same = [integration({ integration_id: 'i-b', name: 'Igual' }), integration({ integration_id: 'i-a', name: 'Igual' })]
    expect(same.slice().sort(catalogOrder).map(row => row.integration_id)).toEqual(['i-a', 'i-b'])
  })

  it('pagina por chave: cada volta continua de onde parou e a última não oferece cursor', () => {
    const rows = catalog()
    const first = pageOfIntegrations(rows, { limit: 2 })
    expect(first.integrations.map(row => row.name)).toEqual(['Agenda', 'Boleto'])
    expect(first.next_cursor).not.toBeNull()
    const second = pageOfIntegrations(rows, { limit: 2, cursor: first.next_cursor! })
    expect(second.integrations.map(row => row.name)).toEqual(['Correio', 'Salão de beleza'])
    // A lista acabou exatamente aqui: sem cursor, o cliente não dá uma volta a mais para descobrir.
    expect(second.next_cursor).toBeNull()
  })

  it('o cursor sobrevive a nome com espaço, e apagar uma linha não faz a página seguinte pular outra', () => {
    const rows = [
      integration({ integration_id: 'i-1', name: 'E-mail do aplicativo' }),
      integration({ integration_id: 'i-2', name: 'Estoque' }),
      integration({ integration_id: 'i-3', name: 'Frete' }),
    ]
    const first = pageOfIntegrations(rows, { limit: 1 })
    expect(first.integrations[0]!.name).toBe('E-mail do aplicativo')
    expect(decodeCatalogCursor(first.next_cursor!)).toEqual({ name: 'e-mail do aplicativo', integrationId: 'i-1' })
    // A primeira sai do catálogo entre uma volta e outra: por deslocamento, "Estoque" seria pulada.
    const afterDeletion = pageOfIntegrations(rows.slice(1), { limit: 1, cursor: first.next_cursor! })
    expect(afterDeletion.integrations.map(row => row.name)).toEqual(['Estoque'])
  })

  it('recusa um cursor ilegível em vez de devolver, calado, a primeira página', () => {
    expect(decodeCatalogCursor(Buffer.from('sem-separador', 'utf8').toString('base64url'))).toBeUndefined()
    expect(() => pageOfIntegrations(catalog(), { cursor: 'nao-e-um-cursor' })).toThrow(RangeError)
  })

  it('o cursor é uma posição na ordem, não um número de página', () => {
    const row = integration({ integration_id: 'i-9', name: 'Ácido' })
    expect(decodeCatalogCursor(encodeCatalogCursor(row))).toEqual({ name: 'acido', integrationId: 'i-9' })
  })

  it('prende o limite pedido entre um e o teto, e um pedido sem limite recebe o padrão', () => {
    expect(boundedLimit(undefined)).toBe(INTEGRATIONS_PAGE_SIZE)
    expect(boundedLimit(Number.NaN)).toBe(INTEGRATIONS_PAGE_SIZE)
    expect(boundedLimit(0)).toBe(1)
    expect(boundedLimit(-5)).toBe(1)
    expect(boundedLimit(10_000)).toBe(INTEGRATIONS_PAGE_MAX)
    expect(boundedLimit(7.9)).toBe(7)
  })

  it('busca e filtro valem juntos, e o total do escopo continua sendo o do escopo', () => {
    const page = pageOfIntegrations(catalog(), { search: 'a', status: 'enabled' })
    expect(page.integrations.map(row => row.name)).toEqual(['Agenda'])
    expect(page.matched).toBe(1)
    expect(page.total).toBe(4)
  })
})
