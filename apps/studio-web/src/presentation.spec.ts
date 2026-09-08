import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import t from './i18n/pt-BR.json'
import { currentStepIndex, permanentTruthKind, privacyNotice, resultSentence, routeReasonNotice, type ProjectUiState } from './presentation'

describe('truthful presentation for nontechnical users', () => {
  it('maps the real machine states to the five visible stages', () => {
    const expected: Record<ProjectUiState, number> = {
      DRAFT: 1, SPEC_READY: 2, PLAN_PROPOSED: 2, PLAN_APPROVED: 3, GENERATING: 3,
      BUILD_OK: 3, BUILD_FAILED: 3, TESTS_OK: 4, TESTS_FAILED: 4, CANCELLED: 4, INTERRUPTED: 3, VERIFIED_PROTOTYPE: 4,
    }
    for (const [state, step] of Object.entries(expected)) expect(currentStepIndex(state as ProjectUiState)).toBe(step)
  })

  it('shows the permanent prototype notice only during creation and verification', () => {
    expect(permanentTruthKind(null)).toBeNull()
    expect(permanentTruthKind('DRAFT')).toBeNull()
    expect(permanentTruthKind('SPEC_READY')).toBeNull()
    expect(permanentTruthKind('PLAN_PROPOSED')).toBeNull()
    expect(permanentTruthKind('GENERATING')).toBe('creation')
    expect(permanentTruthKind('BUILD_FAILED')).toBe('creation')
    expect(permanentTruthKind('INTERRUPTED')).toBe('creation')
    expect(permanentTruthKind('TESTS_OK')).toBe('verified')
    expect(permanentTruthKind('VERIFIED_PROTOTYPE')).toBe('verified')
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
  }

  it('toda saída da criação tem frase em português', () => {
    // A tela mostrava `VERIFIED_PROTOTYPE` e `BUILD_FAILED` crus, em inglês e
    // em caixa alta, para quem não programa.
    const states = ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'BLOCKED_EXTERNAL', 'CANCELLED', 'INTERRUPTED'] as const
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

describe('M-04: por que esta rota', () => {
  it('explica a escolha quando existe rota externa, e cala quando não há o que explicar', () => {
    // O motivo era calculado a cada escolha e jogado fora: nenhuma tela lia o
    // endereço de saúde, e a pessoa via o NOME da rota sem saber se era a local
    // por preferência, a direta por falta de rota saudável, ou a que ela mesma
    // escolheu.
    expect(routeReasonNotice('any', 'Primeira rota saudável do perfil.')).toBe('Primeira rota saudável do perfil.')
    // No perfil local a frase de privacidade já diz tudo; repetir o motivo
    // técnico ao lado dela só acrescenta ruído para quem não programa.
    expect(routeReasonNotice('local-only', 'Modelo local saudável preferido para leitura segura.')).toBe(null)
    // Sem rota não há escolha a explicar: existe um bloqueio, e quem conta isso
    // é a frase de privacidade.
    expect(routeReasonNotice('any', null)).toBe(null)
    expect(routeReasonNotice('any', undefined)).toBe(null)
    expect(routeReasonNotice('any', '   ')).toBe(null)
  })

  it('a tela mostra o motivo junto da frase de privacidade', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(source).toContain('routeReasonNotice(props.privacy, props.routeReason)')
    expect(source).toContain('health.route_reason')
  })
})
