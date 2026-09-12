import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_REASONS,
  PROBE_FRESHNESS_MS,
  STUDIO_CAPABILITY_IDS,
  type StudioSignals,
  studioCapabilities,
  type CapabilityDeclaration,
  type ProbeResult,
  capabilityMessage,
  capabilityStatuses,
  capabilitySummary,
  healthCapabilities,
} from '../src/capability-registry.js'

const NOW = new Date('2026-09-12T12:00:00.000Z')
const recently = new Date(NOW.getTime() - 60_000)

function declare(id: string, overrides: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return { id, present: true, probed: true, configured: true, ...overrides }
}

function ok(capability: string, at = recently): ProbeResult {
  return { capability, ok: true, at }
}

function statuses(declarations: readonly CapabilityDeclaration[], probes: readonly ProbeResult[] = []) {
  return capabilityStatuses(declarations, probes, { now: NOW })
}

describe('o caminho ate OPERATIONAL', () => {
  it('presente, configurada e sondada com sucesso agora e OPERACIONAL', () => {
    const [status] = statuses([declare('criar-aplicativo')], [ok('criar-aplicativo')])
    expect(status).toEqual({ id: 'criar-aplicativo', state: 'OPERATIONAL', probedAt: recently })
  })

  it('a ordem das declaracoes nao muda a resposta', () => {
    const cima = declare('painel', { requires: ['banco'] })
    const baixo = declare('banco')
    const primeiro = statuses([cima, baixo], [ok('banco'), ok('painel')])
    const segundo = statuses([baixo, cima], [ok('banco'), ok('painel')])
    expect(primeiro.find(status => status.id === 'painel')).toEqual(segundo.find(status => status.id === 'painel'))
  })
})

describe('nada aqui e declarado pronto', () => {
  it('codigo ausente e AUSENTE, e nunca desconhecido', () => {
    const [status] = statuses([declare('agenda', { present: false })])
    expect(status).toMatchObject({ state: 'ABSENT', reason: 'CODE_ABSENT' })
  })

  it('sem configuracao ela para em PRESENTE', () => {
    const [status] = statuses([declare('integracoes', { configured: false })], [ok('integracoes')])
    // Mesmo COM sondagem boa: uma sondagem de uma capacidade sem configuracao
    // exercitou outra coisa.
    expect(status).toMatchObject({ state: 'PRESENT', reason: 'NOT_CONFIGURED' })
  })

  it('capacidade SEM sondagem nunca chega a OPERACIONAL', () => {
    // E uma afirmacao honesta e permanente: ninguem sabe exercitar isto
    // sozinho, entao ninguem pode dizer que funciona agora.
    const [status] = statuses([declare('acessibilidade', { probed: false })])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'NO_PROBE' })
  })

  it('sondavel e NUNCA sondada nao e a mesma coisa que nao sondavel', () => {
    const [status] = statuses([declare('previa')])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'NEVER_PROBED' })
  })

  it('sondagem que REPROVOU derruba para CONFIGURADA, com a data', () => {
    const [status] = statuses([declare('previa')], [{ capability: 'previa', ok: false, at: recently }])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_FAILED', probedAt: recently })
  })
})

describe('a janela: OPERACIONAL nao pode virar memoria', () => {
  it('sondagem velha demais deixa de sustentar OPERACIONAL', () => {
    const velha = new Date(NOW.getTime() - PROBE_FRESHNESS_MS - 1)
    const [status] = statuses([declare('previa')], [ok('previa', velha)])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_STALE' })
  })

  it('exatamente na borda da janela ainda sustenta', () => {
    const borda = new Date(NOW.getTime() - PROBE_FRESHNESS_MS)
    const [status] = statuses([declare('previa')], [ok('previa', borda)])
    expect(status!.state).toBe('OPERATIONAL')
  })

  it('sondagem do FUTURO conta como vencida', () => {
    // Um relogio adiantado sustentaria OPERACIONAL para sempre.
    const futuro = new Date(NOW.getTime() + 10_000)
    const [status] = statuses([declare('previa')], [ok('previa', futuro)])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_STALE' })
  })

  it('vale a sondagem MAIS RECENTE, e nao a melhor noticia', () => {
    const [status] = statuses([declare('previa')], [
      ok('previa', new Date(NOW.getTime() - 600_000)),
      { capability: 'previa', ok: false, at: recently },
    ])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_FAILED' })
  })

  it('a ordem em que as sondagens chegam nao muda qual delas vale', () => {
    const antiga = ok('previa', new Date(NOW.getTime() - 600_000))
    const nova: ProbeResult = { capability: 'previa', ok: false, at: recently }
    expect(statuses([declare('previa')], [nova, antiga])[0]).toMatchObject({ reason: 'PROBE_FAILED' })
    expect(statuses([declare('previa')], [antiga, nova])[0]).toMatchObject({ reason: 'PROBE_FAILED' })
  })

  it('sondagem de OUTRA capacidade nao serve para esta', () => {
    const [status] = statuses([declare('previa')], [ok('agenda')])
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'NEVER_PROBED' })
  })
})

describe('dependencias: nunca melhor do que a base', () => {
  it('dependencia nao operacional segura a de cima, e diz QUAL', () => {
    const status = statuses(
      [declare('painel', { requires: ['banco'] }), declare('banco')],
      [ok('painel')],
    ).find(item => item.id === 'painel')
    expect(status).toMatchObject({ state: 'CONFIGURED', reason: 'DEPENDENCY', blockedBy: 'banco' })
  })

  it('dependencia AUSENTE nao torna a de cima ausente: o codigo dela esta la', () => {
    const status = statuses(
      [declare('painel', { requires: ['banco'] }), declare('banco', { present: false })],
      [ok('painel')],
    ).find(item => item.id === 'painel')
    expect(status).toMatchObject({ state: 'PRESENT', reason: 'DEPENDENCY', blockedBy: 'banco' })
  })

  it('a dependencia vence a propria sondagem boa', () => {
    // Sondar a camada de cima com a de baixo caida produz um OPERACIONAL que a
    // proxima chamada de verdade desmente.
    const status = statuses(
      [declare('painel', { requires: ['banco'] }), declare('banco', { probed: false })],
      [ok('painel')],
    ).find(item => item.id === 'painel')
    expect(status!.state).not.toBe('OPERATIONAL')
  })

  it('dependencia NAO DECLARADA e desconhecida, e nunca silencio', () => {
    const status = statuses([declare('painel', { requires: ['fantasma'] })], [ok('painel')]).find(item => item.id === 'painel')
    expect(status).toMatchObject({ state: 'UNKNOWN', reason: 'DEPENDENCY', blockedBy: 'fantasma' })
  })

  it('a cadeia inteira segura: o que trava embaixo trava em cima', () => {
    const result = statuses([
      declare('tela', { requires: ['painel'] }),
      declare('painel', { requires: ['banco'] }),
      declare('banco', { present: false }),
    ], [ok('tela'), ok('painel')])
    expect(result.find(item => item.id === 'tela')!.state).not.toBe('OPERATIONAL')
    expect(result.find(item => item.id === 'painel')!.state).not.toBe('OPERATIONAL')
  })

  it('ciclo entre dependencias nao derruba o relatorio inteiro', () => {
    // Lancar aqui apagaria o relatorio que alguem esta lendo justamente para
    // descobrir que algo esta errado.
    const result = statuses([
      declare('a', { requires: ['b'] }),
      declare('b', { requires: ['a'] }),
      declare('sozinha'),
    ], [ok('a'), ok('b'), ok('sozinha')])
    expect(result.find(item => item.id === 'sozinha')!.state).toBe('OPERATIONAL')
    expect(result.find(item => item.id === 'a')!.state).not.toBe('OPERATIONAL')
  })

  it('todas as declaracoes saem no resultado, na ordem em que foram declaradas', () => {
    const result = statuses([declare('um'), declare('dois'), declare('tres')])
    expect(result.map(item => item.id)).toEqual(['um', 'dois', 'tres'])
  })
})

describe('capabilitySummary', () => {
  it('desconhecida sai SEPARADA de nao operacional', () => {
    // Juntar as duas apagaria exatamente a ignorancia que este registro existe
    // para tornar visivel.
    const result = capabilitySummary(statuses([
      declare('viva'),
      declare('parada', { configured: false }),
      declare('misteriosa', { requires: ['fantasma'] }),
    ], [ok('viva')]))
    expect(result).toEqual({ operational: 1, notOperational: 1, unknown: 1 })
  })

  it('lista vazia conta zero em tudo, sem inventar otimismo', () => {
    expect(capabilitySummary([])).toEqual({ operational: 0, notOperational: 0, unknown: 0 })
  })
})

describe('capabilityMessage', () => {
  it('a operacional nao diz nada', () => {
    expect(capabilityMessage(statuses([declare('previa')], [ok('previa')])[0]!)).toBeUndefined()
  })

  it('a frase de dependencia nomeia QUEM segura', () => {
    const status = statuses([declare('painel', { requires: ['banco'] }), declare('banco', { present: false })], [])
      .find(item => item.id === 'painel')!
    const message = capabilityMessage(status)
    expect(message).toContain('painel')
    expect(message).toContain('banco')
  })

  it('cada motivo tem frase propria, e elas nao se repetem', () => {
    const frases = [
      capabilityMessage(statuses([declare('a', { present: false })])[0]!),
      capabilityMessage(statuses([declare('b', { configured: false })])[0]!),
      capabilityMessage(statuses([declare('c', { probed: false })])[0]!),
      capabilityMessage(statuses([declare('d')])[0]!),
    ]
    expect(new Set(frases).size).toBe(frases.length)
    for (const frase of frases) expect(frase).toBeDefined()
  })

  it('TODOS os motivos tem frase: nenhum fica sem por esquecimento', () => {
    // A chave e montada a partir do motivo, e o portao de i18n nao ve nomes
    // montados. Sem este laco, um motivo novo sem frase so apareceria como
    // excecao na tela de alguem.
    for (const reason of CAPABILITY_REASONS) {
      const message = capabilityMessage({ id: 'x', state: 'CONFIGURED', reason, blockedBy: 'y' })
      expect(message, reason).toBeDefined()
      expect(message, reason).toContain('x')
    }
  })

  it('a frase de nunca sondada NAO diz que algo deu errado', () => {
    const message = capabilityMessage(statuses([declare('previa')])[0]!) ?? ''
    expect(message).not.toMatch(/falhou|erro|quebr/iu)
  })
})

describe('studioCapabilities — os sinais REAIS viram declaracao', () => {
  function signals(overrides: Partial<StudioSignals> = {}): StudioSignals {
    return {
      routes: [{ route: 'ollama', state: 'OK', exercised: true, at: recently }],
      builder: { available: true, at: recently },
      lastRun: { passed: true, at: recently },
      storage: { ok: true, at: NOW },
      categories: ['landing-page'],
      ...overrides,
    }
  }

  function run(overrides: Partial<StudioSignals> = {}) {
    const { declarations, probes } = studioCapabilities(signals(overrides))
    return capabilityStatuses(declarations, probes, { now: NOW })
  }

  function stateOf(result: readonly { id: string; state: string }[], id: string) {
    return result.find(item => item.id === id)!.state
  }

  it('tudo respondendo deixa a criacao de aplicativo OPERACIONAL', () => {
    const result = run()
    for (const id of STUDIO_CAPABILITY_IDS) expect(stateOf(result, id), id).toBe('OPERATIONAL')
  })

  it('esta funcao NAO decide estado: ela so relata o que existe e o que se viu', () => {
    // Se ela decidisse, a regra de "sondagem velha nao sustenta operacional"
    // teria de ser repetida aqui — e regra repetida em dois lugares diverge.
    const { declarations } = studioCapabilities(signals({ routes: [{ route: 'ollama', state: 'DOWN', exercised: true, at: recently }] }))
    expect(declarations.find(item => item.id === 'modelo')).toMatchObject({ configured: true, probed: true })
  })

  it('rota NAO CONFIGURADA nao vira sondagem que falhou', () => {
    // Registra-la como falha diria que algo quebrou onde o que houve foi
    // ninguem ter configurado.
    const { probes } = studioCapabilities(signals({ routes: [{ route: 'ollama', state: 'NOT_CONFIGURED', exercised: true, at: recently }] }))
    expect(probes.filter(probe => probe.capability === 'modelo')).toHaveLength(0)
    const result = run({ routes: [{ route: 'ollama', state: 'NOT_CONFIGURED', exercised: true, at: recently }] })
    expect(stateOf(result, 'modelo')).toBe('PRESENT')
  })

  it('rota sem data nao entra como sondagem', () => {
    // Uma sondagem sem instante nao sustenta nem vence.
    const { probes } = studioCapabilities(signals({ routes: [{ route: 'ollama', state: 'OK', exercised: true }] }))
    expect(probes.filter(probe => probe.capability === 'modelo')).toHaveLength(0)
  })

  it('o modelo caido segura a criacao de aplicativo, e diz que e ele', () => {
    const result = run({ routes: [{ route: 'ollama', state: 'DOWN', exercised: true, at: recently }] })
    expect(stateOf(result, 'criar-aplicativo')).not.toBe('OPERATIONAL')
    expect(result.find(item => item.id === 'criar-aplicativo')).toMatchObject({ blockedBy: 'modelo' })
  })

  it('o construtor indisponivel segura a criacao de aplicativo', () => {
    const result = run({ builder: { available: false, at: recently } })
    expect(result.find(item => item.id === 'criar-aplicativo')).toMatchObject({ blockedBy: 'construtor' })
  })

  it('armazenamento que NAO respondeu e sondagem REPROVADA', () => {
    const result = run({ storage: { ok: false, at: NOW } })
    expect(result.find(item => item.id === 'armazenamento')).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_FAILED' })
  })

  it('rota CONFIGURADA mas NUNCA EXERCITADA nao e sondagem', () => {
    // `initialize` grava `OK` para toda rota que aparece na configuracao, sem
    // ninguem ter chamado nada. Uma instalacao recem-subida com chave invalida
    // reportava `modelo: OPERACIONAL`.
    const result = run({ routes: [{ route: 'ollama', state: 'OK', exercised: false, at: recently }] })
    expect(result.find(item => item.id === 'modelo')).toMatchObject({ state: 'CONFIGURED', reason: 'NEVER_PROBED' })
  })

  it('as rotas sao ALTERNATIVAS: uma caida entre boas nao derruba o modelo', () => {
    // Eleger "a mais recente" entre elas fazia a resposta depender de qual linha
    // o armazenamento devolveu primeiro — com uma caida na frente, a tela dizia
    // "nao da agora" sobre um Studio que criaria o aplicativo sem problema.
    const mesmoInstante = [
      { route: 'caida', state: 'DOWN' as const, exercised: true, at: recently },
      { route: 'boa', state: 'OK' as const, exercised: true, at: recently },
    ]
    expect(run({ routes: mesmoInstante }).find(item => item.id === 'modelo')!.state).toBe('OPERATIONAL')
    // E a ordem nao muda nada.
    expect(run({ routes: [...mesmoInstante].reverse() }).find(item => item.id === 'modelo')!.state).toBe('OPERATIONAL')
  })

  it('TODAS caidas derrubam o modelo, com a falha mais recente', () => {
    const result = run({ routes: [
      { route: 'a', state: 'DOWN', exercised: true, at: new Date(NOW.getTime() - 600_000) },
      { route: 'b', state: 'DOWN', exercised: true, at: recently },
    ] })
    expect(result.find(item => item.id === 'modelo')).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_FAILED' })
  })

  it('o instante vem do REGISTRO, e nao da leitura: sondagem velha VENCE', () => {
    // Carimbar a leitura fazia a idade ser sempre zero, e a janela de validade
    // nunca expirava nada — a guarda de relogio adiantado virava codigo morto.
    const velha = new Date(NOW.getTime() - PROBE_FRESHNESS_MS - 1)
    const result = run({ routes: [{ route: 'ollama', state: 'OK', exercised: true, at: velha }] })
    expect(result.find(item => item.id === 'modelo')).toMatchObject({ state: 'CONFIGURED', reason: 'PROBE_STALE' })
  })

  it('construtor nunca perguntado nao e construtor indisponivel', () => {
    const { builder: _ignored, ...semConstrutor } = signals()
    const { declarations, probes } = studioCapabilities(semConstrutor)
    const result = capabilityStatuses(declarations, probes, { now: NOW })
    expect(result.find(item => item.id === 'construtor')).toMatchObject({ state: 'CONFIGURED', reason: 'NEVER_PROBED' })
  })

  it('nenhuma categoria gerada torna a criacao de aplicativo AUSENTE', () => {
    const result = run({ categories: [] })
    expect(stateOf(result, 'criar-aplicativo')).toBe('ABSENT')
  })

  it('uma criacao que REPROVOU nao deixa a capacidade operacional', () => {
    const result = run({ lastRun: { passed: false, at: recently } })
    expect(result.find(item => item.id === 'criar-aplicativo')).toMatchObject({ reason: 'PROBE_FAILED' })
  })

  it('UMA rota boa entre varias ruins ja sustenta o modelo', () => {
    // A sondagem mais recente vale, e uma rota que responde e o bastante para
    // a pessoa conseguir criar alguma coisa.
    const result = run({ routes: [
      { route: 'ruim', state: 'DOWN', exercised: true, at: new Date(NOW.getTime() - 600_000) },
      { route: 'boa', state: 'OK', exercised: true, at: recently },
    ] })
    expect(stateOf(result, 'modelo')).toBe('OPERATIONAL')
  })
})

describe('healthCapabilities — a ponte com o endereco de saude', () => {
  function bridge(overrides: Partial<Parameters<typeof healthCapabilities>[0]> = {}) {
    return healthCapabilities({
      routes: [{ route: 'ollama', state: 'OK', exercised: true, at: recently }],
      builderState: 'OK',
      storage: { ok: true, at: NOW },
      categories: ['landing-page'],
      now: NOW,
      ...overrides,
    })
  }

  function stateOf(result: ReturnType<typeof bridge>, id: string) {
    return result.find(item => item.id === id)!.state
  }

  it('dependencias boas NAO provam que criar um aplicativo funciona', () => {
    // Este e o salto que o registro existe para impedir. O endereco de saude
    // nao cria aplicativo nenhum para descobrir: ele confere as PECAS. Dizer
    // OPERACIONAL a partir delas seria afirmar a cadeia inteira por inducao.
    const result = bridge()
    expect(stateOf(result, 'modelo')).toBe('OPERATIONAL')
    expect(stateOf(result, 'construtor')).toBe('OPERATIONAL')
    expect(result.find(item => item.id === 'criar-aplicativo')).toMatchObject({ state: 'CONFIGURED', reason: 'NEVER_PROBED' })
  })

  it('uma criacao que TERMINOU BEM e o que prova a cadeia', () => {
    const result = bridge({ lastRun: { passed: true, at: new Date(NOW.getTime() - 60_000) } })
    expect(stateOf(result, 'criar-aplicativo')).toBe('OPERATIONAL')
  })

  it('rota DEGRADADA ainda deixa o modelo operacional', () => {
    // Uma rota lenta ou com erro intermitente ainda cria; trata-la como caida
    // diria a pessoa que ela nao pode fazer o que ela consegue fazer.
    expect(stateOf(bridge({ routes: [{ route: 'ollama', state: 'DEGRADED', exercised: true, at: recently }] }), 'modelo')).toBe('OPERATIONAL')
  })

  it('rota CAIDA segura, e diz que foi o modelo', () => {
    const result = bridge({ routes: [{ route: 'ollama', state: 'DOWN', exercised: true, at: recently }] })
    expect(result.find(item => item.id === 'criar-aplicativo')).toMatchObject({ blocked_by: 'modelo' })
  })

  it('construtor bloqueado segura, e diz que foi o construtor', () => {
    const result = bridge({ builderState: 'BLOCKED_EXTERNAL' })
    expect(result.find(item => item.id === 'criar-aplicativo')).toMatchObject({ blocked_by: 'construtor' })
  })

  it('nenhuma rota configurada nao vira rota quebrada', () => {
    const result = bridge({ routes: [] })
    expect(result.find(item => item.id === 'modelo')).toMatchObject({ state: 'PRESENT', reason: 'NOT_CONFIGURED' })
  })

  it('o formato de saida usa nomes de campo do contrato, e nao os internos', () => {
    // `blockedBy` e nome de codigo; `blocked_by` e o que a rota publica promete.
    const result = bridge({ routes: [{ route: 'ollama', state: 'DOWN', exercised: true, at: recently }] })
    const blocked = result.find(item => item.id === 'criar-aplicativo')!
    expect(Object.keys(blocked).sort()).toEqual(['blocked_by', 'id', 'reason', 'state'])
  })

  it('capacidade operacional nao carrega motivo nenhum', () => {
    const operational = bridge().find(item => item.id === 'modelo')!
    expect(Object.keys(operational).sort()).toEqual(['id', 'state'])
  })

  it('as quatro capacidades saem sempre, mesmo quando nada funciona', () => {
    // Uma capacidade que some da lista quando esta ruim faria a lista parecer
    // saudavel justamente quando ela nao esta.
    const result = bridge({ routes: [], builderState: 'BLOCKED_EXTERNAL', storage: { ok: false, at: NOW }, categories: [] })
    expect(result.map(item => item.id).sort()).toEqual([...STUDIO_CAPABILITY_IDS].sort())
  })
})
