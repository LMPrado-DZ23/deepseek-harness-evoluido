import { describe, expect, it } from 'vitest'
import {
  CRITERION_STATES, MISSION_STATUSES, STUDIO_MISSIONS_LOGICAL_DOMAIN, STUDIO_MISSIONS_PHYSICAL_DOMAIN,
  studioMissionsDomainSpec,
} from '../src/model.ts'

describe('o dominio fisico da missao', () => {
  it('o nome fisico obedece a gramatica do seam de armazenamento', () => {
    // `^[a-z][a-z0-9_]*$` e o que o `storage-domain` do Harness aceita; o nome
    // logico com pontos e o que aparece para gente. A ADR-001 registra os dois.
    expect(STUDIO_MISSIONS_PHYSICAL_DOMAIN).toBe('studio_missions')
    expect(STUDIO_MISSIONS_PHYSICAL_DOMAIN).toMatch(/^[a-z][a-z0-9_]*$/u)
    expect(STUDIO_MISSIONS_LOGICAL_DOMAIN).toBe('studio.missions')
  })

  it('a versao e 1 e a tabela e uma so', () => {
    // Subir versao sem passo de migracao faz `open()` falhar com
    // `version-mismatch` em instalacao que ja rodou.
    expect(studioMissionsDomainSpec.version).toBe(1)
    expect(Object.keys(studioMissionsDomainSpec.tables)).toEqual(['missions'])
  })

  it('as listas de estado sao fechadas', () => {
    expect([...CRITERION_STATES]).toEqual(['UNPROVEN', 'PROVEN', 'REFUTED', 'BLOCKED_EXTERNAL'])
    // `ABANDONED` saiu: nenhum metodo o produzia e duas conferencias o tratavam
    // como terminal — um estado que a tela precisava saber desenhar e que nada
    // podia alcancar.
    expect([...MISSION_STATUSES]).toEqual(['RUNNING', 'CANDIDATE_COMPLETED', 'COMPLETED'])
  })
})
