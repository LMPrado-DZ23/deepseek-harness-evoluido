import { CircleHelp, FolderKanban, Home, LineChart, MessageCircle, Plug, Target, X } from 'lucide-react'
import type { ReactNode } from 'react'
import t from './i18n/pt-BR.json'
import { NAV_MENU_ID, studioNavItems, type StudioNavItem } from './navigation'

const icons: Readonly<Record<StudioNavItem['id'], ReactNode>> = {
  home: <Home aria-hidden="true" />,
  assistant: <MessageCircle aria-hidden="true" />,
  hub: <Plug aria-hidden="true" />,
  projects: <FolderKanban aria-hidden="true" />,
  progress: <LineChart aria-hidden="true" />,
  mission: <Target aria-hidden="true" />,
  help: <CircleHelp aria-hidden="true" />,
}

export type StudioSidebarProps = {
  /** Qual item corresponde à tela aberta. */
  readonly active: StudioNavItem['id'] | null
  /** No celular a barra vira gaveta: só aparece quando a pessoa abre o menu. */
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * A navegação do Studio, a mesma no computador e no celular.
 *
 * Todo item leva a uma tela que existe: não há mais item desabilitado nem
 * etiqueta "em breve". A gaveta tem um botão de fechar visível — fechar só por
 * gesto deixaria a pessoa presa quando o toque fora não funciona.
 * @param props - item ativo e estado da gaveta.
 * @returns a barra lateral.
 */
export function StudioSidebar(props: StudioSidebarProps) {
  return <aside id={NAV_MENU_ID} className={props.open ? 'sidebar open' : 'sidebar'}>
    <div className="sidebar-head">
      <img src="/studio/brand/dz23-studio-logo.jpg" alt={t.brand} className="brand" />
      <button type="button" className="drawer-close" aria-label={t.mobile.close} onClick={props.onClose}><X aria-hidden="true" /></button>
    </div>
    <nav aria-label={t.nav.menuLabel}>
      {/* Todo item é um LINK, porque todo item tem destino. O ramo do item
          desabilitado saiu daqui junto com o último `href: null`. */}
      {studioNavItems().map(item => <a key={item.id} className={props.active === item.id ? 'nav active' : 'nav'} href={item.href} {...(props.active === item.id ? { 'aria-current': 'page' as const } : {})}>{icons[item.id]}<span>{item.label}</span></a>)}
    </nav>
    {/* A ajuda saiu daqui e virou item da LISTA, com rótulo: um ícone mudo no
        rodapé é a última coisa que quem não programa procura com dúvida.
        O rodapé inteiro saiu junto: ele tinha uma engrenagem DESABILITADA
        anunciando "em breve" para uma tela de configurações que não existe.
        Um botão morto não é uma promessa simpática — é a interface admitindo
        que está inacabada, toda vez que a pessoa abre o menu. */}
  </aside>
}
