import { describe, expect, it } from 'vitest'
import { ENTRADAS_NA_PREVIA, previaDoPacote } from './previa'

function entrada(name: string, size = 10) { return { name, size } }

describe('a prévia de um pacote', () => {
  it('ordena por nome, para a lista não mudar de ordem entre pacotes', () => {
    // A ordem dentro do zip é a de escrita, e ela muda.
    const previa = previaDoPacote([entrada('z.txt'), entrada('a.txt'), entrada('m.txt')])
    expect(previa.entradas.map(item => item.name)).toEqual(['a.txt', 'm.txt', 'z.txt'])
  })

  it('corta no limite e DIZ quantas ficaram de fora', () => {
    const muitas = Array.from({ length: ENTRADAS_NA_PREVIA + 5 }, (_, indice) => entrada(`arquivo-${String(indice).padStart(3, '0')}.txt`))
    const previa = previaDoPacote(muitas)
    expect(previa.entradas).toHaveLength(ENTRADAS_NA_PREVIA)
    expect(previa.restantes).toBe(5)
  })

  it('o TOTAL é o do pacote, e não o do que coube', () => {
    // Mostrar doze e dizer "12 arquivos" para um pacote de dezessete seria
    // mentir sobre o que a pessoa tem guardado.
    const muitas = Array.from({ length: ENTRADAS_NA_PREVIA + 5 }, (_, indice) => entrada(`arquivo-${String(indice)}.txt`))
    expect(previaDoPacote(muitas).total).toBe(ENTRADAS_NA_PREVIA + 5)
  })

  it('pacote vazio é pacote vazio, e não uma linha de exemplo', () => {
    expect(previaDoPacote([])).toEqual({ entradas: [], restantes: 0, total: 0 })
  })

  it('entrada de tamanho zero continua na lista', () => {
    expect(previaDoPacote([entrada('vazio.txt', 0)]).entradas).toHaveLength(1)
  })
})
