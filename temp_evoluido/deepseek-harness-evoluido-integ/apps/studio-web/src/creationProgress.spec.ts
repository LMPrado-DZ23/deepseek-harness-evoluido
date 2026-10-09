import { describe, expect, it } from 'vitest'
import { attemptSentence, stageSentence } from './creationProgress'
import t from './i18n/pt-BR.json'

describe('o que está acontecendo agora na criação', () => {
  it('cada etapa do servidor tem frase própria', () => {
    // As quatro etapas são as do esquema de `StudioRun.stage`. Uma delas sem
    // frase deixaria a tela imóvel justamente no minuto mais longo.
    for (const stage of ['generate', 'build', 'test', 'verify']) {
      const phrase = stageSentence({ stage, attempt: 1 })
      expect(phrase, stage).toBeTruthy()
      expect(phrase, stage).not.toBe(stage)
      expect(phrase, stage).not.toBe(t.creation.stageUnknown)
    }
  })

  it('as quatro frases são diferentes entre si', () => {
    // Se duas etapas dissessem a mesma coisa, a tela pareceria parada quando na
    // verdade tinha avançado.
    const phrases = ['generate', 'build', 'test', 'verify'].map(stage => stageSentence({ stage, attempt: 1 }))
    expect(new Set(phrases).size).toBe(4)
  })

  it('etapa desconhecida vira frase honesta, e não some', () => {
    expect(stageSentence({ stage: 'etapa-do-futuro', attempt: 1 })).toBe(t.creation.stageUnknown)
  })

  it('sem execução, não há frase', () => {
    expect(stageSentence(null)).toBeNull()
    expect(attemptSentence(null)).toBeNull()
  })

  it('a primeira tentativa não é anunciada; a segunda é', () => {
    // "1ª tentativa" enquanto tudo vai bem planta a ideia de que algo falhou.
    expect(attemptSentence({ stage: 'build', attempt: 1 })).toBeNull()
    expect(attemptSentence({ stage: 'build', attempt: 2 })).toContain('2')
    expect(attemptSentence({ stage: 'build', attempt: 3 })).toContain('3')
  })
})
