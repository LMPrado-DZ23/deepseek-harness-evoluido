import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { impressaoLocal, intencaoDeEnvio, novaChave } from './creationIntent'

const PEDIDO = { name: 'Clínica', original_brief: 'quero uma página', category: 'landing-page', privacy: 'privado-local' }

describe('a identidade da intenção de envio', () => {
  it('REAPROVEITA a chave quando a tentativa anterior falhou e o pedido é o mesmo', () => {
    // Este é o defeito inteiro numa linha: chave nova aqui e o servidor cria a
    // segunda tarefa, porque para ele são dois pedidos diferentes.
    const primeira = intencaoDeEnvio(null, PEDIDO, () => 'chave-1-abcdefghij')
    const retry = intencaoDeEnvio(primeira, PEDIDO, () => 'chave-2-abcdefghij')
    expect(retry.chave).toBe(primeira.chave)
  })

  it('gera chave NOVA quando a pessoa corrigiu o pedido depois da falha', () => {
    // O outro lado da mesma regra: reaproveitar aqui faria o servidor recusar
    // por conflito quem só quis corrigir o que escreveu.
    const primeira = intencaoDeEnvio(null, PEDIDO, () => 'chave-1-abcdefghij')
    const corrigida = intencaoDeEnvio(primeira, { ...PEDIDO, original_brief: 'quero um catálogo' }, () => 'chave-2-abcdefghij')
    expect(corrigida.chave).toBe('chave-2-abcdefghij')
  })

  it('cada campo do pedido conta, e um não invade o outro', () => {
    expect(impressaoLocal(PEDIDO)).toBe(impressaoLocal({ ...PEDIDO }))
    expect(impressaoLocal({ ...PEDIDO, category: 'catalog' })).not.toBe(impressaoLocal(PEDIDO))
    expect(impressaoLocal({ ...PEDIDO, name: 'ab', original_brief: 'cd' }))
      .not.toBe(impressaoLocal({ ...PEDIDO, name: 'abc', original_brief: 'd' }))
  })

  it('a chave gerada passa no formato que o servidor exige', () => {
    for (let vez = 0; vez < 20; vez += 1) expect(novaChave()).toMatch(/^[A-Za-z0-9_-]{16,128}$/u)
  })

  it('a tela MANDA a chave, e a esquece quando a tarefa existe', () => {
    // Guardar a intenção depois do sucesso faria o segundo aplicativo da pessoa
    // ser recusado por conflito com o primeiro.
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('request_key: envio.chave')
    expect(app).toContain('intencao.current = envio')
    expect(app).toContain('intencao.current = null')
  })
})
