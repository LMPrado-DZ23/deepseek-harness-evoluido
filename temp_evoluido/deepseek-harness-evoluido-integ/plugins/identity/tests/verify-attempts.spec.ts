/**
 * O teto de conferência POR E-MAIL (OS-90), como decisão pura.
 *
 * Ele mora aqui e não dentro do serviço porque é uma decisão, e decisão dentro
 * de um método privado de setecentas linhas não é exercitada por teste nenhum.
 */
import { describe, expect, it } from 'vitest'
import {
  contarFalha,
  JANELA_DE_CONFERENCIA_MS,
  MAX_EMAILS_VIGIADOS,
  MAX_FALHAS_DE_CONFERENCIA,
  podar,
  travado,
  type TentativasDeConferencia,
} from '../src/verify-attempts.js'

const T0 = 1_000_000

describe('travar depois de cinco erros', () => {
  it('quem nunca errou não está travado', () => {
    expect(travado(undefined, T0)).toBe(false)
  })

  it('trava no quinto, e não no quarto', () => {
    expect(travado({ falhas: MAX_FALHAS_DE_CONFERENCIA - 1, desde: T0 }, T0)).toBe(false)
    expect(travado({ falhas: MAX_FALHAS_DE_CONFERENCIA, desde: T0 }, T0)).toBe(true)
  })

  it('a trava PASSA sozinha quando a janela termina', () => {
    const cheio: TentativasDeConferencia = { falhas: 99, desde: T0 }
    expect(travado(cheio, T0 + JANELA_DE_CONFERENCIA_MS - 1)).toBe(true)
    // Uma trava que não passa é um jeito barato de manter outra pessoa de fora,
    // e o custo cai em quem não atacou.
    expect(travado(cheio, T0 + JANELA_DE_CONFERENCIA_MS)).toBe(false)
  })
})

describe('contar uma falha', () => {
  it('a primeira falha abre a janela', () => {
    expect(contarFalha(undefined, T0)).toEqual({ falhas: 1, desde: T0 })
  })

  it('a falha seguinte soma e NÃO adia o fim da janela', () => {
    // Se cada falha empurrasse o `desde`, errar de propósito a cada minuto
    // manteria a vítima travada para sempre.
    expect(contarFalha({ falhas: 2, desde: T0 }, T0 + 60_000)).toEqual({ falhas: 3, desde: T0 })
  })

  it('depois da janela, a contagem recomeça do um', () => {
    expect(contarFalha({ falhas: 99, desde: T0 }, T0 + JANELA_DE_CONFERENCIA_MS)).toEqual({ falhas: 1, desde: T0 + JANELA_DE_CONFERENCIA_MS })
  })
})

describe('podar o que é vigiado', () => {
  it('o que já venceu sai, e quem ainda trava alguém fica', () => {
    const mapa = new Map<string, TentativasDeConferencia>([
      ['velho@example.com', { falhas: 5, desde: T0 }],
      ['novo@example.com', { falhas: 5, desde: T0 + JANELA_DE_CONFERENCIA_MS }],
    ])
    podar(mapa, T0 + JANELA_DE_CONFERENCIA_MS)
    expect([...mapa.keys()]).toEqual(['novo@example.com'])
  })

  it('o teto é conferido ANTES de inserir, e por isso ele nunca é ultrapassado', () => {
    // A chave é escolhida por quem ataca: sem teto, pedir conferência para um
    // milhão de endereços inventados encheria a memória pela porta de entrada.
    const mapa = new Map<string, TentativasDeConferencia>()
    for (let indice = 0; indice < MAX_EMAILS_VIGIADOS + 10; indice += 1) {
      podar(mapa, T0)
      mapa.set(`${String(indice)}@example.com`, contarFalha(undefined, T0))
    }
    expect(mapa.size).toBeLessThanOrEqual(MAX_EMAILS_VIGIADOS)
    // E o que sai é o MAIS ANTIGO, nunca o que está travando alguém agora.
    expect(mapa.has(`${String(MAX_EMAILS_VIGIADOS + 9)}@example.com`)).toBe(true)
    expect(mapa.has('0@example.com')).toBe(false)
  })
})
