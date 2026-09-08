import { CircleHelp, Eye, FolderKanban, Home, LineChart, MessageCircle, Plug, Settings, X } from 'lucide-react'
import type { ReactNode } from 'react'
import t from './i18n/pt-BR.json'
import { NAV_MENU_ID, studioNavItems, type StudioNavItem } from './navigation'

const icons: Readonly<Record<StudioNavItem['id'], ReactNode>> = {
  home: <Home aria-hidden="true" />,
  assistant: <MessageCircle aria-hidden="true" />,
  hub: <Plug aria-hidden="true" />,
  projects: <FolderKanban aria-hidden="true" />,
  progress: <LineChart aria-hidden="true" />,
  result: <Eye aria-hidden="true" />,
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
 * Um item sem destino aparece como indisponível em vez de virar botão mudo, e a
 * gaveta tem um botão de fechar visível: fechar só por gesto deixaria a pessoa
 * presa quando o toque fora não funciona.
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
      {studioNavItems().map(item => item.href === null
        ? <span key={item.id} className="nav unavailable" aria-disabled="true">{icons[item.id]}<span>{item.label}</span><small>{t.nav.soon}</small></span>
        : <a key={item.id} className={props.active === item.id ? 'nav active' : 'nav'} href={item.href} {...(props.active === item.id ? { 'aria-current': 'page' as const } : {})}>{icons[item.id]}<span>{item.label}</span></a>)}
    </nav>
    <div className="sidebar-footer">
      <span className="nav-icon-unavailable" aria-disabled="true" aria-label={`${t.nav.help} (${t.nav.soon})`}><CircleHelp aria-hidden="true" /></span>
      <span className="nav-icon-unavailable" aria-disabled="true" aria-label={`${t.nav.settings} (${t.nav.soon})`}><Settings aria-hidden="true" /></span>
    </div>
  </aside>
}
