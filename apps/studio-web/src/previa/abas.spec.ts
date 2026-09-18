import { describe, expect, it } from 'vitest'
import { ABAS, abaEfetiva, abasDoPainel, type LeituraDasAbas } from './abas.js'

const cheio: LeituraDasAbas = { temPrevia: true, arquivos: 2, etapas: 4, checkpoints: 3, relatoLido: true }
const estadoDe = (leitura: LeituraDasAbas, aba: string) => abasDoPainel(leitura).find(item => item.aba === aba)

describe('nenhuma aba some', () => {
  it('a lista é sempre completa, em qualquer estado', () => {
    /*
      Sumir faz a pessoa procurar o que não existe e, pior, faz a barra de abas
      mudar de tamanho enquanto a construção anda — o que move o alvo do clique
      debaixo do dedo dela.
    */
    const vazio: LeituraDasAbas = { temPrevia: false, arquivos: 0, etapas: 0, checkpoints: 0, relatoLido: false }
    for (const leitura of [cheio, vazio]) {
      expect(abasDoPainel(leitura).map(item => item.aba)).toEqual([...ABAS])
    }
  })

  it('com tudo pronto, todas abrem', () => {
    expect(abasDoPainel(cheio).every(item => item.disponivel)).toBe(true)
    expect(abasDoPainel(cheio).every(item => item.motivo === null)).toBe(true)
  })
})

describe('"ainda não sei" é diferente de "não tem nada"', () => {
  it('sem o relato lido, o motivo é SEM_RELATO — e não VAZIO', () => {
    /*
      Afirmar vazio sem ter lido é inventar um fato sobre o trabalho da pessoa:
      ela leria "nenhum arquivo" quando a resposta certa é "ainda não perguntei".
    */
    const carregando: LeituraDasAbas = { ...cheio, relatoLido: false, arquivos: 0, etapas: 0 }
    expect(estadoDe(carregando, 'arquivos')?.motivo).toBe('SEM_RELATO')
    expect(estadoDe(carregando, 'testes')?.motivo).toBe('SEM_RELATO')
  })

  it('com o relato lido e nada dentro, o motivo é VAZIO', () => {
    const lidoEVazio: LeituraDasAbas = { ...cheio, relatoLido: true, arquivos: 0, etapas: 0 }
    expect(estadoDe(lidoEVazio, 'arquivos')?.motivo).toBe('VAZIO')
    expect(estadoDe(lidoEVazio, 'testes')?.motivo).toBe('VAZIO')
  })

  it('o relato não lido NÃO esconde os arquivos que ele já trouxe', () => {
    // Coerência: se há contagem, o relato foi lido. Esta afirmação existe para
    // a ordem das perguntas nunca inverter.
    const incoerente: LeituraDasAbas = { ...cheio, relatoLido: false }
    expect(estadoDe(incoerente, 'arquivos')?.motivo).toBe('SEM_RELATO')
  })
})

describe('cada aba tem a sua própria fonte de verdade', () => {
  it('a prévia depende da PRÉVIA, e não do relato', () => {
    const semPrevia: LeituraDasAbas = { ...cheio, temPrevia: false }
    expect(estadoDe(semPrevia, 'previa')).toEqual({ aba: 'previa', disponivel: false, motivo: 'SEM_PREVIA' })
    // E as outras continuam abrindo: o código e os testes existem mesmo com a
    // prévia encerrada.
    expect(estadoDe(semPrevia, 'arquivos')?.disponivel).toBe(true)
    expect(estadoDe(semPrevia, 'testes')?.disponivel).toBe(true)
  })

  it('o histórico NÃO sai do relato de uma tentativa', () => {
    /*
      Ele é a lista de pontos de retomada, e existe mesmo quando a tentativa
      corrente não gravou relato nenhum — que é justamente o caso em que a
      pessoa mais precisa dele.
    */
    const semRelato: LeituraDasAbas = { ...cheio, relatoLido: false, arquivos: 0, etapas: 0 }
    expect(estadoDe(semRelato, 'historico')?.disponivel).toBe(true)
    expect(estadoDe({ ...cheio, checkpoints: 0 }, 'historico')?.motivo).toBe('VAZIO')
  })
})

describe('a aba escolhida não troca sozinha', () => {
  it('uma aba indisponível continua escolhida, mostrando o motivo', () => {
    /*
      Trocar por baixo é como se perde o lugar numa tela que muda sozinha
      enquanto a construção anda: a pessoa clica em "arquivos", o relato demora,
      e ela se vê de volta na prévia sem ter pedido.
    */
    const estados = abasDoPainel({ ...cheio, relatoLido: false, arquivos: 0 })
    expect(abaEfetiva(estados, 'arquivos')).toBe('arquivos')
  })

  it('uma aba que não existe cai na prévia', () => {
    expect(abaEfetiva(abasDoPainel(cheio), 'inventada' as never)).toBe('previa')
  })
})
