import { describe, expect, it } from 'vitest'
import { operacoesDaBiblioteca, tiposDaBiblioteca } from './biblioteca'
import copy from '../i18n/destinos.pt-BR.json'

describe('a declaração da Biblioteca', () => {
  it('TODA operação não suportada diz por quê', () => {
    // "Não dá" sem motivo é indistinguível de "está quebrado".
    for (const operacao of operacoesDaBiblioteca()) {
      if (!operacao.suportada) expect(operacao.motivo).toBeTruthy()
    }
  })

  it('TODA operação tem frase no catálogo — nenhuma cai num identificador cru', () => {
    const frases = (copy as Record<string, unknown>).bibliotecaOperacoes as Record<string, string>
    for (const operacao of operacoesDaBiblioteca()) expect(frases[operacao.id]).toBeTruthy()
  })

  it('TODO motivo tem frase no catálogo', () => {
    const motivos = (copy as Record<string, unknown>).bibliotecaMotivos as Record<string, string>
    for (const operacao of operacoesDaBiblioteca()) {
      if (operacao.motivo !== undefined) expect(motivos[operacao.motivo]).toBeTruthy()
    }
  })

  it('as suportadas vêm primeiro, porque é o que a pessoa pergunta ao chegar', () => {
    const operacoes = operacoesDaBiblioteca()
    const primeiraNao = operacoes.findIndex(operacao => !operacao.suportada)
    expect(operacoes.slice(0, primeiraNao).every(operacao => operacao.suportada)).toBe(true)
    expect(operacoes.slice(primeiraNao).every(operacao => !operacao.suportada)).toBe(true)
  })

  it('declara PELO MENOS uma operação suportada e uma não suportada', () => {
    // Uma declaração só com "sim" ou só com "não" não declara nada.
    const operacoes = operacoesDaBiblioteca()
    expect(operacoes.some(operacao => operacao.suportada)).toBe(true)
    expect(operacoes.some(operacao => !operacao.suportada)).toBe(true)
  })

  it('o tipo de arquivo é NOMEADO, e tem frase no catálogo', () => {
    const tipos = (copy as Record<string, unknown>).bibliotecaTipos as Record<string, string>
    expect(tiposDaBiblioteca().length).toBeGreaterThan(0)
    for (const tipo of tiposDaBiblioteca()) expect(tipos[tipo]).toBeTruthy()
  })
})
