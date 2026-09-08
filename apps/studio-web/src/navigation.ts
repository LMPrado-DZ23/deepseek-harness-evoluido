import { ASSISTANT_PATH } from './assistant/AssistantEntry'
import { HUB_PATH } from './hub/presentation'
import assistant from './i18n/assistant.pt-BR.json'
import hub from './i18n/hub.pt-BR.json'
import t from './i18n/pt-BR.json'

/** Identificador do painel de navegação, usado por `aria-controls` no botão do menu. */
export const NAV_MENU_ID = 'studio-nav'

/** Caminho da tela inicial do Studio. */
export const STUDIO_HOME_PATH = '/studio/'

export type StudioNavItem = {
  readonly id: 'home' | 'assistant' | 'hub' | 'projects' | 'progress' | 'result'
  readonly label: string
  /**
   * `null` quando a tela ainda não existe. Um item sem destino é mostrado como
   * indisponível, e não como um botão que a pessoa aperta e nada acontece: essa
   * era exatamente a queixa - quatro botões mudos na barra lateral.
   */
  readonly href: string | null
}

/**
 * Os itens da navegação, na ordem em que aparecem.
 *
 * A lista é a mesma no computador e no celular de propósito: quando ela existia
 * só na barra lateral, abaixo de 820px o produto ficava sem navegação nenhuma e
 * a tela de confirmações só era alcançável digitando o endereço.
 * @returns os itens, com destino real ou `null` para o que ainda não existe.
 */
export function studioNavItems(): readonly StudioNavItem[] {
  return [
    { id: 'home', label: t.nav.home, href: STUDIO_HOME_PATH },
    { id: 'assistant', label: assistant.navLabel, href: ASSISTANT_PATH },
    { id: 'hub', label: hub.navLabel, href: HUB_PATH },
    { id: 'projects', label: t.nav.projects, href: null },
    { id: 'progress', label: t.nav.progress, href: null },
    { id: 'result', label: t.nav.result, href: null },
  ]
}

/**
 * Qual item corresponde ao endereço aberto.
 * @param pathname - o caminho atual do navegador.
 * @returns o id do item, ou `null` quando o endereço não é uma tela da lista.
 */
export function activeNavId(pathname: string): StudioNavItem['id'] | null {
  for (const item of studioNavItems()) {
    if (item.href !== null && item.href !== STUDIO_HOME_PATH && pathname.startsWith(item.href)) return item.id
  }
  if (pathname === STUDIO_HOME_PATH || pathname === '/studio') return 'home'
  return null
}
