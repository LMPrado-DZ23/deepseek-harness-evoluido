import { describe, expect, it } from 'vitest'
import { impressaoDoEnvioLocal, impressaoLocal, intencaoDeEnvio, intencaoPorImpressao, novaChave } from './creationIntent'

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

  // Envio e limpeza apos sucesso sao exercitados no navegador em journey.spec.ts.

})

describe('a intenção de um envio DENTRO da tarefa', () => {
  it('reenviar o MESMO texto reaproveita a chave — é a mesma intenção', () => {
    // O reenvio depois de um tempo esgotado é o mesmo envio. Chave nova ali é
    // o defeito que isto conserta, com um passo a mais.
    const impressao = impressaoDoEnvioLocal('pergunta', 'proj-1', 'por que falhou?')
    const primeira = intencaoPorImpressao(null, impressao, () => 'chave-um-aaaaaaaaaaaa')
    const segunda = intencaoPorImpressao(primeira, impressao, () => 'chave-dois-bbbbbbbbb')
    expect(segunda.chave).toBe(primeira.chave)
  })

  it('corrigir o texto gera chave NOVA — é outro envio', () => {
    const primeira = intencaoPorImpressao(null, impressaoDoEnvioLocal('pergunta', 'proj-1', 'por que falou?'), () => 'chave-um-aaaaaaaaaaaa')
    const segunda = intencaoPorImpressao(primeira, impressaoDoEnvioLocal('pergunta', 'proj-1', 'por que falhou?'), () => 'chave-dois-bbbbbbbbb')
    expect(segunda.chave).not.toBe(primeira.chave)
  })

  it('espaço a mais NÃO é outro envio', () => {
    expect(impressaoDoEnvioLocal('pergunta', 'p', '  por que   falhou?  '))
      .toBe(impressaoDoEnvioLocal('pergunta', 'p', 'por que falhou?'))
  })

  it('a MESMA frase como pergunta e como alteração são intenções diferentes', () => {
    // Senão, quem perguntasse e depois pedisse a mesma coisa receberia a
    // resposta da pergunta no lugar da revisão.
    expect(impressaoDoEnvioLocal('pergunta', 'p', 'trocar o cabeçalho'))
      .not.toBe(impressaoDoEnvioLocal('revisao', 'p', 'trocar o cabeçalho'))
  })

  it('a mesma frase em tarefas diferentes são intenções diferentes', () => {
    expect(impressaoDoEnvioLocal('pergunta', 'p1', 'por quê?'))
      .not.toBe(impressaoDoEnvioLocal('pergunta', 'p2', 'por quê?'))
  })
})
