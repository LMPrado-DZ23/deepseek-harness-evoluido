import { describe, expect, it } from 'vitest'
import { GENERATION_START_STATES } from '../src/state.js'
import { ESTADOS_DE_TENTAR_DE_NOVO } from '../../../apps/studio-web/src/tentarDeNovo.js'

describe('"Tentar de novo" na tela = o que o servidor aceita recomeçar', () => {
  it('a mesma lista, menos a aprovação do plano (que tem "Iniciar criação")', () => {
    expect([...ESTADOS_DE_TENTAR_DE_NOVO].sort()).toEqual(GENERATION_START_STATES.filter(estado => estado !== 'PLAN_APPROVED').slice().sort())
  })
})
