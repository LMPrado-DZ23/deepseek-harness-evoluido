import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StudioIdentityService } from '../src/service.js'

/*
  UMA lista de hosts confiáveis.

  Medido em 19/09/2026: abrir o FRIGG pelo host da prévia passou na identidade
  e bateu em "Host não autorizado" nos apps, no hub, no espaço e na missão —
  cada plugin tinha a sua cópia de "127.0.0.1:porta e localhost:porta", e a da
  missão nem aceitava configuração.
*/
describe('confiancaPara', () => {
  const servico = () => new StudioIdentityService({ repository: {}, rpName: 'FRIGG', rpId: 'localhost', expectedOrigin: 'http://localhost', defaultOrgId: 'o', defaultTenantId: 't', enrollment: 'open' } as never)

  it('sem nada declarado, o loopback da porta', () => {
    expect(servico().confiancaPara(3080)).toEqual({
      allowedHosts: ['127.0.0.1:3080', 'localhost:3080'],
      allowedOrigins: ['http://localhost:3080', 'http://127.0.0.1:3080'],
    })
  })

  it('a lista da identidade vale para quem não tem a própria', () => {
    const s = servico()
    s.setRequestTrust({ allowedHosts: ['a:1', 'studio.dz23.localhost:8088'], allowedOrigins: ['http://studio.dz23.localhost:8088'] })
    expect(s.confiancaPara(3080)).toEqual({ allowedHosts: ['a:1', 'studio.dz23.localhost:8088'], allowedOrigins: ['http://studio.dz23.localhost:8088'] })
  })

  it('a própria do plugin vence, campo a campo', () => {
    const s = servico()
    s.setRequestTrust({ allowedHosts: ['a:1'], allowedOrigins: ['http://a:1'] })
    expect(s.confiancaPara(3080, { allowedHosts: ['b:2'] })).toEqual({ allowedHosts: ['b:2'], allowedOrigins: ['http://a:1'] })
  })
})

describe('nenhum outro plugin escreve a própria lista de loopback', () => {
  const raiz = resolve(__dirname, '../..')
  const plugins = readdirSync(raiz).filter(nome => nome !== 'identity')
  it.each(plugins)('%s', plugin => {
    let texto = ''
    try { texto = readFileSync(resolve(raiz, plugin, 'src/index.ts'), 'utf8') } catch { return }
    expect(texto).not.toMatch(/allowedHosts:?\s*(?:config\.allowedHosts\s*\?\?\s*)?\[\s*defaultHost/u)
    expect(texto).not.toMatch(/allowedHosts\s*=\s*config\.allowedHosts\s*\?\?\s*\[/u)
  })
})
