/**
 * A barra lateral do workspace aprovado — agora com os SEIS destinos.
 *
 * A versão anterior deste arquivo tinha três linhas e uma justificativa escrita
 * para as ausências: Agendado e Biblioteca não entravam porque "não existe
 * acervo" e "o produto não tem agendamento", e Habilidades e Plugins eram uma
 * linha só porque abriam a mesma tela. A decisão de produto
 * `DZ23-VISUAL-VIDEO-20260916-R1` respondeu às duas coisas:
 *
 * - "Ausência de função significa implementar e manter a pendência; não remover
 *   o requisito para chamar o visual de completo." Então Agendado tem destino
 *   real e a tela dele diz o que falta, sem botão mudo e sem lista encenada.
 * - "Biblioteca não é um apelido para Projetos." Ela lista os PACOTES que as
 *   tarefas produziram — o acervo existia, sem porta própria.
 * - "Habilidades e Plugins podem compartilhar componentes e serviços, mas
 *   precisam de vistas próprias úteis." Compartilham o Hub; mostram recortes
 *   que não se encontram.
 *
 * O princípio antigo continua valendo e não foi enfraquecido: cada linha leva a
 * uma tela que existe. O que mudou é que a resposta a "não existe" deixou de
 * ser apagar a linha e passou a ser construir o destino e declarar o que falta.
 */
import { ASSISTANT_PATH } from '../assistant/AssistantEntry'
import { AGENDADO_PATH, BIBLIOTECA_PATH, HABILIDADES_PATH, PLUGINS_PATH } from '../destinos/destinos'
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
  | 'ListChecks' | 'Target' | 'CircleHelp' | 'Clock' | 'Library'

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
        { id: 'habilidades', label: rail.habilidades, href: HABILIDADES_PATH, icone: 'Zap' },
        { id: 'plugins', label: rail.plugins, href: PLUGINS_PATH, icone: 'Blocks' },
        // Agendado leva a uma tela que diz que a função não existe ainda. Isso
        // não conta como capacidade entregue — `DISPONIBILIDADE` marca a
        // pendência onde um teste alcança.
        { id: 'agendado', label: rail.agendado, href: AGENDADO_PATH, icone: 'Clock' },
        { id: 'biblioteca', label: rail.biblioteca, href: BIBLIOTECA_PATH, icone: 'Library' },
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
