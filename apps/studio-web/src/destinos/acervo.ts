import type { ExportRecord, ProjectSummary } from '../hub/hubApi'

/**
 * O ACERVO agrupado POR TAREFA, como o quadro F14 mostra.
 *
 * A referência não lista pacotes soltos: ela agrupa por projeto, com o nome do
 * grupo e o instante mais recente dele à direita. A tela daqui listava tudo em
 * ordem e oferecia um seletor de tarefa — o que é a mesma informação com um
 * passo a mais e sem a hierarquia que faz a pessoa achar o que procura.
 *
 * Função pura pelo motivo de sempre: agrupar, ordenar e cortar é o que quebra
 * primeiro, e decisão dentro de um JSX não é exercitada por teste nenhum.
 */

export interface ItemDoAcervo {
  readonly registro: ExportRecord
  readonly projeto: ProjectSummary
}

export interface GrupoDoAcervo {
  readonly projectId: string
  readonly nome: string
  /** O instante do pacote mais recente do grupo. */
  readonly maisRecente: string
  readonly itens: readonly ItemDoAcervo[]
  /** Quantos ficaram de fora do corte deste grupo. */
  readonly restantes: number
}

/** Quantos pacotes um grupo mostra antes de oferecer o resto. */
export const PACOTES_POR_GRUPO = 6

/**
 * O acervo em grupos, do grupo mais recente para o mais antigo.
 *
 * Dentro de cada grupo, o pacote mais recente primeiro. O grupo é ordenado
 * pelo pacote mais recente DELE, e não pelo nome: quem abre a Biblioteca está
 * procurando o que acabou de sair.
 * @param itens - os pacotes com a tarefa de cada um.
 * @returns os grupos, já ordenados e cortados.
 */
export function acervoPorTarefa(itens: readonly ItemDoAcervo[]): readonly GrupoDoAcervo[] {
  const porTarefa = new Map<string, ItemDoAcervo[]>()
  for (const item of itens) {
    const atual = porTarefa.get(item.projeto.project_id)
    if (atual === undefined) porTarefa.set(item.projeto.project_id, [item])
    else atual.push(item)
  }
  return [...porTarefa.entries()]
    .map(([projectId, doGrupo]) => {
      const ordenados = [...doGrupo].sort((esquerda, direita) =>
        direita.registro.created_at.localeCompare(esquerda.registro.created_at))
      return {
        projectId,
        nome: ordenados[0]!.projeto.name.trim() === '' ? projectId : ordenados[0]!.projeto.name,
        maisRecente: ordenados[0]!.registro.created_at,
        itens: ordenados.slice(0, PACOTES_POR_GRUPO),
        restantes: Math.max(0, ordenados.length - PACOTES_POR_GRUPO),
      }
    })
    .sort((esquerda, direita) => direita.maisRecente.localeCompare(esquerda.maisRecente))
}
