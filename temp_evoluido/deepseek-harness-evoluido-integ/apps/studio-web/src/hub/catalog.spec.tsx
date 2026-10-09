import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import t from '../i18n/hub.pt-BR.json'
import { IntegrationCatalogList } from './HubPanel'
import { catalogSearch, type Integration, type IntegrationCatalog } from './hubApi'
import { catalogCount, catalogEmptyKind, catalogEmptyMessage, costLabel, healthCounts, healthLabel, type IntegrationHealth } from './presentation'

function integration(overrides: Partial<Integration> = {}): Integration {
  return {
    integration_id: 'i-1', kind: 'skill', name: 'Agenda', effective_tier: 'T0', verification: 'verified',
    enabled: false, secret_ref: null, updated_at: '2026-09-04T00:00:00.000Z', can_enable: true, requires_approval_tier: null,
    ...overrides,
  }
}

function health(overrides: Partial<IntegrationHealth> = {}): IntegrationHealth {
  return {
    state: 'NOT_EXECUTED', calls: 0, failures: 0, timeouts: 0, retries: 0,
    average_latency_ms: null, last_call_at: null, last_failure: null, cost_state: 'UNKNOWN', cost_usd: 0,
    ...overrides,
  }
}

function page(overrides: Partial<IntegrationCatalog> = {}): IntegrationCatalog {
  return { channel: 'stable', integrations: [], next_cursor: null, total: 1, matched: 1, ...overrides }
}

function render(props: Partial<Parameters<typeof IntegrationCatalogList>[0]> = {}): string {
  return renderToStaticMarkup(createElement(IntegrationCatalogList, {
    rows: [integration()], page: page(), search: '', busy: false, loadingMore: false,
    onEnable: () => undefined, onDisable: () => undefined, onMore: () => undefined,
    onTest: () => undefined, onRemove: () => undefined, tests: {},
    ...props,
  }))
}

describe('catálogo do Hub na tela', () => {
  it('a pergunta vai para o servidor, e um campo vazio não vira filtro', () => {
    expect(catalogSearch({ search: '  salão  ', kind: 'webhook', status: 'enabled', limit: 20 }))
      .toBe('?q=sal%C3%A3o&kind=webhook&status=enabled&limit=20')
    // Buscar nada, sem filtro, é pedir o catálogo — não uma pergunta vazia que o
    // servidor teria de interpretar.
    expect(catalogSearch({ search: '   ', kind: 'all', status: 'all' })).toBe('')
    expect(catalogSearch({})).toBe('')
    expect(catalogSearch({ cursor: 'abc', limit: 20 })).toBe('?limit=20&cursor=abc')
  })

  it('distingue "nada encontrado" de "você ainda não tem integração"', () => {
    expect(catalogEmptyKind({ total: 3, matched: 2 })).toBe('none')
    expect(catalogEmptyKind({ total: 3, matched: 0 })).toBe('search')
    expect(catalogEmptyKind({ total: 0, matched: 0 })).toBe('catalog')
    // Catálogo vazio: a frase manda registrar, não corrigir a busca.
    expect(catalogEmptyMessage({ total: 0, matched: 0 }, 'salao')).toBe(t.integrations.empty)
    // Busca sem resultado: a frase cita o termo e diz que o catálogo continua lá.
    const notFound = catalogEmptyMessage({ total: 3, matched: 0 }, ' salao ')
    expect(notFound).toContain('salao')
    expect(notFound).not.toBe(t.integrations.empty)
    // Filtro sem termo: não há o que citar, e a frase fala dos filtros.
    expect(catalogEmptyMessage({ total: 3, matched: 0 }, '')).toBe(t.integrations.noneMatchFilters)
    expect(catalogEmptyMessage({ total: 3, matched: 3 }, '')).toBeNull()
  })

  it('as duas telas vazias são de fato diferentes na marcação', () => {
    const emptyCatalog = render({ rows: [], page: page({ total: 0, matched: 0 }), search: 'salao' })
    const nothingFound = render({ rows: [], page: page({ total: 4, matched: 0 }), search: 'salao' })
    expect(emptyCatalog).toContain(t.integrations.empty)
    expect(nothingFound).not.toContain(t.integrations.empty)
    expect(nothingFound).toContain('salao')
  })

  it('antes da primeira resposta a tela não afirma que o catálogo está vazio', () => {
    const loading = render({ rows: null, page: null })
    expect(loading).toContain(t.loading)
    // Dizer "você não tem nenhuma" sem ter lido nada é afirmar sobre o que a
    // pessoa registrou sem ter olhado.
    expect(loading).not.toContain(t.integrations.empty)
  })

  it('diz quantas está mostrando de quantas, e só oferece "carregar mais" quando há mais', () => {
    expect(catalogCount(2, { total: 9, matched: 5 })).toContain('2')
    expect(catalogCount(0, { total: 9, matched: 0 })).toBeNull()
    const withMore = render({ rows: [integration()], page: page({ total: 9, matched: 9, next_cursor: 'c1' }) })
    expect(withMore).toContain(t.integrations.loadMore)
    const lastPage = render({ rows: [integration()], page: page({ total: 1, matched: 1, next_cursor: null }) })
    // Sem cursor a lista acabou: oferecer "carregar mais" prometeria uma página que não existe.
    expect(lastPage).not.toContain(t.integrations.loadMore)
  })

  it('nunca escreve "OK" para uma integração que nunca foi chamada', () => {
    expect(healthLabel('NOT_EXECUTED')).toBe(t.integrations.health.NOT_EXECUTED)
    for (const state of ['OK', 'DEGRADED', 'DOWN', 'NOT_EXECUTED']) expect(healthLabel(state)).not.toBe(state)
    const markup = render({ rows: [integration({ health: health() })] })
    expect(markup).toContain(t.integrations.health.NOT_EXECUTED)
    expect(markup).not.toContain(t.integrations.health.OK)
    expect(healthCounts({ calls: 3, failures: 1 })).toContain('3')
  })

  it('sem preço conhecido a tela diz "desconhecido", nunca zero', () => {
    // Um "US$ 0,00" seria lido como "essa integração é de graça", que é
    // exatamente o que ninguém mediu.
    const unknown = costLabel({ cost_state: 'UNKNOWN', cost_usd: 0 })
    expect(unknown).toBe(t.integrations.cost.unknown)
    expect(unknown).not.toMatch(/0,00/u)
    expect(costLabel({ cost_state: 'PARTIAL', cost_usd: 1.5 })).toContain('1,50')
    expect(costLabel({ cost_state: 'MEASURED', cost_usd: 1.5 })).toContain('1,50')
    // O piso é anunciado como piso: "pelo menos", não como total.
    expect(costLabel({ cost_state: 'PARTIAL', cost_usd: 1.5 })).not.toBe(costLabel({ cost_state: 'MEASURED', cost_usd: 1.5 }))
    const markup = render({ rows: [integration({ health: health({ state: 'OK', calls: 2, unpriced_calls: 2 } as Partial<IntegrationHealth>) })] })
    expect(markup).toContain(t.integrations.cost.unknown)
  })

  it('um Studio que ainda não publica saúde não vira "OK" na tela', () => {
    const markup = render({ rows: [integration()] })
    // Sem o dado, nada é afirmado: nem saúde, nem custo.
    expect(markup).not.toContain(t.integrations.healthTitle)
    expect(markup).not.toContain(t.integrations.cost.unknown)
  })

  it('a caixa de busca tem rótulo, e os filtros também', () => {
    // Um campo de busca sem rótulo é invisível para quem usa leitor de tela.
    expect(t.integrations.searchLabel.trim()).not.toBe('')
    expect(t.integrations.kindLabel.trim()).not.toBe('')
    expect(t.integrations.statusLabel.trim()).not.toBe('')
  })
})

describe('X-04 — testar e remover na tela', () => {
  it('oferece testar e remover em cada integração', () => {
    const html = render()
    expect(html).toContain('Testar conexão')
    expect(html).toContain('Remover')
  })

  it('remover fica DESABILITADO com a integração ligada, e a tela DIZ por quê', () => {
    // Um botão apagado sem explicação vira "o produto travou".
    const html = render({ rows: [integration({ enabled: true })] })
    const remove = html.slice(0, html.indexOf('Remover'))
    expect(remove.slice(-120)).toContain('disabled')
    expect(html).toContain('Desligue antes de remover')
  })

  it('desligada, remover fica habilitado e o aviso some', () => {
    const html = render({ rows: [integration({ enabled: false })] })
    expect(html).not.toContain('Desligue antes de remover')
  })

  it('o resultado do teste aparece NA LINHA, com peso diferente para cada desfecho', () => {
    const id = integration().integration_id
    expect(render({ tests: { [id]: { result: 'OK', message: 'Conexão feita com "agenda".' } } }))
      .toContain('hub-test ok')
    expect(render({ tests: { [id]: { result: 'FAILED', message: 'não deu certo' } } }))
      .toContain('hub-test error')
    // NOT_APPLICABLE não é erro: uma habilidade que não tem com quem conectar
    // não falhou em nada.
    expect(render({ tests: { [id]: { result: 'NOT_APPLICABLE', message: 'não há conexão para testar' } } }))
      .toContain('hub-test info')
    expect(render({ tests: { [id]: { result: 'NOT_EXECUTED', message: 'está desligada' } } }))
      .toContain('hub-test info')
  })

  it('enquanto o teste corre, a tela NÃO afirma nada sobre o resultado', () => {
    const id = integration().integration_id
    const html = render({ tests: { [id]: 'RUNNING' } })
    expect(html).toContain('Testando…')
    expect(html).not.toContain('integration-test-result')
  })

  it('ninguém testou: nenhuma frase de resultado', () => {
    expect(render()).not.toContain('integration-test-result')
  })
})

describe('o texto da habilidade, NA TELA (T-11)', () => {
  const assinada = integration({ manifest: { skill: { body_chars: 12 } } })

  it('o bloco NÃO aparece num servidor que ainda não tem a rota', () => {
    // Mesma regra do `addSlice` na tela do plano: sem a porta, o bloco some —
    // em vez de aparecer um botão que responde 404 na cara de quem não programa.
    expect(render({ rows: [assinada] })).not.toContain('data-testid="skill-body"')
  })

  it('com a rota, o bloco aparece para HABILIDADE', () => {
    const html = render({ rows: [assinada], onInstallSkillBody: async () => undefined })
    expect(html).toContain('data-testid="skill-body"')
    expect(html).toContain(t.integrations.skillBodyTitle)
    expect(html).toContain('data-testid="skill-body-input"')
  })

  it('e NÃO aparece para o que não é habilidade', () => {
    const mcp = integration({ kind: 'mcp', manifest: { skill: { body_chars: 12 } } })
    expect(render({ rows: [mcp], onInstallSkillBody: async () => undefined })).not.toContain('data-testid="skill-body"')
  })

  it('habilidade NÃO assinada mostra o motivo, e NENHUM campo', () => {
    // Um campo que o servidor vai recusar é pior que campo nenhum: a pessoa
    // cola sessenta mil caracteres e recebe um 403.
    const html = render({ rows: [integration({ verification: 'unverified', manifest: { skill: { body_chars: 12 } } })], onInstallSkillBody: async () => undefined })
    expect(html).toContain('data-testid="skill-body"')
    expect(html).toContain(t.integrations.skillBodyNotVerified)
    expect(html).not.toContain('data-testid="skill-body-input"')
  })

  it('o botão nasce DESLIGADO: campo vazio nunca tem o tamanho exato', () => {
    const html = render({ rows: [assinada], onInstallSkillBody: async () => undefined })
    // A fatia comeca no `<button` que contem o testid, e nao no testid: os
    // atributos vem ANTES dele, e cortar ali esconderia justamente o `disabled`.
    const fim = html.indexOf('skill-body-install')
    const botao = html.slice(html.lastIndexOf('<button', fim), fim)
    expect(botao).toContain('disabled')
  })

  it('a tela diz se JÁ há texto instalado', () => {
    const comTexto = integration({ skill_body_installed: true, manifest: { skill: { body_chars: 12 } } })
    expect(render({ rows: [comTexto], onInstallSkillBody: async () => undefined })).toContain(t.integrations.skillBodyInstalled)
    expect(render({ rows: [assinada], onInstallSkillBody: async () => undefined })).toContain(t.integrations.skillBodyNotInstalled)
  })
})
