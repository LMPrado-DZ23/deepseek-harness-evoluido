import { createServer, request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { cabecalhosParaOHarness, destinoDoConvite, iniciarBorda, rotaDaBorda, segredoValido } from './preview-edge.mjs'

const PREVIA = `p-${'a1'.repeat(12)}.dz23.localhost`
const SEGREDO = 's'.repeat(40)

describe('rotaDaBorda: só dois hosts, e só na porta da borda', () => {
  it('o Studio segue com o mesmo caminho', () => {
    expect(rotaDaBorda('studio.dz23.localhost:8088', '/studio/?x=1', 8088)).toEqual({ destino: 'studio', caminho: '/studio/?x=1' })
    expect(rotaDaBorda('STUDIO.dz23.localhost:8088', '/', 8088)).toEqual({ destino: 'studio', caminho: '/' })
  })

  it('a prévia vai para o portão, com o caminho prefixado', () => {
    expect(rotaDaBorda(`${PREVIA}:8088`, '/a?b=1', 8088)).toEqual({ destino: 'previa', caminho: '/__dz23/preview-gateway/a?b=1' })
  })

  it.each([
    ['localhost:8088', '/'], ['127.0.0.1:8088', '/'], ['evil.example:8088', '/'],
    [`p-${'a'.repeat(23)}.dz23.localhost:8088`, '/'], [`p-${'A1'.repeat(12)}x.dz23.localhost:8088`, '/'],
    ['studio.dz23.localhost:9999', '/'], ['studio.dz23.localhost:8088', 'http://outro/'], [undefined, '/'],
    [`${PREVIA}.evil.example:8088`, '/'], ['studio.dz23.localhost:8088@x', '/'],
  ])('recusa %s %s', (host, url) => {
    expect(rotaDaBorda(host, url, 8088)).toEqual({ destino: 'recusar' })
  })
})

describe('cabecalhosParaOHarness', () => {
  const cliente = { host: 'h', 'x-dz23-edge': 'forjado', authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4', cookie: 'a=1' }

  it('o cliente nunca manda o cabeçalho de borda para o Studio', () => {
    const saida = cabecalhosParaOHarness('studio', cliente, SEGREDO)
    expect(saida['x-dz23-edge']).toBeUndefined()
    expect(saida.cookie).toBe('a=1')
  })

  it('a prévia recebe o segredo da borda, e não o do cliente, sem credenciais nem encaminhamentos', () => {
    const saida = cabecalhosParaOHarness('previa', cliente, SEGREDO)
    expect(saida['x-dz23-edge']).toBe(SEGREDO)
    expect(saida.authorization).toBeUndefined()
    expect(saida['x-forwarded-for']).toBeUndefined()
  })
})

describe('segredoValido', () => {
  it('confere o tamanho como o harness confere', () => {
    expect(() => segredoValido(undefined)).toThrow()
    expect(() => segredoValido('curto')).toThrow()
    expect(() => segredoValido('x'.repeat(513))).toThrow()
    expect(segredoValido(`${SEGREDO}\n`)).toBe(SEGREDO)
  })
})

describe('a borda de verdade, contra um harness de mentira', () => {
  const abertos = []
  afterEach(async () => { await Promise.all(abertos.splice(0).map(s => new Promise(r => { s.close(() => { r() }) }))) })

  async function montar() {
    const vistos = []
    const harness = createServer((pedido, resposta) => { vistos.push({ url: pedido.url, edge: pedido.headers['x-dz23-edge'], host: pedido.headers.host }); resposta.end('ok') })
    await new Promise(r => { harness.listen(0, '127.0.0.1', r) }); abertos.push(harness)
    const borda = await iniciarBorda({ porta: 0, harnessHost: '127.0.0.1', harnessPorta: harness.address().port, segredo: SEGREDO })
    abertos.push(borda)
    return { vistos, porta: borda.address().port }
  }

  function pedir(porta, host, caminho) {
    return new Promise((resolver, rejeitar) => {
      const r = request({ host: '127.0.0.1', port: porta, path: caminho, headers: { host, 'x-dz23-edge': 'forjado' } }, resposta => {
        let corpo = ''; resposta.on('data', c => { corpo += c }); resposta.on('end', () => { resolver({ status: resposta.statusCode, corpo }) })
      })
      r.on('error', rejeitar); r.end()
    })
  }

  it('escuta só no loopback', async () => {
    const borda = await iniciarBorda({ porta: 0, harnessHost: '127.0.0.1', harnessPorta: 1, segredo: SEGREDO })
    abertos.push(borda)
    expect(borda.address().address).toBe('127.0.0.1')
  })

  it('leva a prévia ao portão com o segredo, e o Studio sem ele; recusa o resto', async () => {
    const { vistos, porta } = await montar()
    // A porta real é aleatória; a rota confere a porta do Host contra a da borda.
    expect((await pedir(porta, `${PREVIA}:${porta}`, '/app')).status).toBe(200)
    expect((await pedir(porta, `studio.dz23.localhost:${porta}`, '/studio/')).status).toBe(200)
    expect((await pedir(porta, `localhost:${porta}`, '/')).status).toBe(421)
    expect(vistos).toEqual([
      { url: '/__dz23/preview-gateway/app', edge: SEGREDO, host: `${PREVIA}:${porta}` },
      { url: '/studio/', edge: undefined, host: `studio.dz23.localhost:${porta}` },
    ])
  })
})

describe('o convite leva ao FRIGG, e não à tela do harness', () => {
  it('só o redirecionamento do convite, só no Studio', () => {
    expect(destinoDoConvite('studio', '/?token=abc', 302, '/')).toBe('/studio/')
    expect(destinoDoConvite('studio', '/?token=abc', 200, '/')).toBeUndefined()
    expect(destinoDoConvite('studio', '/?token=abc', 302, '/outro')).toBeUndefined()
    expect(destinoDoConvite('studio', '/', 302, '/')).toBeUndefined()
    expect(destinoDoConvite('studio', '/x?token=a', 302, '/')).toBeUndefined()
    expect(destinoDoConvite('previa', '/?token=abc', 302, '/')).toBeUndefined()
  })

  it('a borda troca o Location do convite de verdade', async () => {
    const harness = createServer((pedido, resposta) => {
      resposta.writeHead(302, { location: '/', 'set-cookie': 'dsh-auth-x=1' }); resposta.end()
    })
    await new Promise(resolver => harness.listen(0, '127.0.0.1', resolver))
    const borda = await iniciarBorda({ porta: 0, harnessHost: '127.0.0.1', harnessPorta: harness.address().port, segredo: SEGREDO })
    try {
      const porta = borda.address().port
      const resposta = await new Promise((resolver, rejeitar) => {
        const pedido = request({ host: '127.0.0.1', port: porta, path: '/?token=abc', headers: { host: `studio.dz23.localhost:${porta}` } }, resolver)
        pedido.on('error', rejeitar); pedido.end()
      })
      expect(resposta.statusCode).toBe(302)
      expect(resposta.headers.location).toBe('/studio/')
      expect(resposta.headers['set-cookie']).toEqual(['dsh-auth-x=1'])
      resposta.resume()
    } finally {
      await new Promise(resolver => borda.close(resolver)); await new Promise(resolver => harness.close(resolver))
    }
  })
})
