import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { OperacoesLongas, RespostaCapturada, pedidoRelido } from '../src/operacoes-longas.js'

const dono = { orgId: 'o', tenantId: 't', userId: 'u', projectId: 'p' }
const pausa = () => new Promise(resolve => { setImmediate(resolve) })

describe('OperacoesLongas', () => {
  it('em andamento, depois pronta com o status e o corpo do trabalho', async () => {
    const operacoes = new OperacoesLongas()
    let soltar!: () => void
    const id = operacoes.iniciar(dono, async () => { await new Promise<void>(resolve => { soltar = resolve }); return { status: 201, corpo: { ok: 1 } } })
    expect(operacoes.consultar(dono, id)).toEqual({ estado: 'EM_ANDAMENTO' })
    soltar(); await pausa()
    expect(operacoes.consultar(dono, id)).toEqual({ estado: 'PRONTA', status: 201, corpo: { ok: 1 } })
  })

  it('uma exceção inesperada vira 500, e não uma espera eterna', async () => {
    const operacoes = new OperacoesLongas()
    const id = operacoes.iniciar(dono, async () => { throw new Error('quebrou') })
    await pausa()
    expect(operacoes.consultar(dono, id)).toEqual({ estado: 'PRONTA', status: 500, corpo: { error: 'quebrou' } })
  })

  it.each([['orgId'], ['tenantId'], ['userId'], ['projectId']] as const)('outro %s não enxerga', async campo => {
    const operacoes = new OperacoesLongas()
    const id = operacoes.iniciar(dono, async () => ({ status: 200, corpo: null }))
    expect(operacoes.consultar({ ...dono, [campo]: 'outro' }, id)).toBeUndefined()
  })

  it('o resultado expira depois da validade; o que está em andamento não', async () => {
    let agora = 0
    const operacoes = new OperacoesLongas({ agora: () => agora, validadeMs: 1000 })
    const pronta = operacoes.iniciar(dono, async () => ({ status: 200, corpo: null }))
    const lenta = operacoes.iniciar(dono, () => new Promise(() => {}))
    await pausa()
    agora = 1001
    expect(operacoes.consultar(dono, pronta)).toBeUndefined()
    expect(operacoes.consultar(dono, lenta)).toEqual({ estado: 'EM_ANDAMENTO' })
  })

  it('tem teto', () => {
    const operacoes = new OperacoesLongas({ maximo: 1 })
    operacoes.iniciar(dono, () => new Promise(() => {}))
    expect(() => operacoes.iniciar(dono, () => new Promise(() => {}))).toThrow('OPERACOES_LONGAS_ESGOTADAS')
  })
})

describe('pedidoRelido e RespostaCapturada', () => {
  it('o corpo é lido inteiro e relido igual, com os mesmos cabeçalhos', async () => {
    const original = Object.assign(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]), { headers: { h: '1' }, method: 'POST', url: '/x' }) as unknown as IncomingMessage
    const relido = await pedidoRelido(original)
    let texto = ''
    for await (const pedaco of relido) texto += String(pedaco)
    expect(texto).toBe('{"a":1}')
    expect(relido.headers).toEqual({ h: '1' })
    expect(relido.method).toBe('POST')
  })

  it('a resposta capturada guarda status e JSON', () => {
    const r = new RespostaCapturada()
    r.writeHead(409); r.end('{"error":"x"}')
    expect(r.resultado()).toEqual({ status: 409, corpo: { error: 'x' } })
    expect(r.writableEnded).toBe(true)
  })
})
