import { describe, expect, it } from 'vitest'
import { Semaphore, SemaphoreFullError } from '../src/semaphore.js'

/** Um trabalho que só termina quando alguém mandar. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('ACHADO C: teto de trabalho caro em paralelo', () => {
  it('uma chamada nova que chega NO instante da troca de vaga não fura o teto', async () => {
    // Este é o defeito clássico, e ele tem uma janela estreitíssima: decrementar
    // o contador antes de acordar quem espera deixa o contador em `limite - 1`
    // por alguns microtasks. Quem chegar exatamente aí passa direto, e quando o
    // que estava esperando acorda e incrementa, há `limite + 1` trabalhos caros
    // rodando. Medido: a versão defeituosa fura com 2 microtasks de atraso.
    //
    // O teste varre a janela inteira porque o número exato de ticks é um
    // detalhe da implementação — amarrar o teste a ele testaria o acidente, e
    // não a regra.
    for (let ticks = 0; ticks <= 8; ticks += 1) {
      const semaphore = new Semaphore(1, 8)
      let concurrent = 0
      let peak = 0
      const gates: (() => void)[] = []
      const body = async (): Promise<void> => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise<void>(resolve => gates.push(resolve))
        concurrent -= 1
      }
      const first = semaphore.run(body)
      const second = semaphore.run(body)
      await new Promise(resolve => setTimeout(resolve, 0))
      gates[0]!()
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve()
      const third = semaphore.run(body)
      for (let round = 0; round < 3; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 0))
        for (const gate of gates) gate()
      }
      await Promise.all([first, second, third])
      expect({ ticks, peak }).toEqual({ ticks, peak: 1 })
      expect(semaphore.active).toBe(0)
    }
  })

  it('nunca deixa passar do limite, nem no instante da troca de vaga', async () => {
    // O defeito clássico de semáforo é decrementar o contador ANTES de acordar
    // quem espera: por essa fresta entra uma chamada nova, e o teto é
    // ultrapassado em um. Aqui a vaga é transferida.
    const semaphore = new Semaphore(2, 10)
    let concurrent = 0
    let peak = 0
    const gates = Array.from({ length: 8 }, () => deferred())
    const running = gates.map((gate, index) => semaphore.run(async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await gate.promise
      concurrent -= 1
      return index
    }))
    // Libera um de cada vez, que é exatamente quando a troca de vaga acontece.
    for (const gate of gates) {
      gate.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(await Promise.all(running)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(peak).toBe(2)
    expect(semaphore.active).toBe(0)
    expect(semaphore.waiting).toBe(0)
  })

  it('recusa rápido quando a fila enche, em vez de crescer sem fim', async () => {
    // Fila infinita apenas troca saturação de CPU por saturação de memória, e
    // ainda faz a pessoa esperar por um trabalho que já não chega a tempo.
    const semaphore = new Semaphore(1, 1)
    const held = deferred()
    const first = semaphore.run(() => held.promise)
    const queued = semaphore.run(async () => undefined)
    await expect(semaphore.run(async () => undefined)).rejects.toThrow(SemaphoreFullError)
    held.resolve()
    await first
    await queued
    expect(semaphore.active).toBe(0)
  })

  it('a vaga volta mesmo quando o trabalho falha', async () => {
    // Sem isto, um único erro reduziria o teto para sempre — e o serviço
    // pararia de aceitar trabalho sem nenhum sinal de que parou.
    const semaphore = new Semaphore(1, 0)
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(semaphore.active).toBe(0)
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('recusa configuração sem sentido em vez de fingir um teto', () => {
    expect(() => new Semaphore(0, 1)).toThrow('INVALID_SEMAPHORE_LIMIT')
    expect(() => new Semaphore(1.5, 1)).toThrow('INVALID_SEMAPHORE_LIMIT')
    expect(() => new Semaphore(1, -1)).toThrow('INVALID_SEMAPHORE_QUEUE_LIMIT')
  })
})
