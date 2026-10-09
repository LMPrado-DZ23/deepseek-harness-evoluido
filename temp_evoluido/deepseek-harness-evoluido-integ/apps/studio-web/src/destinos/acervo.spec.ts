import { describe, expect, it } from 'vitest'
import { PACOTES_POR_GRUPO, acervoPorTarefa, type ItemDoAcervo } from './acervo'

function item(projectId: string, exportId: string, created_at: string, nome = `Tarefa ${projectId}`): ItemDoAcervo {
  return {
    registro: {
      export_id: exportId, project_id: projectId, run_id: 'r', file_name: `${exportId}.zip`,
      sha256: 'a'.repeat(64), size_bytes: 10, entries: 1, created_at,
    },
    projeto: { project_id: projectId, name: nome, state: 'VERIFIED_PROTOTYPE' },
  }
}

describe('o acervo agrupado por tarefa', () => {
  it('agrupa os pacotes pela tarefa que os produziu', () => {
    const grupos = acervoPorTarefa([
      item('p1', 'e1', '2026-09-17T10:00:00.000Z'),
      item('p2', 'e2', '2026-09-17T11:00:00.000Z'),
      item('p1', 'e3', '2026-09-17T12:00:00.000Z'),
    ])
    expect(grupos).toHaveLength(2)
    expect(grupos.find(grupo => grupo.projectId === 'p1')!.itens).toHaveLength(2)
  })

  it('o grupo mais RECENTE vem primeiro — quem abre procura o que acabou de sair', () => {
    const grupos = acervoPorTarefa([
      item('antiga', 'e1', '2026-09-01T10:00:00.000Z'),
      item('nova', 'e2', '2026-09-17T10:00:00.000Z'),
    ])
    expect(grupos.map(grupo => grupo.projectId)).toEqual(['nova', 'antiga'])
  })

  it('dentro do grupo, o pacote mais recente primeiro', () => {
    const grupos = acervoPorTarefa([
      item('p1', 'velho', '2026-09-01T10:00:00.000Z'),
      item('p1', 'novo', '2026-09-17T10:00:00.000Z'),
    ])
    expect(grupos[0]!.itens.map(entrada => entrada.registro.export_id)).toEqual(['novo', 'velho'])
  })

  it('o instante do grupo é o do pacote mais recente DELE', () => {
    const grupos = acervoPorTarefa([
      item('p1', 'velho', '2026-09-01T10:00:00.000Z'),
      item('p1', 'novo', '2026-09-17T10:00:00.000Z'),
    ])
    expect(grupos[0]!.maisRecente).toBe('2026-09-17T10:00:00.000Z')
  })

  it('corta por grupo e DIZ quantos sobraram', () => {
    const muitos = Array.from({ length: PACOTES_POR_GRUPO + 3 }, (_, indice) =>
      item('p1', `e${indice}`, `2026-09-0${String(indice % 9 + 1)}T10:00:00.000Z`))
    const grupo = acervoPorTarefa(muitos)[0]!
    expect(grupo.itens).toHaveLength(PACOTES_POR_GRUPO)
    expect(grupo.restantes).toBe(3)
  })

  it('tarefa sem nome mostra o identificador, e não uma linha vazia', () => {
    expect(acervoPorTarefa([item('p1', 'e1', '2026-09-17T10:00:00.000Z', '   ')])[0]!.nome).toBe('p1')
  })

  it('acervo vazio é acervo vazio', () => {
    expect(acervoPorTarefa([])).toEqual([])
  })
})
