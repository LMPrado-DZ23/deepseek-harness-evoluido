import { describe, expect, it } from 'vitest'
import { DomainMissionRepository, missionRepository } from '../src/index.ts'
import { TenantRecordMissionRepository } from '../src/tenant-repository.ts'

const domain = { table: () => ({ entries: () => [], get: () => undefined, put: async () => undefined }) } as never

describe('onde a autoridade guarda as missões', () => {
  it('o padrão continua sendo a chave-valor', () => {
    // Trocar isto sozinho migraria dados de gente sem ninguém pedir.
    expect(missionRepository({ get: () => undefined }, {}, domain)).toBeInstanceOf(DomainMissionRepository)
    expect(missionRepository({ get: () => undefined }, { storageAuthority: 'kv' }, domain))
      .toBeInstanceOf(DomainMissionRepository)
  })

  it('pedir RLS sem o armazenamento por inquilino FALHA ALTO', () => {
    // Cair de volta para a chave-valor em silêncio seria o pior desfecho: quem
    // pediu isolamento no banco acharia que o tem.
    expect(() => missionRepository({ get: () => undefined }, { storageAuthority: 'rls' }, domain))
      .toThrow('MISSION_TENANT_STORAGE_UNAVAILABLE')
  })

  it('com o armazenamento montado, RLS é usado', () => {
    const records = { list: async () => [], get: async () => undefined, put: async () => undefined }
    const repository = missionRepository(
      { get: (key: string) => (key === 'studioTenantStorage' ? { records } : undefined) } as never,
      { storageAuthority: 'rls' }, domain,
    )
    expect(repository).toBeInstanceOf(TenantRecordMissionRepository)
  })
})
