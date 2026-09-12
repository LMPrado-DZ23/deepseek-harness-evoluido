import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import t from './i18n/pt-BR.json'
import { capabilityLines, creationBlocked, currentStepIndex, permanentTruthKind, privacyNotice, privacyProfileOf, resultSentence, routeReasonNotice, type PipelineResultState, type ProjectUiState } from './presentation'

describe('truthful presentation for nontechnical users', () => {
  it('maps the real machine states to the five visible stages', () => {
    const expected: Record<ProjectUiState, number> = {
      DRAFT: 1, SPEC_READY: 2, PLAN_PROPOSED: 2, PLAN_APPROVED: 3, GENERATING: 3,
      BUILD_OK: 3, BUILD_FAILED: 3, TESTS_OK: 4, TESTS_FAILED: 4, CANCELLED: 4, INTERRUPTED: 3, VERIFIED_PROTOTYPE: 4,
    }
    for (const [state, step] of Object.entries(expected)) expect(currentStepIndex(state as ProjectUiState)).toBe(step)
  })

  // A afirmação permanente é conferida em TODO estado, e não numa amostra: a
  // versão anterior testava nove dos doze e os três que faltavam eram
  // justamente `TESTS_FAILED`, `CANCELLED` e `PLAN_APPROVED` — os dois
  // primeiros diziam "Protótipo verificado" depois de o teste reprovar ou de a
  // pessoa cancelar.
  it('só chama de verificado o que tem verificação, e diz o resto como é', () => {
    const expected: Record<ProjectUiState, ReturnType<typeof permanentTruthKind>> = {
      DRAFT: null, SPEC_READY: null, PLAN_PROPOSED: null,
      PLAN_APPROVED: 'creation', GENERATING: 'creation', BUILD_OK: 'creation',
      BUILD_FAILED: 'creation', INTERRUPTED: 'creation', TESTS_OK: 'creation',
      TESTS_FAILED: 'unverified', CANCELLED: 'unverified',
      VERIFIED_PROTOTYPE: 'verified',
    }
    expect(permanentTruthKind(null)).toBeNull()
    for (const [state, truth] of Object.entries(expected)) {
      expect(permanentTruthKind(state as ProjectUiState), state).toBe(truth)
    }
    // E o texto de cada afirmação não pode dizer "verificado" sem ser.
    expect(t.truth.unverified).not.toMatch(/\bverificado\b(?!\.)/u)
    expect(t.truth.unverified.toLowerCase()).toContain('não foi verificado')
    expect(t.truth.verified.toLowerCase()).toContain('verificado')
  })

  it('changes the privacy explanation with the selected route mode', () => {
    expect(privacyNotice('local-only', 'openrouter', t.privacy)).toBe(t.privacy.localNotice)
    expect(privacyNotice('any', 'openrouter', t.privacy)).toContain('openrouter')
    expect(privacyNotice('any', null, t.privacy)).toBe(t.privacy.routeUnavailable)
    expect(privacyNotice('local-only', 'openrouter', t.privacy)).not.toContain('openrouter')
  })
})

describe('C-09: o código do estado não é a explicação', () => {
  const messages = {
    success: 'As verificações declaradas passaram neste computador.',
    failure: 'A criação parou porque uma verificação encontrou um problema.',
    cancelled: 'A criação foi cancelada.',
    interrupted: 'A criação foi interrompida antes de terminar. Nada foi publicado.',
    blockedExternal: 'A criação parou porque falta algo fora do Studio.',
    budgetExceeded: 'A criação parou porque o limite de gasto acabou.',
  }

  it('toda saída da criação tem frase em português', () => {
    // A tela mostrava `VERIFIED_PROTOTYPE` e `BUILD_FAILED` crus, em inglês e
    // em caixa alta, para quem não programa.
    const states = ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'BLOCKED_EXTERNAL', 'CANCELLED', 'INTERRUPTED', 'BUDGET_EXCEEDED'] as const
    for (const state of states) {
      const sentence = resultSentence(state, messages)
      expect(sentence, state).not.toBe(state)
      expect(sentence, state).not.toMatch(/[A-Z]{4,}_/u)
    }
  })

  it('distingue o que a pessoa pode resolver do que ela não pode', () => {
    // "Falta algo fora do Studio" e "uma verificação encontrou um problema"
    // pedem ações diferentes; a mesma frase para os dois seria inútil.
    expect(resultSentence('BLOCKED_EXTERNAL', messages)).toBe(messages.blockedExternal)
    expect(resultSentence('BUILD_FAILED', messages)).toBe(messages.failure)
    expect(resultSentence('TESTS_FAILED', messages)).toBe(messages.failure)
    expect(resultSentence('CANCELLED', messages)).toBe(messages.cancelled)
    expect(resultSentence('INTERRUPTED', messages)).toBe(messages.interrupted)
    expect(resultSentence('VERIFIED_PROTOTYPE', messages)).toBe(messages.success)
  })

  it('o código técnico continua existindo, atrás de "Detalhes técnicos"', () => {
    // Ele é o que se cola num pedido de ajuda. Some da explicação, não do app.
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(source).toContain('result-technical')
    expect(source).toContain('{t.verification.technicalTitle}')
    // E não pode voltar a ser a primeira coisa que a pessoa lê.
    expect(source).not.toContain('<code>{result.state}</code><p>{result.message}</p>')
  })
})

describe('M-04 / C-H4: por que esta rota, em português de gente', () => {
  it('traduz o CÓDIGO do motivo, e cala quando não há tradução', () => {
    // A frase que chegava aqui era a de quem OPERA o Studio: "Meia-abertura:
    // uma chamada decide se o circuito fecha ou reabre.", "Teto de gasto do
    // escopo estourado", nome de provedor. Nada disso diz o que aconteceu nem o
    // que fazer para quem não programa — e era a PRIMEIRA tela do produto.
    expect(routeReasonNotice('any', 'FIRST_HEALTHY', t.privacy.reasons)).toBe(t.privacy.reasons.FIRST_HEALTHY)
    expect(routeReasonNotice('any', 'HALF_OPEN', t.privacy.reasons)).toBe(t.privacy.reasons.HALF_OPEN)
    // Todo motivo que o produto sabe produzir tem frase, e toda frase diz o
    // efeito; as de bloqueio dizem também o próximo passo.
    for (const [code, sentence] of Object.entries(t.privacy.reasons)) {
      expect(sentence.length, code).toBeGreaterThan(30)
      expect(sentence, code).not.toMatch(/circuito|meia-abertura|escopo|rota paga|OmniRoute|DeepSeek/iu)
    }
    // No perfil local a frase de privacidade já diz tudo.
    expect(routeReasonNotice('local-only', 'SAFE_READ_LOCAL', t.privacy.reasons)).toBe(null)
    // Sem motivo, nada a explicar.
    expect(routeReasonNotice('any', null, t.privacy.reasons)).toBe(null)
    expect(routeReasonNotice('any', undefined, t.privacy.reasons)).toBe(null)
    expect(routeReasonNotice('any', '   ', t.privacy.reasons)).toBe(null)
    // E um código sem tradução CALA, em vez de despejar o texto interno.
    expect(routeReasonNotice('any', 'CODIGO_QUE_NAO_EXISTE', t.privacy.reasons)).toBe(null)
  })

  it('a tela mostra o motivo junto da frase de privacidade', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(source).toContain('routeReasonNotice(props.privacy, props.routeReason, t.privacy.reasons)')
    expect(source).toContain('health.route_reason_code')
  })
})

describe('M-05/C-22: os três perfis na tela', () => {
  it('cada perfil diz o que faz com os dados de quem escreve', () => {
    // O nome sozinho não conta nada a quem não programa: o que decide a
    // escolha é a frase debaixo dele.
    expect(privacyNotice('privado-local', 'openrouter', t.privacy)).toBe(t.privacy.localNotice)
    expect(privacyNotice('privado-local', 'openrouter', t.privacy)).not.toContain('openrouter')
    // O equilibrado NOMEIA a rota externa: prometer "às vezes vai para fora"
    // sem dizer para onde não é aviso, é ruído.
    const balanced = privacyNotice('equilibrado', 'openrouter', t.privacy)
    expect(balanced).toContain('openrouter')
    expect(balanced).toContain(t.privacy.balancedNoticeStart)
    const best = privacyNotice('melhor-qualidade', 'openrouter', t.privacy)
    expect(best).toContain('openrouter')
    expect(best).toContain(t.privacy.routeNoticeStart)
    // E as duas frases são diferentes: o equilibrado só usa a rota externa
    // quando a local não dá conta, e isso muda o que a pessoa está aceitando.
    expect(balanced).not.toBe(best)
    expect(privacyNotice('equilibrado', null, t.privacy)).toBe(t.privacy.routeUnavailable)
  })

  it('o valor binário antigo continua abrindo a tela no perfil certo', () => {
    expect(privacyProfileOf('local-only')).toBe('privado-local')
    expect(privacyProfileOf('any')).toBe('melhor-qualidade')
    expect(privacyProfileOf('equilibrado')).toBe('equilibrado')
    expect(privacyNotice('local-only', 'openrouter', t.privacy)).toBe(privacyNotice('privado-local', 'openrouter', t.privacy))
    expect(privacyNotice('any', 'openrouter', t.privacy)).toBe(privacyNotice('melhor-qualidade', 'openrouter', t.privacy))
    expect(routeReasonNotice('local-only', 'FIRST_HEALTHY', t.privacy.reasons)).toBe(null)
    expect(routeReasonNotice('equilibrado', 'FIRST_HEALTHY', t.privacy.reasons)).toBe(t.privacy.reasons.FIRST_HEALTHY)
  })

  it('avisa ANTES que privado-local sem IA local não cria nada', () => {
    // Sem isto a pessoa escrevia a ideia inteira, apertava "continuar" e só
    // então descobria o bloqueio — a informação existia antes e estava sendo
    // escondida dela.
    expect(creationBlocked('privado-local', null)).toBe(true)
    expect(privacyNotice('privado-local', 'openrouter', t.privacy, null)).toBe(t.privacy.localBlocked)
    expect(t.privacy.localBlocked).not.toBe(t.privacy.localNotice)
    // Com IA local disponível não há bloqueio nenhum.
    expect(creationBlocked('privado-local', 'ollama')).toBe(false)
    expect(privacyNotice('privado-local', 'openrouter', t.privacy, 'ollama')).toBe(t.privacy.localNotice)
    // Servidor que não sabe responder não vira bloqueio inventado.
    expect(creationBlocked('privado-local', undefined)).toBe(false)
    // E nenhum outro perfil é barrado por causa da IA local.
    expect(creationBlocked('equilibrado', null)).toBe(false)
    expect(creationBlocked('melhor-qualidade', null)).toBe(false)
    expect(creationBlocked('local-only', null)).toBe(true)
  })

  it('a tela oferece os três perfis e não deixa apertar quando está bloqueado', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(source).toContain("['privado-local', t.privacy.privadoLocal, t.privacy.privadoLocalDetail]")
    expect(source).toContain("['equilibrado', t.privacy.equilibrado, t.privacy.equilibradoDetail]")
    expect(source).toContain("['melhor-qualidade', t.privacy.melhorQualidade, t.privacy.melhorQualidadeDetail]")
    // O botão desabilitado é a outra metade do aviso: dizer "bloqueado" e
    // deixar apertar mesmo assim seria só decoração.
    expect(source).toContain('creationBlocked(props.privacy, props.localRoute)')
    expect(source).toContain('health.local_route')
  })
})

describe('H-2: o fim da criação diz o que realmente aconteceu', () => {
  it('não chama teto de gasto de falha de verificação', () => {
    // A pessoa procuraria defeito no aplicativo dela. O que acabou foi o
    // limite de gasto — que ela pode mudar, e a frase diz como.
    expect(resultSentence('BUDGET_EXCEEDED', t.verification)).toBe(t.verification.budgetExceeded)
    expect(resultSentence('BUDGET_EXCEEDED', t.verification)).not.toBe(t.verification.failure)
    expect(t.verification.budgetExceeded).toContain('limite de gasto')
    expect(t.verification.budgetExceeded).toContain('Não é um problema no seu aplicativo')
  })

  it('cada estado terminal tem a frase do seu próprio caso', () => {
    const expected: Record<PipelineResultState, string> = {
      VERIFIED_PROTOTYPE: t.verification.success,
      CANCELLED: t.verification.cancelled,
      INTERRUPTED: t.verification.interrupted,
      BLOCKED_EXTERNAL: t.verification.blockedExternal,
      BUDGET_EXCEEDED: t.verification.budgetExceeded,
      BUILD_FAILED: t.verification.failure,
      TESTS_FAILED: t.verification.failure,
    }
    for (const [state, sentence] of Object.entries(expected)) {
      expect(resultSentence(state as PipelineResultState, t.verification), state).toBe(sentence)
    }
  })
})

describe('capabilityLines — T-22 na tela', () => {
  it('bloco AUSENTE devolve lista vazia: servidor velho nao sabe responder', () => {
    expect(capabilityLines(undefined)).toEqual([])
  })

  it('operacional e o UNICO tom verde', () => {
    const lines = capabilityLines([
      { id: 'a', state: 'OPERATIONAL' },
      { id: 'b', state: 'CONFIGURED' },
      { id: 'c', state: 'PRESENT' },
      { id: 'd', state: 'ABSENT' },
    ])
    expect(lines.map(line => line.tone)).toEqual(['sim', 'nao', 'nao', 'nao'])
  })

  it('DESCONHECIDA tem tom proprio, e nunca vira verde', () => {
    // Com dois tons a tela teria de escolher um, e escolheria o verde — a
    // pessoa leria como funcionando aquilo que ninguem conferiu.
    expect(capabilityLines([{ id: 'a', state: 'UNKNOWN' }])[0]!.tone).toBe('nao-sei')
  })

  it('AUSENTE e `nao`, e nao `nao-sei`: e resposta certa, nao duvida', () => {
    expect(capabilityLines([{ id: 'a', state: 'ABSENT' }])[0]!.tone).toBe('nao')
  })

  it('tudo configurado e NUNCA exercitado e `nao-sei`, e nunca `nao`', () => {
    // Dizer "nao da agora" aqui e uma negativa FALSA — e uma negativa falsa
    // impede a pessoa de tentar exatamente aquilo que funcionaria.
    expect(capabilityLines([{ id: 'a', state: 'CONFIGURED', reason: 'NEVER_PROBED' }])[0]!.tone).toBe('nao-sei')
    expect(capabilityLines([{ id: 'a', state: 'CONFIGURED', reason: 'NO_PROBE' }])[0]!.tone).toBe('nao-sei')
  })

  it('sondagem que REPROVOU e `nao`: alguem olhou e nao funcionou', () => {
    expect(capabilityLines([{ id: 'a', state: 'CONFIGURED', reason: 'PROBE_FAILED' }])[0]!.tone).toBe('nao')
  })

  it('dependencia quebrada e `nao`, mesmo sem ninguem ter sondado esta', () => {
    // O modelo caido e uma resposta certa sobre esta capacidade: ela nao vai
    // funcionar enquanto a base nao voltar.
    expect(capabilityLines([{ id: 'a', state: 'CONFIGURED', reason: 'DEPENDENCY', blocked_by: 'modelo' }])[0]!.tone).toBe('nao')
  })

  it('o motivo e quem segura atravessam', () => {
    const [line] = capabilityLines([{ id: 'a', state: 'CONFIGURED', reason: 'DEPENDENCY', blocked_by: 'modelo' }])
    expect(line).toEqual({ id: 'a', tone: 'nao', reason: 'DEPENDENCY', blockedBy: 'modelo' })
  })

  it('capacidade operacional nao carrega motivo', () => {
    expect(capabilityLines([{ id: 'a', state: 'OPERATIONAL' }])[0]).toEqual({ id: 'a', tone: 'sim' })
  })

  it('a ordem do servidor e mantida', () => {
    const lines = capabilityLines([{ id: 'z', state: 'OPERATIONAL' }, { id: 'a', state: 'ABSENT' }])
    expect(lines.map(line => line.id)).toEqual(['z', 'a'])
  })
})
