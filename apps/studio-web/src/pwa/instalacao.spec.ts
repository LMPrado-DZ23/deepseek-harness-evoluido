import { describe, expect, it } from 'vitest'
import { CHAVE_INSTALACAO_DISPENSADA, dispensarInstalacao, instalacaoDispensada } from './instalacao'

function memoria(): Storage {
  const dados = new Map<string, string>()
  return { getItem: (k: string) => dados.get(k) ?? null, setItem: (k: string, v: string) => { dados.set(k, v) } } as unknown as Storage
}

describe('the install offer can be turned down', () => {
  it('starts offered, and stays turned down once refused', () => {
    const armazenamento = memoria()
    expect(instalacaoDispensada(armazenamento)).toBe(false)
    dispensarInstalacao(armazenamento)
    expect(instalacaoDispensada(armazenamento)).toBe(true)
    expect(armazenamento.getItem(CHAVE_INSTALACAO_DISPENSADA)).toBe('1')
  })

  it('a browser that refuses storage neither breaks nor claims a refusal', () => {
    const recusa = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
    expect(() => dispensarInstalacao(recusa)).not.toThrow()
    expect(instalacaoDispensada(recusa)).toBe(false)
    expect(instalacaoDispensada(undefined)).toBe(false)
  })

  it('another value in the slot is not a refusal', () => {
    const armazenamento = memoria()
    armazenamento.setItem(CHAVE_INSTALACAO_DISPENSADA, '0')
    expect(instalacaoDispensada(armazenamento)).toBe(false)
  })
})
