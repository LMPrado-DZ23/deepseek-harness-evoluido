import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { destinoPermitido, HOSTS_PERMITIDOS } from './ponte-wsl.mjs'

describe('destinoPermitido', () => {
  it('só um host da lista, e só na porta 443', () => {
    expect(destinoPermitido('api.mistral.ai:443', HOSTS_PERMITIDOS)).toEqual({ host: 'api.mistral.ai', porta: 443 })
    expect(destinoPermitido('API.Mistral.AI:443', HOSTS_PERMITIDOS)).toEqual({ host: 'api.mistral.ai', porta: 443 })
    expect(destinoPermitido('api.mistral.ai:80', HOSTS_PERMITIDOS)).toBeUndefined()
    expect(destinoPermitido('example.com:443', HOSTS_PERMITIDOS)).toBeUndefined()
    expect(destinoPermitido('api.mistral.ai.example.com:443', HOSTS_PERMITIDOS)).toBeUndefined()
    expect(destinoPermitido('127.0.0.1:443', HOSTS_PERMITIDOS)).toBeUndefined()
    expect(destinoPermitido('api.mistral.ai:443\r\nX: y', HOSTS_PERMITIDOS)).toBeUndefined()
    expect(destinoPermitido(undefined, HOSTS_PERMITIDOS)).toBeUndefined()
  })
})

const PROXY = 28000 + Math.floor(Math.random() * 1000)
const AGENTE = PROXY + 1000
let processo

/** Uma linha de resposta do proxy a um pedido cru. */
function pedir(texto, porta = PROXY) {
  return new Promise((resolve, reject) => {
    const s = connect(porta, '127.0.0.1', () => s.write(texto))
    let r = ''
    s.on('data', d => { r += d.toString() }); s.on('close', () => resolve(r)); s.on('error', reject)
  })
}

describe('o lado WSL em execução', () => {
  beforeAll(async () => {
    processo = spawn(process.execPath, [fileURLToPath(new URL('./ponte-wsl.mjs', import.meta.url))], {
      env: { ...process.env, FRIGG_PONTE_PROXY: String(PROXY), FRIGG_PONTE_AGENTE: String(AGENTE), FRIGG_PONTE_TOKEN: 'x'.repeat(40) },
    })
    await new Promise(resolve => processo.stdout.once('data', resolve))
  })
  afterAll(() => { processo?.kill() })

  it('fora da lista recebe 403, e nada é pedido ao Windows', async () => {
    expect(await pedir('CONNECT example.com:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/u)
  })
  it('um pedido que não é CONNECT recebe 403', async () => {
    expect(await pedir('GET http://api.mistral.ai/ HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/u)
  })
  it('sem o agente do Windows ligado, a resposta é 503 e não um pendurado', async () => {
    expect(await pedir('CONNECT api.mistral.ai:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 503/u)
  })
  it('um agente com token errado é desligado na hora', async () => {
    expect(await pedir('CONTROLE errado\n', AGENTE)).toBe('')
    expect(await pedir('CONNECT api.mistral.ai:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 503/u)
  })
  it('com o agente certo, o pedido vira ABRIR no canal de controle', async () => {
    const controle = connect(AGENTE, '127.0.0.1', () => controle.write(`CONTROLE ${'x'.repeat(40)}\n`))
    const pedido = new Promise(resolve => controle.on('data', d => resolve(d.toString())))
    await new Promise(r => setTimeout(r, 100))
    const cliente = connect(PROXY, '127.0.0.1', () => cliente.write('CONNECT api.mistral.ai:443 HTTP/1.1\r\n\r\n'))
    expect(await pedido).toMatch(/^ABRIR [0-9a-f]{16} api\.mistral\.ai 443\n$/u)
    cliente.destroy(); controle.destroy()
  })
})

describe('o lado Windows confere a lista de novo', () => {
  it('um ABRIR para fora da lista não disca nada', async () => {
    const { createServer } = await import('node:net')
    const agente = 30500 + Math.floor(Math.random() * 400)
    let discou = false
    const alvo = createServer(s => { discou = true; s.destroy() })
    await new Promise(r => alvo.listen(0, '127.0.0.1', r))
    const portaAlvo = alvo.address().port
    const controle = createServer(s => s.once('data', () => s.write(`ABRIR abc 127.0.0.1 ${portaAlvo}\n`)))
    await new Promise(r => controle.listen(agente, '127.0.0.1', r))
    const win = spawn(process.execPath, [fileURLToPath(new URL('./ponte-windows.mjs', import.meta.url))], {
      env: { ...process.env, FRIGG_PONTE_AGENTE: String(agente), FRIGG_PONTE_TOKEN: 'y'.repeat(40) },
    })
    await new Promise(r => win.stdout.once('data', r))
    await new Promise(r => setTimeout(r, 400))
    win.kill(); controle.close(); alvo.close()
    expect(discou).toBe(false)
  })
})
