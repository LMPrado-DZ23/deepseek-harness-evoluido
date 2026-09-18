import { projectAddress } from '../App'
import { STUDIO_HOME_PATH } from '../navigation'

/**
 * As tarefas recentes, como o trilho as mostra.
 *
 * Na referência, a lateral lista TAREFAS DE VERDADE — é por ali que se volta a
 * uma conversa. O trilho deste produto listava destinos e nada mais, e quem
 * queria retomar tinha de passar por "Meus projetos" e abrir a lista inteira.
 *
 * Esta é uma função pura porque a regra que importa é a de CORTE: quantas
 * cabem, em que ordem, e o que acontece quando duas têm o mesmo instante. Essa
 * decisão dentro de um JSX não é exercitada por teste nenhum — a lição que este
 * repositório já pagou mais de dez vezes.
 */
import type { Idioma } from '../i18n/idioma'

export interface TarefaDoServidor {
  readonly project_id: string
  readonly name: string
  readonly state: string
  readonly updated_at?: string
}

export interface TarefaDoTrilho {
  readonly id: string
  readonly nome: string
  readonly href: string
  readonly estado: string
  /** Se é a tarefa aberta agora. */
  readonly aberta: boolean
}

/**
 * Quantas tarefas cabem na lateral antes de ela virar rolagem infinita.
 *
 * A referência mostra meia dúzia. O número é de APRESENTAÇÃO: quem quer o
 * histórico inteiro tem "Meus projetos", e repetir a lista completa aqui faria
 * a lateral competir com a tela.
 */
export const TAREFAS_NO_TRILHO = 6

/**
 * As tarefas recentes, da mais recente para a mais antiga.
 *
 * @param tarefas - o que `GET /projects` devolveu.
 * @param abertaId - a tarefa aberta agora, quando há uma.
 * @param href - o endereço atual, para montar o link que preserva a tela.
 * @returns as tarefas a desenhar, já cortadas.
 */
export function tarefasDoTrilho(
  tarefas: readonly TarefaDoServidor[],
  abertaId: string | null,
  href: string,
): readonly TarefaDoTrilho[] {
  return [...tarefas]
    .sort((esquerda, direita) => {
      // Sem instante, a ordem de chegada decide. Inventar uma data para poder
      // ordenar faria a lista mudar de ordem a cada leitura, sem motivo
      // visível para quem olha.
      const porInstante = (direita.updated_at ?? '').localeCompare(esquerda.updated_at ?? '')
      return porInstante !== 0 ? porInstante : 0
    })
    .slice(0, TAREFAS_NO_TRILHO)
    .map(tarefa => ({
      id: tarefa.project_id,
      nome: tarefa.name.trim() === '' ? tarefa.project_id : tarefa.name,
      href: projectAddress(href, tarefa.project_id),
      estado: tarefa.state,
      aberta: tarefa.project_id === abertaId,
    }))
}

/** O endereço que abre uma tarefa nova — a home, que é onde se descreve o pedido. */
export const NOVA_TAREFA_HREF = STUDIO_HOME_PATH

/**
 * As iniciais de quem está usando, para o avatar do rodapé.
 *
 * Duas letras no máximo, e NUNCA uma inicial inventada: sem nome, o avatar
 * mostra um símbolo neutro em vez de uma letra que não é de ninguém.
 * @param nome - o nome ou endereço de quem está na sessão.
 * @param idioma - o idioma da interface, quando há um escolhido.
 * @returns as iniciais, ou `null` quando não há nome.
 */
export function iniciaisDaConta(nome: string | null | undefined, idioma: Idioma | undefined = undefined): string | null {
  if (nome === null || nome === undefined) return null
  const limpo = nome.trim()
  if (limpo === '') return null
  // Um e-mail vira a parte antes do `@`: "zodyprado@exemplo" não tem sobrenome,
  // e "ZE" (de zodyprado e exemplo) seria a inicial de um domínio.
  const base = limpo.includes('@') ? limpo.slice(0, limpo.indexOf('@')) : limpo
  const partes = base.split(/[\s._-]+/u).filter(parte => parte !== '')
  if (partes.length === 0) return null
  const primeira = partes[0]![0]!
  const segunda = partes.length > 1 ? partes.at(-1)![0]! : ''
  /*
    Maiúscula tem língua, e não é detalhe: em turco o `i` maiúsculo é `İ`, e em
    lituano um acento sobrevive à conversão. Escrever a etiqueta à mão aqui
    congelaria a regra do português para todo mundo. Sem idioma, `toUpperCase`
    usa a regra neutra, que é a resposta certa quando ninguém disse qual é a
    língua — e não a regra de uma língua escolhida por acidente.
  */
  return (primeira + segunda).toLocaleUpperCase(idioma)
}
