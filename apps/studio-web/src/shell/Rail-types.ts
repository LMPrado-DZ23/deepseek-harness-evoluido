import { AGENDADO_PATH, BIBLIOTECA_PATH, HABILIDADES_PATH, PLUGINS_PATH } from '../destinos/destinos'
import { EMPRESA_PATH } from '../empresa/empresaApi'
import { MISSION_PATH } from '../mission/missionApi'
import { PROJECTS_PATH } from '../projects/ProjectsScreen'
import { TEAM_PATH } from '../team/teamApi'
import { STUDIO_HOME_PATH } from '../navigation'
import railPadrao from '../i18n/rail.pt-BR.json'

export type CatalogoDoTrilho = typeof railPadrao

export const RAIL_ID = 'dz-rail'

export type RailIcone =
  | 'SquarePen' | 'Bot' | 'Zap' | 'Blocks' | 'FolderOpen'
  | 'ListChecks' | 'Target' | 'CircleHelp' | 'Clock' | 'Library' | 'Building2'

export interface RailItem {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly icone: RailIcone
}

export interface RailSecao {
  readonly id: 'acoes' | 'projetos' | 'tarefas'
  readonly titulo: string | null
  readonly itens: readonly RailItem[]
}

export function railSecoes(rail: CatalogoDoTrilho = railPadrao): readonly RailSecao[] {
  return [
    {
      id: 'acoes',
      titulo: null,
      itens: [
        { id: 'nova', label: rail.novaTarefa, href: STUDIO_HOME_PATH, icone: 'SquarePen' },
        { id: 'agente', label: rail.agente, href: '/studio/assistant', icone: 'Bot' },
        { id: 'habilidades', label: rail.habilidades, href: HABILIDADES_PATH, icone: 'Zap' },
        { id: 'plugins', label: rail.plugins, href: PLUGINS_PATH, icone: 'Blocks' },
        { id: 'agendado', label: rail.agendado, href: AGENDADO_PATH, icone: 'Clock' },
        { id: 'biblioteca', label: rail.biblioteca, href: BIBLIOTECA_PATH, icone: 'Library' },
        { id: 'empresas', label: rail.empresas, href: EMPRESA_PATH, icone: 'Building2' },
        { id: 'progresso', label: rail.trabalhoEmEquipe, href: TEAM_PATH, icone: 'ListChecks' },
        { id: 'objetivos', label: rail.objetivos, href: MISSION_PATH, icone: 'Target' },
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
      itens: [],
    },
  ]
}

export function railAtivo(pathname: string): string | null {
  for (const secao of railSecoes()) {
    for (const item of secao.itens) {
      if (item.href !== STUDIO_HOME_PATH && pathname.startsWith(item.href)) return item.id
    }
  }
  if (pathname === STUDIO_HOME_PATH || pathname === '/studio') return 'nova'
  return null
}

export function railItens(): readonly RailItem[] {
  return railSecoes().flatMap(secao => secao.itens)
}
