import { describe, expect, it } from 'vitest'
import { hubRepository } from '../src/index.ts'
import { TenantRecordHubRepository } from '../src/tenant-repository.ts'

/**
 * Onde o Hub guarda integrações, exportações e eventos.
 *
 * A escolha é de configuração, e o padrão NÃO pode mudar sozinho: trocá-lo
 * migraria dados de gente sem ninguém pedir, e a tela ficaria vazia num Studio
 * que já rodou.
 */
const table = () => ({ entries: () => [] as never[], put: async () => undefined, delete: async () => undefined }) as never
const domain = { table } as never
const switchDomain = { table } as never

describe('onde o Hub guarda os registros', () => {
  it('o padrão continua sendo a chave-valor', () => {
    expect(hubRepository({ get: () => undefined }, {}, domain, switchDomain))
      .not.toBeInstanceOf(TenantRecordHubRepository)
    expect(hubRepository({ get: () => undefined }, { storageAuthority: 'kv' }, domain, switchDomain))
      .not.toBeInstanceOf(TenantRecordHubRepository)
  })

  it('pedir RLS sem o armazenamento por inquilino FALHA ALTO', () => {
    // Cair de volta para a chave-valor em silêncio seria o pior desfecho: quem
    // pediu RLS acharia que tem isolamento no banco, e a instalação continuaria
    // escrevendo na unidade opaca.
    expect(() => hubRepository({ get: () => undefined }, { storageAuthority: 'rls' }, domain, switchDomain))
      .toThrow('HUB_TENANT_STORAGE_UNAVAILABLE')
  })

  it('com o armazenamento montado, RLS é usado', () => {
    const records = { list: async () => [], get: async () => undefined, put: async () => undefined, delete: async () => true }
    const repository = hubRepository(
      { get: (key: string) => (key === 'studioTenantStorage' ? { records } : undefined) } as never,
      { storageAuthority: 'rls' }, domain, switchDomain,
    )
    expect(repository).toBeInstanceOf(TenantRecordHubRepository)
  })

  it('mesmo em RLS, os desligamentos por alcance continuam na chave-valor', async () => {
    // Eles são de OUTRO domínio e são lidos em guarda de caminho quente: trocá-los
    // por leitura de banco é mudança de desenho da guarda, não migração.
    const records = { list: async () => [], get: async () => undefined, put: async () => undefined, delete: async () => true }
    const repository = hubRepository(
      { get: (key: string) => (key === 'studioTenantStorage' ? { records } : undefined) } as never,
      { storageAuthority: 'rls' }, domain, switchDomain,
    )
    expect(repository.killSwitch('sw-1')).toBeUndefined()
    expect(repository.killSwitches('org-1')).toEqual([])
  })
})
