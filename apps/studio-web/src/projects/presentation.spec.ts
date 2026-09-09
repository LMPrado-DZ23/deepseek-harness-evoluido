import { describe, expect, it } from 'vitest'
import { PROJECT_STATE_LABEL, projectCount, projectStateLabel, readableDate } from './presentation'
import type { ProjectUiState } from '../presentation'

const ALL_STATES: readonly ProjectUiState[] = [
  'DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'GENERATING',
  'BUILD_OK', 'BUILD_FAILED', 'TESTS_OK', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED', 'VERIFIED_PROTOTYPE',
]

describe('a lista de projetos fala português', () => {
  it('TODO estado tem frase própria — a tabela é exaustiva, não uma amostra', () => {
    for (const state of ALL_STATES) {
      const phrase = projectStateLabel(state)
      expect(phrase, state).toBeTruthy()
      // A frase não pode ser o próprio código, nem parecer um.
      expect(phrase, state).not.toBe(state)
      expect(phrase, state).not.toMatch(/^[A-Z][A-Z_]+$/u)
    }
    expect(Object.keys(PROJECT_STATE_LABEL).sort()).toEqual([...ALL_STATES].sort())
  })

  it('estados intermediários não anunciam um fim que não houve', () => {
    // `BUILD_OK` e `TESTS_OK` são passos de uma criação em andamento. Chamá-los
    // de "concluído" na lista faria a pessoa abrir esperando o protótipo.
    expect(projectStateLabel('BUILD_OK')).toBe(projectStateLabel('GENERATING'))
    expect(projectStateLabel('TESTS_OK')).toBe(projectStateLabel('GENERATING'))
    expect(projectStateLabel('VERIFIED_PROTOTYPE')).not.toBe(projectStateLabel('GENERATING'))
  })

  it('um estado que este cliente não conhece aparece cru, e não some', () => {
    // Servidor mais novo que a interface: célula em branco faria a pessoa achar
    // que o projeto se perdeu.
    expect(projectStateLabel('ESTADO_DO_FUTURO')).toBe('ESTADO_DO_FUTURO')
  })

  it('conta no singular e no plural', () => {
    expect(projectCount(1)).toBe('1 projeto')
    expect(projectCount(2)).toBe('2 projetos')
    expect(projectCount(0)).toBe('0 projetos')
  })

  it('a data vira legível, e o que não é data não vira "Invalid Date"', () => {
    expect(readableDate('2026-09-01T12:00:00.000Z')).toMatch(/2026/u)
    expect(readableDate('nao é data')).toBe('nao é data')
  })
})
