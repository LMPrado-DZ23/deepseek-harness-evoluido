/**
 * A barra lateral do workspace aprovado — e por que ela não copia a imagem.
 *
 * A referência (`referencias/ref-home.png`) mostra oito linhas: Nova tarefa,
 * Agente, Habilidades, Plugins, Agendado, Biblioteca, Projetos e Tarefas. A
 * especificação que veio com ela, porém, tem uma seção inteira — "Elementos
 * ilustrativos que NÃO viram constantes" — cuja regra é: **sem cliques sem
 * resultado**. E a decisão do Prado repete: "a navegação leva a funcionalidades
 * reais".
 *
 * Então a ESTRUTURA é a da imagem — um trilho com ações no topo, uma seção de
 * projetos, uma seção de tarefas, conta no rodapé — e cada linha aponta para
 * uma tela que existe neste produto. Duas linhas da imagem não têm destino
 * real aqui e por isso NÃO estão nesta lista:
 *
 * - **Agendado**: o produto não tem agendamento de tarefa. Desenhar a linha e
 *   deixá-la muda é a etiqueta "em breve" que já foi removida uma vez deste
 *   arquivo, pelo motivo certo: um produto que anuncia o que não faz está
 *   dizendo que não está pronto.
 * - **Biblioteca**: não existe acervo. "Meus projetos" é o que a pessoa
 *   procura quando quer voltar a algo, e duplicá-lo com outro nome dá duas
 *   portas para a mesma sala.
 *
 * Quando as duas existirem, entram aqui — com destino, como todas as outras.
 */
import { ASSISTANT_PATH } from '../assistant/AssistantEntry'
import { HUB_PATH } from '../hub/presentation'
import { HELP_PATH } from '../help/HelpScreen'
import { MISSION_PATH } from '../mission/missionApi'
import { PROJECTS_PATH } from '../projects/ProjectsScreen'
import { TEAM_PATH } from '../team/teamApi'
import { STUDIO_HOME_PATH } from '../navigation'
import rail from '../i18n/rail.pt-BR.json'

/**
 * O identificador do painel de navegação, usado pelo `aria-controls` do botão
 * que o abre. Ele mora AQUI, e não escrito à mão nos dois arquivos: quando o
 * botão aponta para um `id` que não existe mais, nada quebra visivelmente — só
 * quem usa leitor de tela perde a ligação entre o botão e o que ele abre.
 */
export const RAIL_ID = 'dz-rail'

/** Os ícones vêm do conjunto que o produto já usa; o nome é o do `lucide-react`. */
export type RailIcone =
  | 'SquarePen' | 'Bot' | 'Zap' | 'Blocks' | 'FolderOpen'
  | 'ListChecks' | 'Target' | 'CircleHelp'

export interface RailItem {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly icone: RailIcone
}

export interface RailSecao {
  readonly id: 'acoes' | 'projetos' | 'tarefas'
  /** `null` na primeira seção: o trilho da referência não rotula o bloco do topo. */
  readonly titulo: string | null
  readonly itens: readonly RailItem[]
}

/**
 * As seções do trilho, na ordem da referência.
 * @returns as seções, com todos os destinos reais.
 */
export function railSecoes(): readonly RailSecao[] {
  return [
    {
      id: 'acoes',
      titulo: null,
      itens: [
        // "Nova tarefa" é a home: é onde se descreve o que se quer criar.
        { id: 'nova', label: rail.novaTarefa, href: STUDIO_HOME_PATH, icone: 'SquarePen' },
        { id: 'agente', label: rail.agente, href: ASSISTANT_PATH, icone: 'Bot' },
        // "Habilidades" e "Plugins" são a MESMA tela neste produto — o Hub
        // guarda as duas coisas. Uma linha só, com o nome que descreve as duas,
        // em vez de duas linhas que abrem a mesma página.
        { id: 'integracoes', label: rail.integracoes, href: HUB_PATH, icone: 'Blocks' },
      ],
    },
    {
      id: 'projetos',
      titulo: rail.projetos,
      itens: [
        { id: 'projetos', label: rail.meusProjetos, href: PROJECTS_PATH, icone: 'FolderOpen' },
      ],
    },
    {
      id: 'tarefas',
      titulo: rail.tarefas,
      itens: [
        { id: 'progresso', label: rail.trabalhoEmEquipe, href: TEAM_PATH, icone: 'ListChecks' },
        { id: 'objetivos', label: rail.objetivos, href: MISSION_PATH, icone: 'Target' },
        { id: 'ajuda', label: rail.ajuda, href: HELP_PATH, icone: 'CircleHelp' },
      ],
    },
  ]
}

/**
 * Qual item do trilho corresponde ao endereço aberto.
 *
 * A home é comparada por IGUALDADE e as outras por prefixo, na ordem em que
 * aparecem: `/studio/` é prefixo de todas as outras rotas, e compará-la por
 * prefixo marcaria "Nova tarefa" como ativa em toda tela do produto.
 * @param pathname - o caminho atual do navegador.
 * @returns o identificador do item ativo, ou `null` quando nenhum casa.
 */
export function railAtivo(pathname: string): string | null {
  for (const secao of railSecoes()) {
    for (const item of secao.itens) {
      if (item.href !== STUDIO_HOME_PATH && pathname.startsWith(item.href)) return item.id
    }
  }
  if (pathname === STUDIO_HOME_PATH || pathname === '/studio') return 'nova'
  return null
}

/**
 * Todos os itens, achatados — para quem precisa da lista e não das seções.
 * @returns os itens de todas as seções, na ordem.
 */
export function railItens(): readonly RailItem[] {
  return railSecoes().flatMap(secao => secao.itens)
}
