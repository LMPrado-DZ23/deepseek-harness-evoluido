import { describe, expect, it, vi } from 'vitest'
import { IdentityError } from '@dz23-studio/identity'
import { acessoDaInterface } from '../src/acesso.ts'

const pedido = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie }, method: 'GET' } as never)

/**
 * Um dublê de identidade com as duas respostas que importam.
 * @param options - se autentica por cookie, e se o modo pessoal está aberto.
 * @returns o dublê.
 */
function identidade(options: { readonly cookieVale: boolean; readonly pessoalAberto: boolean }) {
  return {
    cookiesAreSecure: false,
    assertRequestTrust: vi.fn(),
    validateCsrfToken: vi.fn(),
    authenticate: vi.fn(() => options.cookieVale
      ? Promise.resolve({ session_id: 's', user_id: 'u', org_id: 'o', tenant_id: 't' })
      : Promise.reject(new IdentityError('invalid', 'Entre para continuar.'))),
    personalPrincipal: vi.fn(() => options.pessoalAberto
      ? { userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', sessionId: 'session_local' }
      : undefined),
  } as never
}

describe('quem pode abrir a interface', () => {
  it('sem cookie, a instalacao PESSOAL abre', async () => {
    // O defeito medido: aqui vinha `401 Entre para continuar.` numa instalação
    // onde entrar não existe, porque não há ninguém para entrar como.
    await expect(acessoDaInterface(pedido(), identidade({ cookieVale: false, pessoalAberto: true }), '127.0.0.1'))
      .resolves.toBe('pessoal')
  })

  it('sem cookie e sem modo pessoal, a recusa CONTINUA', async () => {
    // Basta uma pessoa registrada, ou borda obrigatória, para `personalPrincipal`
    // devolver `undefined` — e a porta fecha, igual.
    await expect(acessoDaInterface(pedido(), identidade({ cookieVale: false, pessoalAberto: false }), '127.0.0.1'))
      .rejects.toBeInstanceOf(IdentityError)
  })

  it('com cookie valido, quem manda e o cookie', async () => {
    const servico = identidade({ cookieVale: true, pessoalAberto: true })
    await expect(acessoDaInterface(pedido('dz23_studio_session=abc'), servico, '127.0.0.1')).resolves.toBe('sessao')
    // A porta pessoal nem foi consultada: o cookie tem precedência.
    expect((servico as unknown as { personalPrincipal: { mock: { calls: unknown[] } } }).personalPrincipal.mock.calls).toHaveLength(0)
  })

  it('erro que NAO e de identidade continua subindo', async () => {
    // Tratar falha de leitura como "deve ser pessoal" transformaria um defeito
    // em uma autorização.
    const quebrado = {
      cookiesAreSecure: false,
      assertRequestTrust: vi.fn(),
      validateCsrfToken: vi.fn(),
      authenticate: vi.fn(() => Promise.reject(new TypeError('disco'))),
      personalPrincipal: vi.fn(() => ({ userId: 'u', orgId: 'o', tenantId: 't', sessionId: 's' })),
    } as never
    await expect(acessoDaInterface(pedido('dz23_studio_session=abc'), quebrado, '127.0.0.1')).rejects.toBeInstanceOf(TypeError)
  })

  it('erro ALHEIO que por acaso tem `code: invalid` tambem sobe', async () => {
    /*
      ESTE CASO NASCEU DE UMA SABOTAGEM QUE SOBREVIVEU.

      Tirar a conferência `instanceof IdentityError` não quebrava teste nenhum,
      porque a conferência seguinte (`code !== 'invalid'`) pegava o erro do
      outro caso. Só que `code` é um campo que MUITOS erros de Node carregam —
      basta um deles trazer `invalid` para a porta pessoal abrir por causa de um
      defeito de disco. A conferência de TIPO é o que impede isso.
    */
    const alheio = Object.assign(new Error('disco'), { code: 'invalid' })
    const quebrado = {
      cookiesAreSecure: false,
      assertRequestTrust: vi.fn(),
      validateCsrfToken: vi.fn(),
      authenticate: vi.fn(() => Promise.reject(alheio)),
      personalPrincipal: vi.fn(() => ({ userId: 'u', orgId: 'o', tenantId: 't', sessionId: 's' })),
    } as never
    await expect(acessoDaInterface(pedido('dz23_studio_session=abc'), quebrado, '127.0.0.1')).rejects.toBe(alheio)
  })

  it('o endereco vai ate a identidade, e nao e decidido aqui', async () => {
    const servico = identidade({ cookieVale: false, pessoalAberto: false })
    await expect(acessoDaInterface(pedido(), servico, '0.0.0.0')).rejects.toBeInstanceOf(IdentityError)
    expect((servico as unknown as { personalPrincipal: { mock: { calls: string[][] } } }).personalPrincipal.mock.calls[0])
      .toEqual(['0.0.0.0'])
  })
})
