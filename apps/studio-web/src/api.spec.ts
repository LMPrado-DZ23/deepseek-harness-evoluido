import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, esperarOperacao } from './api'

function armazenamento(): Storage {
  const dados = new Map<string, string>()
  return { getItem: k => dados.get(k) ?? null, setItem: (k, v) => { dados.set(k, v) }, removeItem: k => { dados.delete(k) }, clear: () => { dados.clear() }, key: () => null, get length() { return dados.size } }
}
beforeEach(() => { vi.stubGlobal('window', { sessionStorage: armazenamento() }) })
afterEach(() => { vi.unstubAllGlobals() })

const resposta = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

describe('a espera longa, do lado da tela', () => {
  it('um 202 com operação vira a resposta FINAL da rota, para quem chama api()', async () => {
    window.sessionStorage.setItem('dz23.studio.csrf.v1', 'csrf')
    const chamadas: { url: string; headers: Record<string, string> }[] = []
    const respostas = [resposta(202, { operacao_pendente: 'op-1' }), resposta(200, { estado: 'EM_ANDAMENTO' }), resposta(200, { estado: 'PRONTA', status: 201, corpo: { plan: { plan_id: 'p' } } })]
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => { chamadas.push({ url, headers: (init.headers ?? {}) as Record<string, string> }); return Promise.resolve(respostas.shift()!) }))
    vi.useFakeTimers()
    const promessa = api<{ plan: { plan_id: string } }>('/projects/proj-1/plan', { method: 'POST', body: '{}' })
    await vi.runAllTimersAsync()
    expect(await promessa).toEqual({ plan: { plan_id: 'p' } })
    vi.useRealTimers()
    expect(chamadas[0]!.headers['x-dz23-espera']).toBe('longa')
    expect(chamadas[1]!.url).toBe('/api/studio/apps/projects/proj-1/operation?id=op-1')
  })

  it('o erro da rota continua sendo erro', async () => {
    const respostas = [resposta(200, { estado: 'PRONTA', status: 409, corpo: { error: 'Plano já aprovado.' } })]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respostas.shift()!)))
    const final = await esperarOperacao('proj-1', 'op-1', () => Promise.resolve())
    expect(final.response.status).toBe(409)
    expect(final.body).toEqual({ error: 'Plano já aprovado.' })
  })

  it('operação que sumiu (FRIGG reiniciou) devolve o erro do servidor, e não espera para sempre', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(resposta(404, { error: 'Esta operação não existe mais.' }))))
    const final = await esperarOperacao('proj-1', 'op-1', () => Promise.resolve())
    expect(final.response.status).toBe(404)
    expect(final.body).toEqual({ error: 'Esta operação não existe mais.' })
  })

  it('GET não pede espera longa', async () => {
    const chamadas: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit = {}) => { chamadas.push((init.headers ?? {}) as Record<string, string>); return Promise.resolve(resposta(200, { ok: true })) }))
    await api('/projects/proj-1')
    expect(chamadas[0]!['x-dz23-espera']).toBeUndefined()
  })
})
