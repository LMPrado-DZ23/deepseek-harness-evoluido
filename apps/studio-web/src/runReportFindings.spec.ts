import { describe, expect, it } from 'vitest'
import { criteriaSentence, findingSentence } from './RunReport'
import t from './i18n/pt-BR.json'

/**
 * "O que foi recusado" mostrava `src/GeneratedApp.tsx:SECRET_PATTERN` — inglês,
 * caixa alta, sem próximo passo — na seção que só aparece quando algo deu
 * errado. O resto do relato já era exemplar; estas duas seções furavam a regra
 * do próprio produto.
 */
describe('C-H9: o que foi recusado, em português', () => {
  it('explica o achado e diz o que fazer', () => {
    const secret = findingSentence('src/GeneratedApp.tsx:SECRET_PATTERN')
    expect(secret).toContain('src/GeneratedApp.tsx')
    expect(secret).not.toContain('SECRET_PATTERN')
    expect(secret).toContain('cofre')
    const pii = findingSentence('content/app.json:PII_PATTERN')
    expect(pii).toContain('CPF')
    expect(pii).not.toContain('PII_PATTERN')
  })

  it('um código novo não vira código na tela', () => {
    // O dia em que a varredura ganhar um achado novo, a tela ainda diz algo em
    // português — e o código continua nos detalhes técnicos.
    const unknown = findingSentence('src/x.ts:ALGO_NOVO')
    expect(unknown).toBe(t.report.findingUnknown.replace('{arquivo}', 'src/x.ts'))
    expect(unknown).not.toContain('ALGO_NOVO')
    // Caminho do Windows tem `:` no meio; o código é o que vem depois do ÚLTIMO.
    expect(findingSentence('C:/app/src/x.ts:SECRET_PATTERN')).toContain('C:/app/src/x.ts')
  })
})

describe('C-M9: "critérios conferidos" só conta o que foi conferido', () => {
  const check = (status: string) => ({ status })
  it('reparte quando nem tudo passou', () => {
    // "12 critérios conferidos" era o comprimento da lista INTEIRA: os que
    // falharam e os que ninguém automatizou entravam na conta, e a palavra
    // "conferidos" afirmava uma conferência que não houve.
    const sentence = criteriaSentence([
      ...Array.from({ length: 7 }, () => check('PASSED')),
      ...Array.from({ length: 3 }, () => check('FAILED')),
      check('NOT_AUTOMATED'), check('PENDING'),
    ])
    expect(sentence).toContain('12 critérios')
    expect(sentence).toContain('7 conferidos')
    expect(sentence).toContain('3 falharam')
    expect(sentence).toContain('2 não conferidos automaticamente')
  })

  it('quando tudo passou, diz isso sem repartição inútil', () => {
    expect(criteriaSentence([check('PASSED'), check('PASSED')])).toBe('2 critérios, todos conferidos')
  })

  it('lista vazia não vira "todos conferidos"', () => {
    // Zero conferência não é conferência completa: seria a mesma mentira, com
    // outro número.
    expect(criteriaSentence([])).toContain('0 critérios')
    expect(criteriaSentence([])).not.toContain('todos conferidos')
  })
})
