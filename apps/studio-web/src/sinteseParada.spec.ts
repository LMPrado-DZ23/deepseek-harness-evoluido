import { describe, expect, it } from 'vitest'
import { sinteseParada } from './sinteseParada'

describe('sinteseParada', () => {
  it('oferece tentar de novo só quando as respostas existem e nada ficou pronto', () => {
    expect(sinteseParada('DRAFT', null, [{}])).toBe(true)
  })
  it('com pergunta aberta, a pergunta é a ação', () => {
    expect(sinteseParada('DRAFT', { id: 'q' }, [{}])).toBe(false)
  })
  it('sem nenhuma resposta ainda (tarefa acabou de nascer), não oferece', () => {
    expect(sinteseParada('DRAFT', null, [])).toBe(false)
    expect(sinteseParada('DRAFT', null, undefined)).toBe(false)
  })
  it('depois da especificação, não é mais este caso', () => {
    expect(sinteseParada('SPEC_READY', null, [{}])).toBe(false)
  })
})
